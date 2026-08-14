import { compareDecimal, divideDecimal, multiplyDecimal, parseDecimal, formatDecimal, roundToStep } from "../decimal.js";
import { BUY_ADMISSION_LEVERAGE, TRADE_FEE_RATE, adjustedEquity, assessLeverage, buySignal } from "../domain/rules.js";
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
  constructor({ transaction, orders, state, transport, ownerGuard, readyGate, market, account, mode = () => "OFF", isBuyAllowed = () => true, clock = { nowMs: () => Date.now() }, config, telemetry = () => {} }) {
    Object.assign(this, { transaction, orders, state, transport, ownerGuard, readyGate, market, account, mode, isBuyAllowed, clock, config, telemetry });
    this.pending = { BUY: new Map(), SELL: new Map(), DELIST: new Map() }; this.submitting = false;
  }
  enqueue(intent) { const group = this.pending[intent.intent]; if (!group) throw new Error("unknown intent"); const key = intent.intent === "BUY" ? intent.instId : `${intent.baseCcy}:${intent.sourceBuyTradeId}`; group.set(key, intent); }
  canCreateNextBuy({ previousAttempt, nextMarketKey }) {
    return previousAttempt?.state === "SETTLED" && Boolean(nextMarketKey) && nextMarketKey !== previousAttempt.decision_market_key;
  }
  async drainOnce() {
    if (this.submitting) return { submitted: false, reason: "SLOT_BUSY" };
    const kind = ["DELIST", "SELL", "BUY"].find((name) => this.pending[name].size);
    if (!kind) return { submitted: false, reason: "EMPTY" };
    if (kind !== "BUY") return { submitted: false, reason: "P2_BUY_ONLY" };
    const candidates = [...this.pending.BUY.values()].sort((a, b) => a.generation - b.generation || a.eligibleSince - b.eligibleSince || a.instId.localeCompare(b.instId)).slice(0, 5);
    const prepared = await this.prepareBuys(candidates);
    if (!prepared.length) return { submitted: false, reason: "NO_ELIGIBLE" };
    if (this.pending.DELIST.size || this.pending.SELL.size) return { submitted: false, reason: "PREEMPTED" };
    this.submitting = true;
    try { return await this.submitBuys(prepared); } finally { this.submitting = false; }
  }
  async prepareBuys(candidates) {
    const riskVersion = this.account.value?.version ?? 0;
    const eligible = candidates.filter((intent) => (!intent.waitForRiskVersion || riskVersion > intent.waitForRiskVersion) && this.#buyGuard(intent).allowed);
    if (!eligible.length) return [];
    const avail = await this.transport.maxAvailSize(eligible.map((item) => item.instId).join(","));
    const byInst = new Map((avail ?? []).map((row) => [row.instId, row.availBuy]));
    return eligible.flatMap((intent) => {
      const availBuy = byInst.get(intent.instId);
      const available = availBuy && compareDecimal(availBuy, "0") > 0;
      if (!available) {
        intent.waitForRiskVersion = riskVersion;
        this.telemetry({ type: "buy_deferred", reason: "INSUFFICIENT_FUNDS_WAIT_RISK_VERSION", instId: intent.instId, riskVersion });
      }
      return available ? [{ ...intent, availBuy }] : [];
    });
  }
  async submitBuys(candidates) {
    let prepared;
    try {
      prepared = await this.transaction(async (tx) => {
      const rows = [];
      for (const intent of candidates) {
        const guard = this.#buyGuard(intent);
        if (!guard.allowed) continue;
        const instrument = this.market.instrument(intent.instId); const quote = this.market.ticker(intent.instId); const candle = this.market.candle(intent.instId);
        const executionPrice = roundToStep(intent.dailyLimitPrice, instrument.tickSz, "down");
        if (compareDecimal(quote.askPx, executionPrice) > 0) continue;
        const frozenTarget = intent.frozenTargetUsd ?? this.account.value.totalEq;
        const remainingTarget = intent.remainingTargetUsd ?? frozenTarget;
        const maxNotional = min(remainingTarget, intent.availBuy, this.#remainingCapacity());
        const size = roundToStep(divideDecimal(maxNotional, multiplyDecimal(executionPrice, `1${TRADE_FEE_RATE}`)), instrument.lotSz, "down");
        if (compareDecimal(size, instrument.minSz) < 0) continue;
        const payload = { instId: intent.instId, tdMode: "cross", side: "buy", ordType: "ioc", px: executionPrice, sz: size, tag: this.config.strategyTag, ...(intent.tradeQuoteCcy ? { tradeQuoteCcy: intent.tradeQuoteCcy } : {}) };
        const tuple = { instId: intent.instId, strategyDay: intent.strategyDay, generation: intent.generation };
        const clOrdId = await createClOrdId(this.config.orderVersion, "BUY", tuple); payload.clOrdId = clOrdId;
        const hash = await payloadHash(payload); const marketKey = await payloadHash({ quote, candle });
        const attempt = {
          accountId: this.config.accountId, intent: "BUY", instId: intent.instId, baseCcy: instrument.base, clOrdId, payloadHash: hash,
          strategyDay: intent.strategyDay, generation: intent.generation, plannedSize: size, reservedExposureUsd: multiplyDecimal(multiplyDecimal(size, executionPrice), `1${TRADE_FEE_RATE}`),
          frozenTargetUsd: frozenTarget, decisionQuoteTs: quote.ts, decisionQuoteHash: await payloadHash(quote), decisionCandleTs: candle.ts, decisionCandleHash: await payloadHash(candle), decisionMarketKey: marketKey,
          executionLimitPrice: executionPrice, instrumentVersion: String(instrument.version ?? "1"), holdHours: intent.holdHours, strategyConfigHash: intent.configHash,
          admissionEquity: adjustedEquity(this.account.value), admissionExposure: intent.managedExposure ?? "0", accountSnapshotVersion: String(this.account.value.version),
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
        this.telemetry({ type: "buy_replay", reason: "HASH_COLLISION", clOrdId: error.clOrdId });
        throw new Error("HASH_COLLISION");
      }
      this.telemetry({ type: "buy_replay", reason: "COMMIT_ACK_LOST", clOrdId: error.clOrdId, state: existing.state });
      return { submitted: false, reason: "COMMIT_ACK_LOST" };
    }
    if (!prepared.length) return { submitted: false, reason: "RESERVATION_DENIED" };
    const safe = [];
    for (const row of prepared) {
      const guard = this.#buyGuard(row.intent);
      if (!guard.allowed) await this.transaction((tx) => this.orders.markNotCreated(tx, row.attempt.clOrdId, guard.reason));
      else safe.push(row);
    }
    if (!safe.length) return { submitted: false, reason: "FINAL_GUARD" };
    let response;
    try {
      response = await this.transport.submitBatchOrders(safe.map((row) => row.payload), this.clock.nowMs() + this.config.orderExpiryMs);
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
    for (const row of safe) this.pending.BUY.delete(row.intent.instId);
    this.telemetry({ type: "buy_batch", count: safe.length, results: response.map((item) => ({ clOrdId: item.clOrdId, status: item.status })) });
    return { submitted: true, count: safe.length, response };
  }
  async settleBuy({ attempt, fills, exchangeState, accFillSz }) {
    const filled = fills.reduce((sum, fill) => add(sum, fill.fillSz), "0");
    if (compareDecimal(filled, accFillSz) !== 0) return { settled: false, reason: "FILLS_INCOMPLETE" };
    await this.transaction(async (tx) => {
      for (const fill of fills) await this.state.insertFill(tx, { accountId: attempt.account_id, instId: attempt.inst_id, baseCcy: attempt.base_ccy, tradeId: fill.tradeId, source: "SYSTEM", side: "BUY", fillSize: fill.fillSz, fillTime: fill.fillTime, holdHours: attempt.hold_hours, strategyConfigHash: attempt.strategy_config_hash, sellTime: Number(fill.fillTime) + Number(attempt.hold_hours) * 3_600_000, sellState: "WAITING" });
      await this.orders.markSettled(tx, attempt.cl_ord_id, exchangeState, compareDecimal(accFillSz, "0") > 0 ? "CONVERTED" : "RELEASED");
    });
    return { settled: true };
  }
  #remainingCapacity() { const snapshot = this.account.value; if (!snapshot) return "0"; const equity = adjustedEquity(snapshot); return multiplyDecimal(BUY_ADMISSION_LEVERAGE, equity); }
  #buyGuard(intent) {
    if (intent.generation > 0 && !this.canCreateNextBuy({ previousAttempt: intent.previousAttempt, nextMarketKey: intent.nextMarketKey })) return { allowed: false, reason: "GENERATION_NOT_SETTLED_OR_DUPLICATE" };
    if (this.mode() !== "FULL") return { allowed: false, reason: "MODE" };
    if (!this.ownerGuard.isHeld()) return { allowed: false, reason: "OWNER" };
    if (!this.readyGate.ready || !this.account.fresh(this.config.accountFreshMs)) return { allowed: false, reason: "NOT_READY" };
    const quote = this.market.freshQuote(intent.instId, this.config.quoteFreshMs); const candle = this.market.candle(intent.instId); const instrument = this.market.instrument(intent.instId);
    if (!quote || !candle || !instrument || instrument.state !== "live" || intent.protected || intent.enabled === false || intent.dailyReady === false || !this.isBuyAllowed(intent.instId)) return { allowed: false, reason: "MARKET" };
    const risk = assessLeverage({ committedExposure: intent.managedExposure ?? "0", ...this.account.value });
    if (risk.hardStopped) return { allowed: false, reason: "HARD_STOP" };
    const signal = buySignal({ last: quote.last, askPx: quote.askPx, limitPrice: roundToStep(intent.dailyLimitPrice, instrument.tickSz, "down"), previousClosedOpen: candle.open });
    return signal.eligible ? { allowed: true } : { allowed: false, reason: signal.reason };
  }
}

export { PRIORITY, terminal };
