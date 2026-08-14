import { compareDecimal, divideDecimal, multiplyDecimal, parseDecimal, formatDecimal, roundToStep, subtractDecimal } from "../decimal.js";
import { BUY_ADMISSION_LEVERAGE, TRADE_FEE_RATE, adjustedEquity, assessLeverage, buySignal, candleFreshness } from "../domain/rules.js";
import { CLOCK_SYNC_STALE_AFTER_MS } from "../infrastructure/okx/rest-client.js";
import { createClOrdId, payloadHash } from "../domain/order.js";

const PRIORITY = { DELIST: 3, SELL: 2, BUY: 1 };
const terminal = new Set(["NOT_CREATED", "SETTLED"]);

function min(...values) { return values.reduce((lowest, value) => compareDecimal(value, lowest) < 0 ? value : lowest); }
function add(left, right) {
  const a = parseDecimal(left); const b = parseDecimal(right); const scale = Math.max(a.scale, b.scale);
  return formatDecimal(a.n * (10n ** BigInt(scale - a.scale)) + b.n * (10n ** BigInt(scale - b.scale)), scale);
}

/** The only component allowed to invoke an injected mutation transport. */
export class OrderCoordinator {
  constructor({ transaction, orders, state, transport, ownerGuard, readyGate, market, account, mode = () => "OFF", executionRoute = () => "margin", tradeQuoteCurrency = () => null, isBuyAllowed = () => true, clock = { nowMs: () => Date.now() }, config, telemetry = () => {}, onBuySettled = null, onExitSettled = null, slo = null }) {
    Object.assign(this, { transaction, orders, state, transport, ownerGuard, readyGate, market, account, mode, executionRoute, tradeQuoteCurrency, isBuyAllowed, clock, config, telemetry, onBuySettled, onExitSettled, slo });
    this.pending = { BUY: new Map(), SELL: new Map(), DELIST: new Map() }; this.submitting = false; this.accepting = true; this.isolatedBases = new Set();
  }
  enqueue(intent) { if (!this.accepting) return false; const group = this.pending[intent.intent]; if (!group) throw new Error("unknown intent"); const key = intent.intent === "BUY" ? intent.instId : `${intent.baseCcy}:${intent.sourceBuyTradeId}`; group.set(key, intent); return true; }
  stopNewMutations() { this.accepting = false; }
  async finishInFlight() { while (this.submitting) await new Promise((resolve) => setTimeout(resolve, 1)); }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* telemetry cannot block trading */ } }
  canCreateNextBuy({ previousAttempt, nextMarketKey }) {
    return ["SETTLED", "NOT_CREATED"].includes(previousAttempt?.state) && Boolean(nextMarketKey) && nextMarketKey !== previousAttempt.decision_market_key;
  }
  async drainOnce() {
    if (this.submitting) return { submitted: false, reason: "SLOT_BUSY" };
    const kind = ["DELIST", "SELL", "BUY"].find((name) => this.pending[name].size);
    if (!kind) return { submitted: false, reason: "EMPTY" };
    if (kind !== "BUY") {
      const candidates = [...this.pending[kind].values()]
        .sort((a, b) => a.baseCcy.localeCompare(b.baseCcy) || a.sellTime - b.sellTime || String(a.sourceBuyTradeId).localeCompare(String(b.sourceBuyTradeId)))
        .filter((item, index, rows) => index === 0 || item.baseCcy !== rows[index - 1].baseCcy).slice(0, 5);
      const prepared = await this.prepareExits(kind, candidates);
      if (!prepared.length) return { submitted: false, reason: "NO_ELIGIBLE" };
      if (kind !== "DELIST" && this.pending.DELIST.size) return { submitted: false, reason: "PREEMPTED" };
      this.submitting = true;
      try { return await this.submitExits(kind, prepared); } finally { this.submitting = false; }
    }
    const candidates = [...this.pending.BUY.values()].sort((a, b) => a.generation - b.generation || a.eligibleSince - b.eligibleSince || a.instId.localeCompare(b.instId)).slice(0, 5).map((intent) => { intent._signalStartedAt ??= Number.isFinite(intent.signalAt) ? intent.signalAt : this.clock.nowMs(); return intent; });
    const prepared = await this.prepareBuys(candidates);
    if (!prepared.length) return { submitted: false, reason: "NO_ELIGIBLE" };
    if (this.pending.DELIST.size || this.pending.SELL.size) return { submitted: false, reason: "PREEMPTED" };
    this.submitting = true;
    try { return await this.submitBuys(prepared); } finally { this.submitting = false; }
  }
  async prepareBuys(candidates) {
    const riskVersion = this.account.value?.version ?? 0;
    const eligible = candidates.filter((intent) => (!intent.waitForRiskVersion || riskVersion > intent.waitForRiskVersion) && this._buyGuard(intent).allowed);
    if (!eligible.length) return [];
    const maxAvailStarted = this.clock.nowMs();
    const routed = eligible.map((intent) => { const executionRoute = this._executionRoute(intent); return { intent, executionRoute, executionMode: executionRoute ? "cross" : null, tradeQuoteCcy: intent.tradeQuoteCcy ?? this.tradeQuoteCurrency(intent.instId) }; }).filter(({ intent, executionRoute, executionMode }) => {
      if (executionRoute && executionMode) return true;
      this._emit({ type: "buy_deferred", reason: "EXECUTION_ROUTE_UNAVAILABLE", instId: intent.instId }); return false;
    });
    const groups = Map.groupBy(routed, (row) => row.executionMode);
    const modeByInst = new Map(routed.map(({ intent, executionMode }) => [intent.instId, executionMode]));
    const routeByInst = new Map(routed.map(({ intent, executionRoute }) => [intent.instId, executionRoute]));
    const quoteByInst = new Map(routed.map(({ intent, tradeQuoteCcy }) => [intent.instId, tradeQuoteCcy]));
    const avail = (await Promise.all([...groups].map(([tdMode, rows]) => this.transport.maxAvailSize(rows.map(({ intent }) => intent.instId).join(","), { tdMode })))).flat(); this.slo?.record("signal_max_avail", maxAvailStarted);
    const byInst = new Map((avail ?? []).map((row) => [row.instId, row.availBuy]));
    return eligible.flatMap((intent) => {
      const availBuy = byInst.get(intent.instId);
      const available = availBuy && compareDecimal(availBuy, "0") > 0;
      if (!available) {
        intent.waitForRiskVersion = riskVersion;
        this._emit({ type: "buy_deferred", reason: "INSUFFICIENT_FUNDS_WAIT_RISK_VERSION", instId: intent.instId, riskVersion });
      }
      return available ? [{ ...intent, availBuy, executionMode: modeByInst.get(intent.instId), executionRoute: routeByInst.get(intent.instId), tradeQuoteCcy: quoteByInst.get(intent.instId) }] : [];
    });
  }
  async submitBuys(candidates) {
    const started = this.clock.nowMs();
    let prepared;
    try {
      prepared = await this.transaction(async (tx) => {
      const rows = [];
      for (const intent of candidates) {
        const guard = this._buyGuard(intent);
        if (!guard.allowed) continue;
        const { instrument, quote, candle } = guard;
        const executionPrice = roundToStep(intent.dailyLimitPrice, instrument.tickSz, "down");
        if (compareDecimal(quote.askPx, executionPrice) > 0) continue;
        const frozenTarget = intent.frozenTargetUsd ?? multiplyDecimal(BUY_ADMISSION_LEVERAGE, adjustedEquity(this.account.value));
        const remainingTarget = intent.remainingTargetUsd ?? frozenTarget;
        const maxNotional = min(remainingTarget, intent.availBuy, this._remainingCapacity(intent.managedExposure ?? "0"));
        const feeMultiplier = add("1", TRADE_FEE_RATE);
        const size = roundToStep(divideDecimal(maxNotional, multiplyDecimal(executionPrice, feeMultiplier)), instrument.lotSz, "down");
        if (compareDecimal(size, instrument.minSz) < 0) continue;
        const executionRoute = this._executionRoute(intent);
        const executionMode = executionRoute ? "cross" : null;
        if (!executionMode) continue;
        const tradeQuoteCcy = intent.tradeQuoteCcy ?? this.tradeQuoteCurrency(intent.instId);
        const payload = { instId: intent.instId, tdMode: executionMode, side: "buy", ordType: "ioc", px: executionPrice, sz: size, tag: this.config.strategyTag, ...(executionRoute === "margin" && tradeQuoteCcy ? { tradeQuoteCcy } : {}) };
        const tuple = { instId: intent.instId, strategyDay: intent.strategyDay, generation: intent.generation };
        const clOrdId = await createClOrdId(this.config.orderVersion, "BUY", tuple); payload.clOrdId = clOrdId;
        const hash = await payloadHash(payload); const marketKey = await payloadHash({ quote, candle });
        const attempt = {
          accountId: this.config.accountId, intent: "BUY", instId: intent.instId, baseCcy: instrument.base, clOrdId, payloadHash: hash,
          strategyDay: intent.strategyDay, generation: intent.generation, plannedSize: size, reservedExposureUsd: multiplyDecimal(multiplyDecimal(size, executionPrice), feeMultiplier),
          frozenTargetUsd: frozenTarget, decisionQuoteTs: quote.ts, decisionQuoteHash: await payloadHash(quote), decisionCandleTs: candle.ts, decisionCandleHash: await payloadHash(candle), decisionMarketKey: marketKey,
          executionLimitPrice: executionPrice, instrumentVersion: String(instrument.version ?? "1"), holdHours: intent.holdHours, strategyConfigHash: intent.configHash,
          admissionEquity: adjustedEquity(this.account.value), admissionExposure: intent.managedExposure ?? "0", accountSnapshotVersion: String(this.account.value.version), executionMode, executionRoute,
          decisionTriggerPrice: quote.last, decisionReferencePrice: guard.signal.breakoutPrice, decisionReason: "BUY_BREAKOUT_CONFIRMED",
        };
        try {
          const reserve = await this.orders.reserveBuy(tx, attempt, { managedExposure: intent.managedExposure ?? "0", maxExposure: multiplyDecimal(BUY_ADMISSION_LEVERAGE, attempt.admissionEquity) });
          if (reserve.authorized) rows.push({ intent, attempt, payload });
        } catch (error) {
          // A lost COMMIT acknowledgement is resolved by the deterministic business key.
          // Never turn that ambiguity into a second generation or a second HTTP submit.
          // PostgreSQL marks this transaction aborted on 23505. Preserve the business key,
          // let the wrapper roll back, then read it in a fresh transaction below.
          if (error?.code === "23505" && typeof this.orders.findByClOrdId === "function") {
            error.clOrdId = clOrdId; error.expectedPayloadHash = hash;
          }
          throw error;
        }
      }
      return rows;
      });
    } catch (error) {
      if (error?.code !== "23505" || !error.clOrdId || typeof this.orders.findByClOrdId !== "function") throw error;
      const existing = await this.transaction((tx) => this.orders.findByClOrdId(tx, error.clOrdId));
      if (!existing || (existing.payload_hash ?? existing.payloadHash) !== error.expectedPayloadHash) {
        this._emit({ type: "buy_replay", reason: "HASH_COLLISION", clOrdId: error.clOrdId });
        throw new Error("HASH_COLLISION");
      }
      this._emit({ type: "buy_replay", reason: "COMMIT_ACK_LOST", clOrdId: error.clOrdId, state: existing.state });
      return { submitted: false, reason: "COMMIT_ACK_LOST" };
    }
    if (!prepared.length) return { submitted: false, reason: "RESERVATION_DENIED" };
    for (const row of prepared) this._emit({ type: "order_lifecycle", reason: "BUY_PREPARED", intent: "BUY", instId: row.intent.instId, clOrdId: row.attempt.clOrdId, generation: row.intent.generation, limitPrice: row.attempt.executionLimitPrice, plannedSize: row.attempt.plannedSize, triggerPrice: row.attempt.decisionTriggerPrice, referencePrice: row.attempt.decisionReferencePrice });
    const safe = [];
    for (const row of prepared) {
      const guard = this._buyGuard(row.intent);
      if (!guard.allowed) await this.transaction((tx) => this.orders.markNotCreated(tx, row.attempt.clOrdId, guard.reason));
      else safe.push(row);
    }
    if (!safe.length) return { submitted: false, reason: "FINAL_GUARD" };
    let response;
    try {
      this.slo?.record("signal_post", Math.min(...safe.map((row) => row.intent._signalStartedAt))); this.slo?.record("prepared_post", started); this.slo?.record("prepared_submit", started); const submittedAt = this.clock.nowMs();
      response = await this.transport.submitBatchOrders(safe.map((row) => row.payload), this.clock.nowMs() + this.config.orderExpiryMs); this.slo?.record("submit_ack", submittedAt);
    } catch (error) {
      response = safe.map((row) => ({ clOrdId: row.attempt.clOrdId, status: "UNKNOWN", reason: error?.message ?? "TRANSPORT_FAILURE" }));
    }
    const byClOrdId = new Map((response ?? []).map((item) => [item.clOrdId, item]));
    response = safe.map((row) => byClOrdId.get(row.attempt.clOrdId) ?? ({ clOrdId: row.attempt.clOrdId, status: "UNKNOWN", reason: "MISSING_BATCH_ITEM" }));
    await this.transaction(async (tx) => {
      for (const item of response) {
        const result = item.status === "SUBMITTED" ? this.orders.markSubmitted(tx, item.clOrdId, item.ordId) : item.status === "NOT_CREATED" ? this.orders.markNotCreated(tx, item.clOrdId, item.reason) : this.orders.markUnknown(tx, item.clOrdId, item.reason);
        await result;
      }
    });
    for (const item of response) this._emit({ type: "order_lifecycle", reason: `BUY_${item.status}`, intent: "BUY", clOrdId: item.clOrdId, ordId: item.ordId, exchangeReason: item.reason });
    for (const row of safe) this.pending.BUY.delete(row.intent.instId);
    const unknown = response.filter((item) => item.status === "UNKNOWN").length; this.slo?.observe("unknown_count", unknown); this.slo?.increment?.("unknown_count", unknown); this.slo?.observe("batch_size", safe.length); this.slo?.observe("mutation_concurrency", 1); this._emit({ type: "buy_batch", count: safe.length, results: response.map((item) => ({ clOrdId: item.clOrdId, status: item.status })) });
    return { submitted: true, count: safe.length, response };
  }
  async prepareExits(kind, candidates) {
    const eligible = [];
    for (const intent of candidates) {
      const guard = this._exitGuard(intent, kind);
      if (guard.allowed) eligible.push(intent);
      else this._emit({ type: "exit_deferred", intent: kind, reason: guard.reason, baseCcy: intent.baseCcy, sourceBuyTradeId: intent.sourceBuyTradeId });
    }
    if (!eligible.length) return [];
    let available;
    try {
      const routed = eligible.map((intent) => ({ intent, executionRoute: this._executionRoute(intent), executionMode: this._executionMode(intent) })).filter((row) => row.executionRoute && row.executionMode);
      const groups = Map.groupBy(routed, (row) => `${row.executionMode}:${row.executionRoute}`);
      available = (await Promise.all([...groups].map(([, rows]) => { const { executionMode: tdMode, executionRoute } = rows[0]; return this.transport.maxAvailSize(rows.map(({ intent }) => intent.instId).join(","), tdMode === "cross" && executionRoute === "margin" ? { tdMode, reduceOnly: true } : { tdMode }); }))).flat();
    }
    catch (error) { this._emit({ type: "exit_deferred", intent: kind, reason: "MAX_AVAIL_FAILED", error: error?.message }); return []; }
    const byInst = new Map((available ?? []).map((row) => [row.instId, row.availSell]));
    const planned = [];
    for (const intent of eligible) {
      const instrument = this.market.instrument(intent.instId); const reduceOnly = byInst.get(intent.instId);
      const availableBase = intent.availableBase ?? reduceOnly;
      if (!instrument || !reduceOnly || !availableBase) continue;
      const raw = min(intent.remainingSize, availableBase ?? reduceOnly, reduceOnly);
      const size = roundToStep(raw, instrument.lotSz, "down");
      if (compareDecimal(size, instrument.minSz) < 0 || (intent.bidPx && compareDecimal(multiplyDecimal(size, intent.bidPx), "0.1") < 0)) {
        await this.transaction((tx) => this.state.markDust?.(tx, { ...intent, version: intent.fillVersion }));
        this._emit({ type: "exit_deferred", intent: kind, reason: "DUST", sourceBuyTradeId: intent.sourceBuyTradeId });
        continue;
      }
      if (compareDecimal(size, "0") <= 0) { this._emit({ type: "exit_deferred", intent: kind, reason: "BALANCE_SHORTFALL", sourceBuyTradeId: intent.sourceBuyTradeId }); continue; }
      planned.push({ ...intent, plannedSize: size });
    }
    return planned;
  }
  async submitExits(kind, candidates) {
    let prepared;
    try {
      prepared = await this.transaction(async (tx) => {
        const rows = [];
        for (const intent of candidates) {
          if (!this._exitGuard(intent, kind).allowed) continue;
          const instrument = this.market.instrument(intent.instId);
          const executionMode = this._executionMode(intent);
          const executionRoute = this._executionRoute(intent);
          const payload = { instId: intent.instId, tdMode: executionMode, side: "sell", ordType: "market", ...(executionMode === "cross" && executionRoute === "margin" ? { reduceOnly: true } : {}), sz: intent.plannedSize, tag: this.config.strategyTag };
          const tuple = { instId: intent.instId, tradeId: intent.sourceBuyTradeId, generation: intent.generation ?? 0, intent: kind };
          const clOrdId = await createClOrdId(this.config.orderVersion, kind, tuple); payload.clOrdId = clOrdId;
          const attempt = { accountId: this.config.accountId, intent: kind, instId: intent.instId, baseCcy: intent.baseCcy ?? instrument.base, clOrdId, payloadHash: await payloadHash(payload), sourceBuyTradeId: intent.sourceBuyTradeId, generation: intent.generation ?? 0, plannedSize: intent.plannedSize, reservedBaseSize: intent.plannedSize, executionMode, executionRoute, decisionTriggerPrice: intent.triggerPrice ?? this.market.ticker(intent.instId)?.last, decisionReferencePrice: intent.protection, decisionReason: kind === "DELIST" ? "DELIST_EXIT" : "SELL_BREAKDOWN_CONFIRMED" };
          const reserve = await this.orders.reserveExit(tx, attempt);
          if (reserve?.authorized !== false) rows.push({ intent, attempt, payload });
          else this._emit({ type: "exit_deferred", intent: kind, reason: reserve.reason, sourceBuyTradeId: intent.sourceBuyTradeId });
        }
        return rows;
      });
    } catch (error) {
      this._emit({ type: "exit_replay", intent: kind, reason: "DB_DURABILITY_BLOCKED", error: error?.message });
      return { submitted: false, reason: "DB_DURABILITY_BLOCKED" };
    }
    if (!prepared.length) return { submitted: false, reason: "RESERVATION_DENIED" };
    for (const row of prepared) this._emit({ type: "order_lifecycle", reason: `${kind}_PREPARED`, intent: kind, instId: row.intent.instId, clOrdId: row.attempt.clOrdId, plannedSize: row.attempt.plannedSize, triggerPrice: row.attempt.decisionTriggerPrice, referencePrice: row.attempt.decisionReferencePrice, sourceBuyTradeId: row.intent.sourceBuyTradeId });
    const safe = [];
    for (const row of prepared) {
      const guard = this._exitGuard(row.intent, kind);
      if (!guard.allowed) await this.transaction((tx) => this.orders.markNotCreated(tx, row.attempt.clOrdId, guard.reason));
      else safe.push(row);
    }
    if (!safe.length) return { submitted: false, reason: "FINAL_GUARD" };
    let response;
    try { response = await this.transport.submitBatchOrders(safe.map((row) => row.payload), this.clock.nowMs() + this.config.orderExpiryMs); }
    catch (error) { response = safe.map((row) => ({ clOrdId: row.attempt.clOrdId, status: "UNKNOWN", reason: error?.message ?? "TRANSPORT_FAILURE" })); }
    const byClOrdId = new Map((response ?? []).map((item) => [item.clOrdId, item]));
    response = safe.map((row) => byClOrdId.get(row.attempt.clOrdId) ?? ({ clOrdId: row.attempt.clOrdId, status: "UNKNOWN", reason: "MISSING_BATCH_ITEM" }));
    await this.transaction(async (tx) => {
      for (const item of response) await (item.status === "SUBMITTED" ? this.orders.markSubmitted(tx, item.clOrdId, item.ordId) : item.status === "NOT_CREATED" ? this.orders.markNotCreated(tx, item.clOrdId, item.reason) : this.orders.markUnknown(tx, item.clOrdId, item.reason));
    });
    for (const item of response) this._emit({ type: "order_lifecycle", reason: `${kind}_${item.status}`, intent: kind, clOrdId: item.clOrdId, ordId: item.ordId, exchangeReason: item.reason });
    for (const item of response) if (item.status !== "SUBMITTED") this._emit({ type: "exit_result", intent: kind, reason: item.status === "UNKNOWN" ? "EXIT_UNKNOWN" : "EXIT_NOT_CREATED", exchangeReason: item.reason, clOrdId: item.clOrdId });
    for (const row of safe) this.pending[kind].delete(`${row.intent.baseCcy}:${row.intent.sourceBuyTradeId}`);
    this._emit({ type: "exit_batch", intent: kind, count: safe.length, reason: "ORDER_SUBMITTED" });
    return { submitted: true, count: safe.length, response };
  }
  async settleExit({ attempt, fills, exchangeState, accFillSz }) {
    const filled = fills.reduce((sum, fill) => add(sum, fill.fillSz), "0");
    if (compareDecimal(filled, accFillSz) !== 0) return { settled: false, reason: "FILLS_INCOMPLETE" };
    let source; let settled;
    try {
      await this.transaction(async (tx) => {
        await this.orders.lockExitBase?.(tx, attempt.account_id ?? attempt.accountId, attempt.base_ccy ?? attempt.baseCcy);
        for (const fill of fills) {
          const applied = await this.state.recordSystemSell(tx, { accountId: attempt.account_id ?? attempt.accountId, instId: attempt.inst_id ?? attempt.instId, baseCcy: attempt.base_ccy ?? attempt.baseCcy, sourceBuyTradeId: attempt.source_buy_trade_id ?? attempt.sourceBuyTradeId, sourceAttemptClOrdId: attempt.cl_ord_id ?? attempt.clOrdId, tradeId: fill.tradeId, fillSize: fill.fillSz, fillTime: fill.fillTime, fillPrice: fill.fillPx, fee: fill.fee, feeCcy: fill.feeCcy, executionMode: attempt.execution_mode ?? attempt.executionMode ?? "cross", executionRoute: attempt.execution_route ?? attempt.executionRoute ?? "margin" });
          source ??= applied.source;
        }
        source ??= await this.state.findManagedBuy?.(tx, { accountId: attempt.account_id ?? attempt.accountId, tradeId: attempt.source_buy_trade_id ?? attempt.sourceBuyTradeId });
        settled = await this.orders.markSettled(tx, attempt.cl_ord_id ?? attempt.clOrdId, exchangeState, "RELEASED");
      });
    } catch (error) {
      if (error?.message === "SYSTEM_SELL_DISPOSAL_OUT_OF_RANGE") {
        const base = attempt.base_ccy ?? attempt.baseCcy; this.isolatedBases.add(base);
        this._emit({ type: "exit_reconciliation", reason: "SYSTEM_ACCOUNT_SELL_CONTRADICTION", baseCcy: base, clOrdId: attempt.cl_ord_id ?? attempt.clOrdId });
        return { settled: false, reason: "DISPOSAL_CONTRADICTION" };
      }
      throw error;
    }
    // A replay after a lost COMMIT acknowledgement sees rowCount=0 and never
    // manufactures a second replacement.  The successor is based on the
    // durable source-fill remainder, never planned_size minus a stale fill.
    const remaining = source ? subtractDecimal(source.fill_size, source.disposed_size) : "0";
    if (settled?.rowCount === 1 && compareDecimal(remaining, "0") > 0 && (attempt.intent !== "DELIST" || !this.onExitSettled)) {
      const instId = attempt.inst_id ?? attempt.instId; const quote = this.market.ticker(instId);
      this.enqueue({ intent: attempt.intent, accountId: attempt.account_id ?? attempt.accountId, instId, baseCcy: attempt.base_ccy ?? attempt.baseCcy, sourceBuyTradeId: attempt.source_buy_trade_id ?? attempt.sourceBuyTradeId, remainingSize: remaining, fillVersion: source.version, generation: Number(attempt.generation) + 1, sellTime: 0, availableBase: remaining, bidPx: quote?.bidPx ?? quote?.last, executionMode: source.execution_mode ?? source.executionMode ?? attempt.execution_mode ?? attempt.executionMode, executionRoute: source.execution_route ?? source.executionRoute ?? attempt.execution_route ?? attempt.executionRoute });
    }
    if (settled?.rowCount === 1 && this.onExitSettled) {
      try { await this.onExitSettled({ attempt, source, remaining }); }
      catch (error) { this._emit({ type: "exit_reconciliation", reason: "EXIT_ORCHESTRATION_DEFERRED", clOrdId: attempt.cl_ord_id ?? attempt.clOrdId, error: error?.message }); }
    }
    if (settled?.rowCount === 1) this._emit({ type: "trade_lifecycle", reason: "EXIT_SETTLED", intent: attempt.intent, instId: attempt.inst_id ?? attempt.instId, clOrdId: attempt.cl_ord_id ?? attempt.clOrdId, sourceBuyTradeId: attempt.source_buy_trade_id ?? attempt.sourceBuyTradeId, filledSize: filled, exchangeState, triggerPrice: attempt.decision_trigger_price ?? attempt.decisionTriggerPrice, referencePrice: attempt.decision_reference_price ?? attempt.decisionReferencePrice });
    return { settled: true, remaining };
  }
  async settleBuy({ attempt, fills, exchangeState, accFillSz }) {
    const filled = fills.reduce((sum, fill) => add(sum, fill.fillSz), "0");
    if (compareDecimal(filled, accFillSz) !== 0) return { settled: false, reason: "FILLS_INCOMPLETE" };
    await this.transaction(async (tx) => {
      for (const fill of fills) await this.state.insertFill(tx, { accountId: attempt.account_id, instId: attempt.inst_id, baseCcy: attempt.base_ccy, tradeId: fill.tradeId, source: "SYSTEM", side: "BUY", fillSize: fill.fillSz, fillTime: fill.fillTime, sourceAttemptClOrdId: attempt.cl_ord_id ?? attempt.clOrdId, fillPrice: fill.fillPx, fee: fill.fee, feeCcy: fill.feeCcy, holdHours: attempt.hold_hours, strategyConfigHash: attempt.strategy_config_hash, sellTime: Number(fill.fillTime) + Number(attempt.hold_hours) * 3_600_000, sellState: "WAITING", executionMode: attempt.execution_mode ?? attempt.executionMode ?? "cross", executionRoute: attempt.execution_route ?? attempt.executionRoute ?? "margin" });
      await this.orders.markSettled(tx, attempt.cl_ord_id, exchangeState, compareDecimal(accFillSz, "0") > 0 ? "CONVERTED" : "RELEASED");
    });
    this._emit({ type: "trade_lifecycle", reason: "BUY_SETTLED", intent: "BUY", instId: attempt.inst_id ?? attempt.instId, clOrdId: attempt.cl_ord_id ?? attempt.clOrdId, filledSize: filled, exchangeState, sellTime: fills.length ? Math.min(...fills.map((fill) => Number(fill.fillTime) + Number(attempt.hold_hours) * 3_600_000)) : undefined });
    if (this.onBuySettled) await this.onBuySettled({ attempt, fills, exchangeState, accFillSz });
    return { settled: true };
  }
  _remainingCapacity(managedExposure = "0") { const snapshot = this.account.value; if (!snapshot) return "0"; const equity = adjustedEquity(snapshot); const remaining = subtractDecimal(multiplyDecimal(BUY_ADMISSION_LEVERAGE, equity), managedExposure); return compareDecimal(remaining, "0") > 0 ? remaining : "0"; }
  _executionMode(intent) {
    const value = intent.executionMode ?? intent.execution_mode ?? (this._executionRoute(intent) ? "cross" : null);
    return value === "cross" || value === "cash" ? value : null;
  }
  _executionRoute(intent) {
    const value = intent.executionRoute ?? intent.execution_route ?? this.executionRoute(intent.instId);
    return value === "margin" || value === "spot" ? value : null;
  }
  _buyGuard(intent) {
    if (intent.generation > 0 && !this.canCreateNextBuy({ previousAttempt: intent.previousAttempt, nextMarketKey: intent.nextMarketKey })) return { allowed: false, reason: "GENERATION_NOT_SETTLED_OR_DUPLICATE" };
    if (this.mode() !== "FULL") return { allowed: false, reason: "MODE" };
    if (!this.ownerGuard.isHeld()) return { allowed: false, reason: "OWNER" };
    if (!this.readyGate.ready || !this.account.fresh(this.config.accountFreshMs)) return { allowed: false, reason: "NOT_READY" };
    if (!this.transport.clockFresh(CLOCK_SYNC_STALE_AFTER_MS)) return { allowed: false, reason: "CLOCK_SYNC_STALE" };
    const quote = this.market.freshQuote(intent.instId, this.config.quoteFreshMs); const candle = this.market.candle(intent.instId); const instrument = this.market.instrument(intent.instId);
    if (!quote || !candle || !instrument || instrument.state !== "live" || intent.protected || intent.enabled === false || intent.dailyReady === false || !this.isBuyAllowed(intent.instId)) return { allowed: false, reason: "MARKET" };
    if (candleFreshness({ candle, exchangeNowMs: this.clock.nowMs() + Number(this.transport.clockSkewMs ?? 0) }).state !== "FRESH") return { allowed: false, reason: "MARKET" };
    const risk = assessLeverage({ committedExposure: intent.managedExposure ?? "0", ...this.account.value });
    if (risk.hardStopped) return { allowed: false, reason: "HARD_STOP" };
    const signal = buySignal({ last: quote.last, askPx: quote.askPx, limitPrice: roundToStep(intent.dailyLimitPrice, instrument.tickSz, "down"), previousClosedHigh: candle.high });
    // The same snapshot backs both the allow/deny decision and attempt construction in
    // submitBuys, so a quote/candle read can never drift from the freshness check that gated it.
    return signal.eligible ? { allowed: true, quote, candle, instrument, signal } : { allowed: false, reason: signal.reason };
  }
  _exitGuard(intent, kind) {
    if (this.mode() === "OFF") return { allowed: false, reason: "MODE" };
    if (!this.ownerGuard.isHeld()) return { allowed: false, reason: "OWNER" };
    if (!this.readyGate.ready || !this.account.fresh(this.config.accountFreshMs)) return { allowed: false, reason: "NOT_READY" };
    const instrument = this.market.instrument(intent.instId);
    if (!instrument || (kind !== "DELIST" && instrument.state !== "live")) return { allowed: false, reason: "INSTRUMENT_NOT_TRADABLE" };
    if (intent.pendingAccountSell) return { allowed: false, reason: "ACCOUNT_SELL_PENDING" };
    if (this.isolatedBases.has(intent.baseCcy)) return { allowed: false, reason: "EXIT_BASE_ISOLATED" };
    if (!intent.remainingSize || compareDecimal(intent.remainingSize, "0") <= 0) return { allowed: false, reason: "EXIT_REMAINING_CHANGED" };
    return { allowed: true };
  }
}

export { PRIORITY, terminal };
