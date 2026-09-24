import { compareDecimal, divideDecimal, multiplyDecimal, parseDecimal, formatDecimal, roundToStep, subtractDecimal } from "../decimal.js";
import { PANIC_MIN_ORDER_USDT, TRADE_FEE_RATE, normalizeStrategyDay, panicSellTime, strategyDay, strategyDayCloseSellMs } from "../domain/rules.js";
import { CLOCK_SYNC_STALE_AFTER_MS } from "../infrastructure/okx/rest-client.js";
import { createClOrdId, payloadHash } from "../domain/order.js";

const PRIORITY = { DELIST: 3, SELL: 2, BUY: 1 };
// After owned USDT runs out, re-read capacity only once the account stream has
// moved on or this interval passed, so a crash with dozens of qualifying
// symbols cannot turn every tick into two authenticated REST reads.
const CAPITAL_RECHECK_MS = 30_000;
const BUY_CAPACITY_RETRY_MS = 1_000;
const terminal = new Set(["NOT_CREATED", "SETTLED"]);

function min(...values) { return values.reduce((lowest, value) => compareDecimal(value, lowest) < 0 ? value : lowest); }
function add(left, right) {
  const a = parseDecimal(left); const b = parseDecimal(right); const scale = Math.max(a.scale, b.scale);
  return formatDecimal(a.n * (10n ** BigInt(scale - a.scale)) + b.n * (10n ** BigInt(scale - b.scale)), scale);
}
// Owned quote currency, never borrowable capacity: the account runs with
// autoLoan, so sizing above this balance would silently open a loan.
export function ownedQuoteBalance(balances, ccy = "USDT") {
  const detail = (balances ?? []).flatMap((row) => row?.details ?? []).find((row) => row?.ccy === ccy);
  const available = detail?.availBal;
  return available && compareDecimal(available, "0") > 0 ? String(available) : "0";
}
function availabilityFailure(error) {
  const diagnostic = error?.diagnostic;
  return diagnostic ? { error: diagnostic.failureClass, ...diagnostic } : { error: "REDACTED_ERROR", failureClass: "UNCLASSIFIED", endpoint: "/api/v5/account/max-avail-size" };
}

/** The only component allowed to invoke an injected mutation transport. */
export class OrderCoordinator {
  constructor({ transaction, orders, state, transport, ownerGuard, readyGate, market, account, mode = () => "OFF", executionRoute = () => "margin", tradeQuoteCurrency = () => null, isBuyAllowed = () => true, clock = { nowMs: () => Date.now() }, config, telemetry = () => {}, onBuySettled = null, onBuySubmitted = null, onExitSettled = null, onExitSubmitted = null, onExitDust = null, slo = null }) {
    Object.assign(this, { transaction, orders, state, transport, ownerGuard, readyGate, market, account, mode, executionRoute, tradeQuoteCurrency, isBuyAllowed, clock, config, telemetry, onBuySettled, onBuySubmitted, onExitSettled, onExitSubmitted, onExitDust, slo });
    this.pending = { BUY: new Map(), SELL: new Map(), DELIST: new Map() }; this.submitting = false; this.accepting = true; this.isolatedBases = new Set(); this.buyBlockStates = new Map(); this.exitAvailabilityNotBefore = { SELL: 0, DELIST: 0 };
    this.capitalBlock = null; this.buyNotBefore = 0;
  }
  enqueue(intent) {
    if (!this.accepting) return false;
    const group = this.pending[intent.intent];
    if (!group) throw new Error("unknown intent");
    const key = intent.intent === "BUY" ? intent.instId : `${intent.baseCcy}:${intent.sourceBuyTradeId}`;
    const current = group.get(key);
    // A SELL/DELIST event can be replayed while its availability read is in
    // backoff. Refresh its market evidence, but never let that duplicate erase
    // the account-wide retry deadline and recreate a request storm.
    if (intent.intent !== "BUY" && Number.isFinite(current?.notBefore) && current.notBefore > this.clock.nowMs()) {
      group.set(key, { ...intent, notBefore: current.notBefore, firstDeferredAt: current.firstDeferredAt, lastDeferReason: current.lastDeferReason });
    } else group.set(key, intent);
    return true;
  }
  stopNewMutations() { this.accepting = false; }
  pendingExitSources() { return new Set([...this.pending.SELL.values(), ...this.pending.DELIST.values()].map((intent) => intent.sourceBuyTradeId)); }
  async finishInFlight() { while (this.submitting) await new Promise((resolve) => setTimeout(resolve, 1)); }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* telemetry cannot block trading */ } }
  _emitBuyBlock(intent, stage, reason, evidence = {}) {
    const identity = intent.decisionId ?? intent.clOrdId ?? `${intent.instId}:${intent.strategyDay ?? ""}:${intent.generation ?? 0}`;
    const key = `${identity}:${stage}`; const fingerprint = reason;
    if (this.buyBlockStates.get(key) === fingerprint) return;
    if (this.buyBlockStates.size >= 1_000) this.buyBlockStates.delete(this.buyBlockStates.keys().next().value);
    this.buyBlockStates.set(key, fingerprint);
    this._emit({
      type: "block_evidence", side: "BUY", stage, reason, reasonCode: reason,
      decisionId: intent.decisionId, clOrdId: intent.clOrdId, instId: intent.instId,
      strategyDay: intent.strategyDay, generation: intent.generation,
      executionMode: intent.executionMode, executionRoute: intent.executionRoute,
      ...evidence,
    });
  }
  _clearBuyBlock(intent, stage) {
    const identity = intent.decisionId ?? intent.clOrdId ?? `${intent.instId}:${intent.strategyDay ?? ""}:${intent.generation ?? 0}`;
    this.buyBlockStates.delete(`${identity}:${stage}`);
  }
  canCreateNextBuy({ previousAttempt, nextMarketKey }) {
    return ["SETTLED", "NOT_CREATED"].includes(previousAttempt?.state) && Boolean(nextMarketKey) && nextMarketKey !== previousAttempt.decision_market_key;
  }
  buyCapitalBlocked(nowMs = this.clock.nowMs()) {
    const block = this.capitalBlock; if (!block) return false;
    if ((this.account.value?.version ?? 0) > block.version || nowMs - block.at >= CAPITAL_RECHECK_MS) { this.capitalBlock = null; return false; }
    return true;
  }
  async drainOnce() {
    if (this.submitting) return { submitted: false, reason: "SLOT_BUSY" };
    const kind = ["DELIST", "SELL", "BUY"].find((name) => this.pending[name].size);
    if (!kind) return { submitted: false, reason: "EMPTY" };
    if (kind !== "BUY") {
      const candidates = [...this.pending[kind].values()].filter((intent) => !Number.isFinite(intent.notBefore) || intent.notBefore <= this.clock.nowMs())
        .sort((a, b) => a.baseCcy.localeCompare(b.baseCcy) || a.sellTime - b.sellTime || String(a.sourceBuyTradeId).localeCompare(String(b.sourceBuyTradeId)))
        .filter((item, index, rows) => index === 0 || item.baseCcy !== rows[index - 1].baseCcy).slice(0, 5);
      const prepared = await this.prepareExits(kind, candidates);
      if (!prepared.length) return { submitted: false, reason: "NO_ELIGIBLE" };
      if (kind !== "DELIST" && this.pending.DELIST.size) return { submitted: false, reason: "PREEMPTED" };
      this.submitting = true;
      try { return await this.submitExits(kind, prepared); } finally { this.submitting = false; }
    }
    return this.drainBuy();
  }
  // One global BUY queue, strictly serial: the earliest 72% trigger is sized
  // from a fresh owned-USDT read, submitted as one IOC, and recorded before
  // the next symbol is considered.  An intent that no longer qualifies is
  // dropped; the planner re-queues it on the symbol's next qualifying tick.
  async drainBuy() {
    const nowMs = this.clock.nowMs();
    if (this.buyCapitalBlocked(nowMs)) return { submitted: false, reason: "CAPITAL_EXHAUSTED" };
    if (this.buyNotBefore > nowMs) return { submitted: false, reason: "CAPACITY_RETRY_WAIT" };
    const ordered = [...this.pending.BUY.values()].sort((a, b) => (a.triggerAt ?? a.signalAt ?? 0) - (b.triggerAt ?? b.signalAt ?? 0) || a.instId.localeCompare(b.instId));
    for (const intent of ordered) {
      intent._signalStartedAt ??= Number.isFinite(intent.signalAt) ? intent.signalAt : this.clock.nowMs();
      const guard = this._buyGuard(intent);
      if (!guard.allowed) { this._emitBuyBlock(intent, "COORDINATOR_GUARD", guard.reason, guard.evidence); this._dropBuy(intent); continue; }
      this._clearBuyBlock(intent, "COORDINATOR_GUARD");
      const sized = await this.sizeBuy(intent, guard);
      if (sized.dropped) continue;
      if (!sized.intent) return { submitted: false, reason: sized.reason };
      if (this.pending.DELIST.size || this.pending.SELL.size) return { submitted: false, reason: "PREEMPTED" };
      this.submitting = true;
      try { return await this.submitBuy(sized.intent); } finally { this.submitting = false; }
    }
    return { submitted: false, reason: "NO_ELIGIBLE" };
  }
  // Sized and prepared intents are copies; only the exact queued object is
  // removed, so a fresher intent enqueued meanwhile for the symbol survives.
  _dropBuy(intent) { const queued = intent.queued ?? intent; if (this.pending.BUY.get(queued.instId) === queued) this.pending.BUY.delete(queued.instId); }
  async sizeBuy(intent, guard) {
    const executionRoute = this._executionRoute(intent);
    if (!executionRoute) { this._emitBuyBlock(intent, "ROUTING", "EXECUTION_ROUTE_UNAVAILABLE"); this._dropBuy(intent); return { dropped: true }; }
    const executionMode = "cross";
    const tradeQuoteCcy = intent.tradeQuoteCcy ?? this.tradeQuoteCurrency(intent.instId);
    const capacityCcy = tradeQuoteCcy ?? intent.instId.split("-").at(-1);
    const evidenceIntent = { ...intent, executionMode, executionRoute };
    const started = this.clock.nowMs();
    let avail; let balances;
    try { [avail, balances] = await Promise.all([this.transport.maxAvailSize(intent.instId, { tdMode: executionMode, ccy: capacityCcy }), this.transport.balance(capacityCcy)]); }
    catch (error) {
      this.buyNotBefore = this.clock.nowMs() + BUY_CAPACITY_RETRY_MS;
      this._emitBuyBlock(evidenceIntent, "AVAILABILITY", "MAX_AVAIL_FAILED", availabilityFailure(error));
      return { reason: "MAX_AVAIL_FAILED" };
    } finally { this.slo?.record("signal_max_avail", started); }
    const availBuy = (avail ?? []).find((row) => row.instId === intent.instId)?.availBuy ?? "0";
    const ownedQuote = ownedQuoteBalance(balances, capacityCcy);
    const notional = min(compareDecimal(availBuy, "0") > 0 ? availBuy : "0", ownedQuote);
    const { instrument, quote } = guard;
    const executionPrice = roundToStep(intent.limitPrice, instrument.tickSz, "down");
    const feeMultiplier = add("1", TRADE_FEE_RATE);
    const size = compareDecimal(executionPrice, "0") > 0 ? roundToStep(divideDecimal(notional, multiplyDecimal(executionPrice, feeMultiplier)), instrument.lotSz, "down") : "0";
    if (compareDecimal(quote.askPx, executionPrice) > 0) { this._emitBuyBlock(evidenceIntent, "SIZING", "ASK_ABOVE_LIMIT", { askPx: quote.askPx, limitPrice: executionPrice }); this._dropBuy(intent); return { dropped: true }; }
    if (compareDecimal(notional, PANIC_MIN_ORDER_USDT) < 0 || compareDecimal(size, instrument.minSz) < 0) {
      this.capitalBlock = { version: this.account.value?.version ?? 0, at: this.clock.nowMs() };
      this._emitBuyBlock(evidenceIntent, "SIZING", "CAPITAL_EXHAUSTED", { availBuy, ownedQuote, notional, minimumNotional: PANIC_MIN_ORDER_USDT, plannedSize: size, minSize: instrument.minSz, limitPrice: executionPrice });
      return { reason: "CAPITAL_EXHAUSTED" };
    }
    return { intent: { ...intent, queued: intent, availBuy, ownedQuote, notional, executionPrice, plannedSize: size, capacityCcy, executionMode, executionRoute, tradeQuoteCcy } };
  }
  async submitBuy(intent) {
    const started = this.clock.nowMs();
    const reservationStarted = this.clock.nowMs();
    let prepared;
    try {
      prepared = await this.transaction(async (tx) => {
        const guard = this._buyGuard(intent);
        if (!guard.allowed) { this._emitBuyBlock(intent, "PREPARATION_GUARD", guard.reason, guard.evidence); return null; }
        const { instrument, quote } = guard;
        if (compareDecimal(quote.askPx, intent.executionPrice) > 0) { this._emitBuyBlock(intent, "SIZING", "ASK_ABOVE_LIMIT", { askPx: quote.askPx, limitPrice: intent.executionPrice }); return null; }
        const feeMultiplier = add("1", TRADE_FEE_RATE);
        const payload = { instId: intent.instId, tdMode: intent.executionMode, side: "buy", ordType: "ioc", px: intent.executionPrice, sz: intent.plannedSize, tag: this.config.strategyTag, ...(intent.executionRoute === "margin" && intent.tradeQuoteCcy ? { tradeQuoteCcy: intent.tradeQuoteCcy } : {}) };
        const tuple = { instId: intent.instId, strategyDay: intent.strategyDay, generation: intent.generation };
        const clOrdId = await createClOrdId(this.config.orderVersion, "BUY", tuple); payload.clOrdId = clOrdId;
        const hash = await payloadHash(payload); const marketKey = await payloadHash({ quote, anchor: intent.anchor });
        const attempt = {
          accountId: this.config.accountId, intent: "BUY", instId: intent.instId, baseCcy: instrument.base, decisionId: intent.decisionId, clOrdId, payloadHash: hash,
          strategyDay: intent.strategyDay, generation: intent.generation, plannedSize: intent.plannedSize, reservedExposureUsd: multiplyDecimal(multiplyDecimal(intent.plannedSize, intent.executionPrice), feeMultiplier),
          decisionQuoteTs: quote.ts, decisionQuoteHash: await payloadHash(quote), decisionCandleTs: intent.anchor.ts, decisionCandleHash: intent.anchor.hash, decisionMarketKey: marketKey,
          executionLimitPrice: intent.executionPrice, instrumentVersion: String(instrument.version ?? "1"), holdHours: intent.holdHours, maxHoldHours: null, strategyConfigHash: intent.configHash,
          accountSnapshotVersion: String(this.account.value?.version ?? "capacity"), executionMode: intent.executionMode, executionRoute: intent.executionRoute,
          decisionTriggerPrice: quote.last, decisionReferencePrice: intent.limitPrice, decisionReason: "PANIC_BUY_72",
        };
        try {
          const reserveStarted = this.clock.nowMs();
          let reserve;
          try { reserve = await this.orders.reserveBuy(tx, attempt); }
          finally { this.slo?.record("buy_reserve_db", reserveStarted); }
          if (reserve.authorized) return { intent: { ...intent, clOrdId }, attempt, payload };
          this._emitBuyBlock({ ...intent, clOrdId }, "RESERVATION", reserve.reason ?? "RESERVATION_DENIED", { notional: intent.notional, reservedExposure: attempt.reservedExposureUsd });
          return null;
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
      });
    } catch (error) {
      if (error?.code !== "23505" || !error.clOrdId || typeof this.orders.findByClOrdId !== "function") throw error;
      this._dropBuy(intent);
      const existing = await this.transaction((tx) => this.orders.findByClOrdId(tx, error.clOrdId));
      if (!existing || (existing.payload_hash ?? existing.payloadHash) !== error.expectedPayloadHash) {
        this._emit({ type: "buy_replay", reason: "HASH_COLLISION", clOrdId: error.clOrdId });
        throw new Error("HASH_COLLISION");
      }
      this._emit({ type: "buy_replay", reason: "COMMIT_ACK_LOST", clOrdId: error.clOrdId, state: existing.state });
      return { submitted: false, reason: "COMMIT_ACK_LOST" };
    } finally { this.slo?.record("buy_reservation_tx", reservationStarted); }
    if (!prepared) { this._dropBuy(intent); return { submitted: false, reason: "RESERVATION_DENIED" }; }
    const { attempt, payload } = prepared;
    this._emit({ type: "order_lifecycle", reason: "BUY_PREPARED", intent: "BUY", decisionId: prepared.intent.decisionId, instId: intent.instId, clOrdId: attempt.clOrdId, generation: intent.generation, executionMode: attempt.executionMode, executionRoute: attempt.executionRoute, limitPrice: attempt.executionLimitPrice, plannedSize: attempt.plannedSize, notional: intent.notional, ownedQuote: intent.ownedQuote, availBuy: intent.availBuy, triggerPrice: attempt.decisionTriggerPrice, referencePrice: attempt.decisionReferencePrice, countRank: intent.countRank });
    const guard = this._buyGuard(prepared.intent);
    if (!guard.allowed) {
      this._emitBuyBlock(prepared.intent, "FINAL_GUARD", guard.reason, guard.evidence);
      await this.transaction((tx) => this.orders.markNotCreated(tx, attempt.clOrdId, guard.reason));
      this._dropBuy(intent);
      return { submitted: false, reason: "FINAL_GUARD" };
    }
    let response;
    try {
      this.slo?.record("signal_post", intent._signalStartedAt ?? started); this.slo?.record("prepared_post", started); this.slo?.record("prepared_submit", started); const submittedAt = this.clock.nowMs();
      response = await this.transport.submitBatchOrders([payload], this.clock.nowMs() + this.config.orderExpiryMs); this.slo?.record("submit_ack", submittedAt);
    } catch (error) {
      response = [{ clOrdId: attempt.clOrdId, status: "UNKNOWN", reason: error?.message ?? "TRANSPORT_FAILURE" }];
    }
    const item = (response ?? []).find((row) => row.clOrdId === attempt.clOrdId) ?? { clOrdId: attempt.clOrdId, status: "UNKNOWN", reason: "MISSING_BATCH_ITEM" };
    await this.transaction((tx) => item.status === "SUBMITTED" ? this.orders.markSubmitted(tx, item.clOrdId, item.ordId) : item.status === "NOT_CREATED" ? this.orders.markNotCreated(tx, item.clOrdId, item.reason) : this.orders.markUnknown(tx, item.clOrdId, item.reason));
    this._emit({ type: "order_lifecycle", reason: `BUY_${item.status}`, intent: "BUY", decisionId: intent.decisionId, instId: intent.instId, executionMode: attempt.executionMode, executionRoute: attempt.executionRoute, clOrdId: item.clOrdId, ordId: item.ordId, exchangeReason: item.reason, okxCode: item.sCode, okxSubCode: item.subCode });
    this._dropBuy(intent);
    // UNKNOWN blocks only this symbol (its active attempt); the queue moves on
    // and the next order's fresh balance read reflects a fill if one happened.
    if (item.status !== "NOT_CREATED" && this.onBuySubmitted) {
      try { this.onBuySubmitted({ ...attempt, state: item.status, ordId: item.ordId }); }
      catch (error) { this._emit({ type: "order_confirmation", reason: "SCHEDULE_FAILED", intent: "BUY", clOrdId: item.clOrdId, error: error?.message }); }
    }
    const unknown = item.status === "UNKNOWN" ? 1 : 0; this.slo?.observe("unknown_count", unknown); this.slo?.increment?.("unknown_count", unknown); this.slo?.observe("batch_size", 1); this.slo?.observe("mutation_concurrency", 1); this._emit({ type: "buy_batch", count: 1, results: [{ clOrdId: item.clOrdId, status: item.status }] });
    return { submitted: true, count: 1, response: [item] };
  }
  async prepareExits(kind, candidates) {
    const eligible = [];
    for (const intent of candidates) {
      const guard = this._exitGuard(intent, kind);
      if (guard.allowed) eligible.push(intent);
      else {
        this._deferExit(intent, kind, guard.reason);
        this._emit({ type: "exit_deferred", intent: kind, reason: guard.reason, baseCcy: intent.baseCcy, sourceBuyTradeId: intent.sourceBuyTradeId });
      }
    }
    if (!eligible.length) return [];
    // max-avail-size is an account-wide endpoint. Its cooldown must outlive
    // individual pending intents, because new/replayed fills can otherwise
    // bypass their own notBefore values and recreate a request storm.
    if ((this.exitAvailabilityNotBefore[kind] ?? 0) > this.clock.nowMs()) return [];
    let available;
    try {
      const routed = eligible.map((intent) => ({ intent, executionRoute: this._executionRoute(intent), executionMode: this._executionMode(intent) })).filter((row) => row.executionRoute && row.executionMode);
      const groups = Map.groupBy(routed, (row) => `${row.executionMode}:${row.executionRoute}`);
      // Some cross-margin accounts reject reduceOnly on this read-only endpoint
      // with OKX code 3 ("Operation not supported"). The submitted exit order
      // remains reduce-only and sizing is still capped by managed remaining and
      // the account-wide base reservation below.
      available = (await Promise.all([...groups].map(([, rows]) => { const { executionMode: tdMode } = rows[0]; return this.transport.maxAvailSize(rows.map(({ intent }) => intent.instId).join(","), { tdMode }); }))).flat();
    }
    catch (error) {
      // Availability is an account-wide read.  Leaving these intents immediately
      // eligible turns a transient API failure into a retry storm on every work
      // loop, which can prolong rate limiting and obscure later reconciliation.
      const retryAt = this.clock.nowMs() + 1_000;
      this.exitAvailabilityNotBefore[kind] = retryAt;
      for (const intent of eligible) this._deferExit(intent, kind, "MAX_AVAIL_FAILED", 1_000, false);
      this._emit({ type: "exit_deferred", intent: kind, reason: "MAX_AVAIL_FAILED", candidateCount: eligible.length, ...availabilityFailure(error) });
      return [];
    }
    const byInst = new Map((available ?? []).map((row) => [row.instId, row.availSell]));
    const planned = [];
    for (const intent of eligible) {
      const instrument = this.market.instrument(intent.instId); const reduceOnly = byInst.get(intent.instId);
      const availableBase = intent.availableBase ?? reduceOnly;
      if (!instrument || !reduceOnly || !availableBase) continue;
      const raw = min(intent.remainingSize, availableBase ?? reduceOnly, reduceOnly);
      const size = roundToStep(raw, instrument.lotSz, "down");
      if (compareDecimal(size, instrument.minSz) < 0 || (intent.bidPx && compareDecimal(multiplyDecimal(size, intent.bidPx), "0.1") < 0)) {
        await this._resolveDust(intent, kind);
        continue;
      }
      if (compareDecimal(size, "0") <= 0) { this._emit({ type: "exit_deferred", intent: kind, reason: "BALANCE_SHORTFALL", sourceBuyTradeId: intent.sourceBuyTradeId }); continue; }
      planned.push({ ...intent, plannedSize: size });
    }
    return planned;
  }
  // Retries a stalled exit under a fresh generation. Reusing the same
  // generation would collide forever with order_attempts_exit_generation_uq
  // (unfiltered by state) once a terminal NOT_CREATED row exists for it.
  _retryExit(intent, kind, reason) {
    this.pending[kind].delete(`${intent.baseCcy}:${intent.sourceBuyTradeId}`);
    this.enqueue({ ...intent, generation: (intent.generation ?? 0) + 1 });
    this._emit({ type: "exit_deferred", intent: kind, reason, sourceBuyTradeId: intent.sourceBuyTradeId, retried: true });
  }
  _deferExit(intent, kind, reason, delayMs = 1_000, emit = true) {
    const key = `${intent.baseCcy}:${intent.sourceBuyTradeId}`;
    const current = this.pending[kind].get(key) ?? intent;
    const firstDeferredAt = current.firstDeferredAt ?? this.clock.nowMs();
    this.pending[kind].set(key, { ...current, notBefore: this.clock.nowMs() + delayMs, firstDeferredAt, lastDeferReason: reason });
    if (emit) this._emit({ type: "exit_deferred", intent: kind, reason, sourceBuyTradeId: intent.sourceBuyTradeId, retryAfterMs: delayMs });
  }
  // Watchdog signal: an exit that has been sitting in the pending map (repeatedly
  // deferred, never reserved) for longer than a threshold — e.g. INSTRUMENT_NOT_TRADABLE
  // with no delist confirmation ever arriving — is exactly the "never sellable" failure
  // mode this counts, independent of why any single defer happened.
  stuckExitCount(thresholdMs, nowMs = this.clock.nowMs()) {
    return this.stuckExitSnapshot(thresholdMs, nowMs).count;
  }
  stuckExitSnapshot(thresholdMs, nowMs = this.clock.nowMs()) {
    const stuck = [];
    for (const kind of ["SELL", "DELIST"]) for (const intent of this.pending[kind].values()) {
      if (intent.firstDeferredAt && nowMs - intent.firstDeferredAt >= thresholdMs) stuck.push({ kind, intent });
    }
    const reasons = new Map();
    for (const { intent } of stuck) {
      const reason = intent.lastDeferReason ?? "UNKNOWN";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    return {
      count: stuck.length,
      oldestAgeMs: stuck.length ? Math.max(...stuck.map(({ intent }) => nowMs - intent.firstDeferredAt)) : 0,
      reasons: [...reasons].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => `${reason}:${count}`).join(","),
      instruments: [...new Set(stuck.map(({ intent }) => intent.instId).filter(Boolean))].sort().join(","),
    };
  }
  // A dust-sized remainder must stop being redriven every ~10ms and must be
  // reflected out of the local pending map immediately: nothing else clears
  // it. A CAS miss on markDust does not by itself mean the exit is gone —
  // re-read durable truth before deciding to drop it.
  async _resolveDust(intent, kind) {
    const key = `${intent.baseCcy}:${intent.sourceBuyTradeId}`;
    const result = await this.transaction((tx) => this.state.markDust?.(tx, { ...intent, tradeId: intent.sourceBuyTradeId, version: intent.fillVersion }));
    if (result?.rowCount === 1) {
      this.pending[kind].delete(key);
      const row = result.rows?.[0];
      this._emit({ type: "exit_deferred", intent: kind, reason: "DUST", sourceBuyTradeId: intent.sourceBuyTradeId });
      if (row && this.onExitDust) await this.onExitDust({ intent: kind, row });
      return;
    }
    const fill = await this.transaction((tx) => this.state.findManagedBuy?.(tx, { accountId: intent.accountId, tradeId: intent.sourceBuyTradeId }));
    if (!fill) {
      this.pending[kind].delete(key);
      this._emit({ type: "exit_deferred", intent: kind, reason: "DUST_CAS_LOST_FILL_MISSING", sourceBuyTradeId: intent.sourceBuyTradeId });
      return;
    }
    if (["DUST_PENDING", "SOLD"].includes(fill.sell_state)) {
      this.pending[kind].delete(key);
      this._emit({ type: "exit_deferred", intent: kind, reason: "DUST_CAS_LOST_ALREADY_RESOLVED", sourceBuyTradeId: intent.sourceBuyTradeId });
      if (fill.sell_state === "DUST_PENDING" && this.onExitDust) await this.onExitDust({ intent: kind, row: fill });
      return;
    }
    // Still WAITING/SELL_TRIGGERED under a newer version: some unrelated
    // writer (e.g. raiseProtection) moved it first. Retry with the fresh
    // version instead of silently dropping a genuinely sellable exit.
    this.pending[kind].delete(key);
    this.enqueue({ ...intent, fillVersion: fill.version });
    this._emit({ type: "exit_deferred", intent: kind, reason: "DUST_CAS_LOST_RETRY", sourceBuyTradeId: intent.sourceBuyTradeId });
  }
  async submitExits(kind, candidates) {
    let prepared;
    try {
      prepared = await this.transaction(async (tx) => {
        const rows = [];
        for (const intent of candidates) {
          const guard = this._exitGuard(intent, kind);
          if (!guard.allowed) { this._deferExit(intent, kind, `FINAL_${guard.reason}`); continue; }
          const instrument = this.market.instrument(intent.instId);
          const executionMode = this._executionMode(intent);
          const executionRoute = this._executionRoute(intent);
          const payload = { instId: intent.instId, tdMode: executionMode, side: "sell", ordType: "market", ...(executionMode === "cross" && executionRoute === "margin" ? { reduceOnly: true } : {}), sz: intent.plannedSize, tag: this.config.strategyTag };
          const tuple = { instId: intent.instId, tradeId: intent.sourceBuyTradeId, generation: intent.generation ?? 0, intent: kind };
          const clOrdId = await createClOrdId(this.config.orderVersion, kind, tuple); payload.clOrdId = clOrdId;
          const attempt = { accountId: this.config.accountId, intent: kind, instId: intent.instId, baseCcy: intent.baseCcy ?? instrument.base, clOrdId, payloadHash: await payloadHash(payload), sourceBuyTradeId: intent.sourceBuyTradeId, generation: intent.generation ?? 0, plannedSize: intent.plannedSize, reservedBaseSize: intent.plannedSize, executionMode, executionRoute, decisionTriggerPrice: intent.triggerPrice ?? this.market.ticker(intent.instId)?.last, decisionReferencePrice: intent.referencePrice ?? intent.protection, decisionReason: kind === "DELIST" ? "DELIST_EXIT" : "SELL_SCHEDULED_CLOSE" };
          try {
            const reserve = await this.orders.reserveExit(tx, attempt);
            if (reserve?.authorized !== false) rows.push({ intent, attempt, payload });
            else this._deferExit(intent, kind, reserve.reason ?? "RESERVATION_DENIED");
          } catch (error) {
            // Same ambiguity as the BUY path: a lost COMMIT acknowledgement is
            // resolved by the deterministic business key, never by minting a
            // second generation blindly.
            error.exitIntent = intent;
            if (error?.code === "23505" && typeof this.orders.findByClOrdId === "function") { error.clOrdId = clOrdId; error.expectedPayloadHash = attempt.payloadHash; }
            throw error;
          }
        }
        return rows;
      });
    } catch (error) {
      if (error?.code !== "23505" || !error.clOrdId || typeof this.orders.findByClOrdId !== "function") {
        if (error?.exitIntent) this._deferExit(error.exitIntent, kind, "DB_DURABILITY_BLOCKED");
        this._emit({ type: "exit_replay", intent: kind, reason: "DB_DURABILITY_BLOCKED", error: error?.message });
        return { submitted: false, reason: "DB_DURABILITY_BLOCKED" };
      }
      const existing = await this.transaction((tx) => this.orders.findByClOrdId(tx, error.clOrdId));
      if (!existing || (existing.payload_hash ?? existing.payloadHash) !== error.expectedPayloadHash) {
        this.pending[kind].delete(`${error.exitIntent.baseCcy}:${error.exitIntent.sourceBuyTradeId}`);
        this._emit({ type: "exit_replay", intent: kind, reason: "HASH_COLLISION", clOrdId: error.clOrdId });
        return { submitted: false, reason: "HASH_COLLISION" };
      }
      if (["PREPARED", "SUBMITTED", "UNKNOWN"].includes(existing.state)) {
        this.pending[kind].delete(`${error.exitIntent.baseCcy}:${error.exitIntent.sourceBuyTradeId}`);
        this._emit({ type: "exit_replay", intent: kind, reason: "COMMIT_ACK_LOST", clOrdId: error.clOrdId, state: existing.state });
        return { submitted: false, reason: "COMMIT_ACK_LOST" };
      }
      // Our own prior attempt at this generation already concluded terminally
      // (e.g. a FINAL_GUARD rejection whose retry raced this one) — the next
      // attempt must move to a fresh generation, not repeat this collision.
      this._retryExit(error.exitIntent, kind, "STALE_GENERATION_RETRY");
      return { submitted: false, reason: "STALE_GENERATION_RETRIED" };
    }
    if (!prepared.length) return { submitted: false, reason: "RESERVATION_DENIED" };
    for (const row of prepared) this._emit({ type: "order_lifecycle", reason: `${kind}_PREPARED`, intent: kind, instId: row.intent.instId, clOrdId: row.attempt.clOrdId, plannedSize: row.attempt.plannedSize, triggerPrice: row.attempt.decisionTriggerPrice, referencePrice: row.attempt.decisionReferencePrice, sourceBuyTradeId: row.intent.sourceBuyTradeId });
    const safe = [];
    for (const row of prepared) {
      const guard = this._exitGuard(row.intent, kind);
      if (!guard.allowed) { await this.transaction((tx) => this.orders.markNotCreated(tx, row.attempt.clOrdId, guard.reason)); this._retryExit(row.intent, kind, "FINAL_GUARD"); }
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
    const safeByClOrdId = new Map(safe.map((row) => [row.attempt.clOrdId, row]));
    for (const row of safe) this.pending[kind].delete(`${row.intent.baseCcy}:${row.intent.sourceBuyTradeId}`);
    for (const item of response) {
      this._emit({ type: "order_lifecycle", reason: `${kind}_${item.status}`, intent: kind, clOrdId: item.clOrdId, ordId: item.ordId, exchangeReason: item.reason, okxCode: item.sCode, okxSubCode: item.subCode });
      if (item.status === "SUBMITTED" && this.onExitSubmitted) {
        try { this.onExitSubmitted({ ...safeByClOrdId.get(item.clOrdId).attempt, ordId: item.ordId }); }
        catch (error) { this._emit({ type: "exit_confirmation", reason: "SCHEDULE_FAILED", clOrdId: item.clOrdId, error: error?.message }); }
      }
      if (item.status === "NOT_CREATED") {
        const row = safeByClOrdId.get(item.clOrdId); const retries = Number(row?.intent.rejectionRetryCount ?? 0);
        if (row && retries < 1) this._deferExit({ ...row.intent, generation: (row.intent.generation ?? 0) + 1, rejectionRetryCount: retries + 1 }, kind, "EXCHANGE_REJECTED_RETRY", 1_000);
        else this._emit({ type: "exit_result", intent: kind, reason: "EXIT_RETRY_EXHAUSTED", okxCode: item.sCode, okxSubCode: item.subCode, clOrdId: item.clOrdId });
      }
    }
    for (const item of response) if (item.status !== "SUBMITTED") this._emit({ type: "exit_result", intent: kind, reason: item.status === "UNKNOWN" ? "EXIT_UNKNOWN" : "EXIT_NOT_CREATED", exchangeReason: item.reason, okxCode: item.sCode, okxSubCode: item.subCode, clOrdId: item.clOrdId });
    const submittedCount = response.filter((item) => item.status === "SUBMITTED").length;
    const batchReason = submittedCount === response.length ? "ORDER_SUBMITTED" : submittedCount > 0 ? "ORDER_PARTIAL" : response.some((item) => item.status === "UNKNOWN") ? "ORDER_UNCONFIRMED" : "ORDER_REJECTED";
    this._emit({ type: "exit_batch", intent: kind, count: safe.length, submittedCount, reason: batchReason });
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
      // Read the original trigger reason from the durable filled_orders row (set once by
      // markSellTriggered, stable across every retry generation of the same exit) rather than
      // reverse-parsing the display-oriented attempt.decision_reason string.
      const reason = source?.sell_trigger_reason ?? source?.sellTriggerReason;
      this.enqueue({ intent: attempt.intent, accountId: attempt.account_id ?? attempt.accountId, instId, baseCcy: attempt.base_ccy ?? attempt.baseCcy, sourceBuyTradeId: attempt.source_buy_trade_id ?? attempt.sourceBuyTradeId, remainingSize: remaining, fillVersion: source.version, generation: Number(attempt.generation) + 1, sellTime: 0, availableBase: remaining, bidPx: quote?.bidPx ?? quote?.last, protection: source?.protection_price ?? source?.protectionPrice, reason, executionMode: source.execution_mode ?? source.executionMode ?? attempt.execution_mode ?? attempt.executionMode, executionRoute: source.execution_route ?? source.executionRoute ?? attempt.execution_route ?? attempt.executionRoute });
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
    const day = normalizeStrategyDay(attempt.strategy_day ?? attempt.strategyDay);
    await this.transaction(async (tx) => {
      for (const fill of fills) await this.state.insertFill(tx, { accountId: attempt.account_id, instId: attempt.inst_id, baseCcy: attempt.base_ccy, tradeId: fill.tradeId, billId: fill.billId, source: "SYSTEM", side: "BUY", fillSize: fill.fillSz, fillTime: fill.fillTime, sourceAttemptClOrdId: attempt.cl_ord_id ?? attempt.clOrdId, fillPrice: fill.fillPx, fee: fill.fee, feeCcy: fill.feeCcy, holdHours: attempt.hold_hours, maxHoldHours: null, strategyConfigHash: attempt.strategy_config_hash, sellTime: panicSellTime({ strategyDay: day, fillTime: fill.fillTime }), forceSellTime: null, sellState: "WAITING", executionMode: attempt.execution_mode ?? attempt.executionMode ?? "cross", executionRoute: attempt.execution_route ?? attempt.executionRoute ?? "margin" });
      await this.orders.markSettled(tx, attempt.cl_ord_id, exchangeState, compareDecimal(accFillSz, "0") > 0 ? "CONVERTED" : "RELEASED");
    });
    this._emit({ type: "trade_lifecycle", reason: "BUY_SETTLED", intent: "BUY", decisionId: attempt.decision_id ?? attempt.decisionId, instId: attempt.inst_id ?? attempt.instId, clOrdId: attempt.cl_ord_id ?? attempt.clOrdId, filledSize: filled, exchangeState, sellTime: fills.length ? Math.min(...fills.map((fill) => panicSellTime({ strategyDay: day, fillTime: fill.fillTime }))) : undefined });
    if (this.onBuySettled) await this.onBuySettled({ attempt, fills, exchangeState, accFillSz });
    return { settled: true };
  }
  _executionMode(intent) {
    const value = intent.executionMode ?? intent.execution_mode ?? (this._executionRoute(intent) ? "cross" : null);
    return value === "cross" || value === "cash" ? value : null;
  }
  _executionRoute(intent) {
    const value = intent.executionRoute ?? intent.execution_route ?? this.executionRoute(intent.instId);
    return value === "margin" || value === "spot" ? value : null;
  }
  _buyGuard(intent) {
    if (intent.generation > 0 && !this.canCreateNextBuy({ previousAttempt: intent.previousAttempt, nextMarketKey: intent.nextMarketKey })) return { allowed: false, reason: "GENERATION_NOT_SETTLED_OR_DUPLICATE", evidence: { previousState: intent.previousAttempt?.state, marketKey: intent.nextMarketKey } };
    const currentMode = this.mode();
    if (currentMode !== "FULL") return { allowed: false, reason: "MODE", evidence: { currentMode } };
    if (!this.ownerGuard.isHeld()) return { allowed: false, reason: "OWNER" };
    const accountFresh = this.account.fresh(this.config.accountFreshMs);
    if (!this.readyGate.ready || !accountFresh) return { allowed: false, reason: "NOT_READY", evidence: { ready: this.readyGate.ready, accountFresh } };
    if (!this.transport.clockFresh(CLOCK_SYNC_STALE_AFTER_MS)) return { allowed: false, reason: "CLOCK_SYNC_STALE", evidence: { clockSkewMs: this.transport.clockSkewMs } };
    const exchangeNowMs = this.clock.nowMs() + Number(this.transport.clockSkewMs ?? 0);
    if (!intent.strategyDay || strategyDay(exchangeNowMs) !== intent.strategyDay) return { allowed: false, reason: "STRATEGY_DAY_CHANGED", evidence: { currentDay: strategyDay(exchangeNowMs) } };
    // From the close-sell minute on, the day's capital is being returned by
    // its own exits; buying again would recycle it into an overnight position.
    if (exchangeNowMs >= strategyDayCloseSellMs(intent.strategyDay)) return { allowed: false, reason: "DAY_CLOSED", evidence: { closeSellAt: strategyDayCloseSellMs(intent.strategyDay) } };
    const quoteStatus = this.market.quoteStatus(intent.instId, this.config.quoteFreshMs, exchangeNowMs); const quote = quoteStatus.quote; const instrument = this.market.instrument(intent.instId);
    const marketEvidence = { quoteAgeMs: quoteStatus.sourceAgeMs, quoteReceiptAgeMs: quoteStatus.receiptAgeMs, quoteSourceAgeMs: quoteStatus.sourceAgeMs, quoteFreshness: quoteStatus.reason, quoteTs: quoteStatus.sourceTs, instrumentState: instrument?.state };
    if (!quoteStatus.fresh || !instrument || instrument.state !== "live" || !intent.limitPrice || !this.isBuyAllowed(intent.instId)) return { allowed: false, reason: "MARKET", evidence: marketEvidence };
    // The limit is the frozen 72% price: never chase above it.  A bounce above
    // the limit drops this intent until the symbol's next qualifying tick.
    const priceEvidence = { last: quote.last, askPx: quote.askPx, limitPrice: intent.limitPrice, priceLimitGap: quote.askPx ? subtractDecimal(intent.limitPrice, quote.askPx) : undefined, ...marketEvidence };
    if (compareDecimal(quote.last, intent.limitPrice) > 0) return { allowed: false, reason: "ABOVE_BUY_PRICE", evidence: priceEvidence };
    if (!quote.askPx || compareDecimal(quote.askPx, intent.limitPrice) > 0) return { allowed: false, reason: "ASK_ABOVE_LIMIT", evidence: priceEvidence };
    return { allowed: true, quote, instrument };
  }
  _exitGuard(intent, kind) {
    if (!this.ownerGuard.isHeld()) return { allowed: false, reason: "OWNER" };
    const exitReady = this.readyGate.exitReady ?? this.readyGate.ready;
    if (!exitReady || !this.account.fresh(this.config.accountFreshMs)) return { allowed: false, reason: "NOT_READY" };
    const instrument = this.market.instrument(intent.instId);
    if (!instrument || (kind !== "DELIST" && instrument.state !== "live")) return { allowed: false, reason: "INSTRUMENT_NOT_TRADABLE" };
    if (intent.pendingAccountSell) return { allowed: false, reason: "ACCOUNT_SELL_PENDING" };
    if (this.isolatedBases.has(intent.baseCcy)) return { allowed: false, reason: "EXIT_BASE_ISOLATED" };
    if (!intent.remainingSize || compareDecimal(intent.remainingSize, "0") <= 0) return { allowed: false, reason: "EXIT_REMAINING_CHANGED" };
    return { allowed: true };
  }
}

export { PRIORITY, terminal };
