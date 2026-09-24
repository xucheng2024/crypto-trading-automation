import { compareDecimal, multiplyDecimal, roundToStep, subtractDecimal } from "../decimal.js";

const field = (row, snake, camel) => row[snake] ?? row[camel];
const SELL_OVERDUE_MS = 60_000;
const STALLED_EXIT_MS = 30_000;

/**
 * Panic-rebound exits are purely time based: every WAITING BUY fill is market
 * sold once its durable sell_time (day close, or fill + minimum hold) passes.
 * There is no stop loss, take profit or price-conditioned deferral.
 *
 * The boundary stays split: the observe and review methods only touch memory and return
 * critical events; consume runs later and is the only durable writer.
 */
export class SellService {
  constructor({ state, transaction = async (fn) => fn(null), coordinator, market, clock = { nowMs: () => Date.now() }, exchangeNowMs = () => clock.nowMs(), isDelisting = () => false, telemetry = () => {}, loadFill = async (_tx, key) => this.fills.get(key) }) {
    Object.assign(this, { state, transaction, coordinator, market, clock, exchangeNowMs, isDelisting, telemetry, loadFill });
    this.fills = new Map(); this.byInst = new Map(); this.latches = new Map();
  }
  key(fill) { return `${field(fill, "account_id", "accountId")}:${field(fill, "inst_id", "instId")}:${field(fill, "trade_id", "tradeId")}`; }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* best effort */ } }
  _latch(key, atMs = this.clock.nowMs()) { this.latches.set(key, atMs); }
  releaseLatch(event, reason) {
    if (event?.type !== "SELL_BREACH" || !event.key) return false;
    const released = this.latches.delete(event.key);
    if (released) this._emit({ type: "sell_trigger_retry", reason, instId: event.instId, key: event.key });
    return released;
  }
  // The coordinator has no memory of its own for a fill's sell_state: this is
  // the only place DUST_PENDING (written durably by prepareExits/markDust)
  // gets reflected back into the in-memory watch, and it is the only place a
  // dust key's stale latch is cleared so a later reviewDust() retry can arm.
  applyDust(row) {
    if (!row) return;
    const key = this.key(row);
    this.fills.set(key, row);
    this.latches.delete(key);
  }
  noteRetry(event, reason, delayMs) {
    this._emit({ type: "sell_trigger_retry", reason: "SELL_EVENT_RETRY_SCHEDULED", retryReason: reason, retryCount: event.retryCount, delayMs, instId: event.instId, key: event.key });
  }
  rebuild(fills) {
    this.fills.clear(); this.byInst.clear(); this.latches.clear();
    const snapshot = { total: 0, instruments: new Set(), waiting: 0, triggered: 0, dustPending: 0 };
    for (const fill of fills) {
      if (field(fill, "side", "side") !== "BUY" || !["WAITING", "SELL_TRIGGERED", "DUST_PENDING"].includes(field(fill, "sell_state", "sellState"))) continue;
      const key = this.key(fill); this.fills.set(key, { ...fill });
      const instId = field(fill, "inst_id", "instId"); const rows = this.byInst.get(instId) ?? []; rows.push(key); this.byInst.set(instId, rows);
      snapshot.total += 1; snapshot.instruments.add(instId);
      if (field(fill, "sell_state", "sellState") === "WAITING") snapshot.waiting += 1;
      else if (field(fill, "sell_state", "sellState") === "SELL_TRIGGERED") snapshot.triggered += 1;
      else snapshot.dustPending += 1;
    }
    this._emit({ type: "sell_watch_loaded", reason: "SELL_WATCH_SNAPSHOT", total: snapshot.total, instruments: snapshot.instruments.size, waiting: snapshot.waiting, triggered: snapshot.triggered, dustPending: snapshot.dustPending });
  }
  _resumeEvent(key, fill) {
    return { type: "SELL_BREACH", priority: "critical", key, instId: field(fill, "inst_id", "instId"), reason: field(fill, "sell_trigger_reason", "sellTriggerReason") ?? "SCHEDULED_CLOSE", resumed: true };
  }
  resumeTriggered(activeSourceTradeIds = new Set()) {
    const events = [];
    for (const [key, fill] of this.fills) {
      const tradeId = field(fill, "trade_id", "tradeId");
      if (field(fill, "sell_state", "sellState") !== "SELL_TRIGGERED" || activeSourceTradeIds.has(tradeId) || this.latches.has(key)) continue;
      this._latch(key); events.push(this._resumeEvent(key, fill));
    }
    return events;
  }
  // An exit whose Coordinator retries were exhausted keeps its latch but has
  // no pending intent and no active attempt.  Re-drive it here instead of
  // waiting for the next periodic reconciliation to rebuild the watch.
  hasTriggered() { for (const fill of this.fills.values()) if (field(fill, "sell_state", "sellState") === "SELL_TRIGGERED") return true; return false; }
  resumeStalled({ activeSourceTradeIds = new Set(), pendingSourceTradeIds = new Set(), nowMs = this.clock.nowMs() } = {}) {
    const events = [];
    for (const [key, fill] of this.fills) {
      const tradeId = field(fill, "trade_id", "tradeId"); const latchedAt = this.latches.get(key);
      if (field(fill, "sell_state", "sellState") !== "SELL_TRIGGERED" || activeSourceTradeIds.has(tradeId) || pendingSourceTradeIds.has(tradeId)) continue;
      if (latchedAt !== undefined && nowMs - latchedAt < STALLED_EXIT_MS) continue;
      this._latch(key, nowMs); events.push(this._resumeEvent(key, fill));
      this._emit({ type: "sell_trigger_retry", reason: "SELL_EXIT_STALL_RECOVERED", instId: field(fill, "inst_id", "instId"), sourceBuyTradeId: tradeId });
    }
    return events;
  }
  _dueEvents(keys, nowMs) {
    const events = [];
    for (const key of keys) {
      const fill = this.fills.get(key);
      // DUST_PENDING is owned exclusively by reviewDust(): it decides
      // sellability from remaining size/notional, not from time alone.
      if (!fill || field(fill, "sell_state", "sellState") !== "WAITING" || this.latches.has(key)) continue;
      const sellTime = Number(field(fill, "sell_time", "sellTime"));
      if (!Number.isFinite(sellTime) || sellTime > nowMs) continue;
      this._latch(key); // must happen before event enqueue / any await
      events.push({ type: "SELL_BREACH", priority: "critical", key, instId: field(fill, "inst_id", "instId"), reason: "SCHEDULED_CLOSE", sellTime });
    }
    return events;
  }
  observeTicker(instId) { return this._dueEvents(this.byInst.get(instId) ?? [], this.exchangeNowMs()); }
  reviewDueWatches() { return this._dueEvents([...this.fills.keys()], this.exchangeNowMs()); }
  protectionHealth() {
    const nowMs = this.exchangeNowMs(); let overdue = 0;
    for (const fill of this.fills.values()) {
      const sellTime = Number(field(fill, "sell_time", "sellTime"));
      if (["WAITING", "SELL_TRIGGERED"].includes(field(fill, "sell_state", "sellState")) && Number.isFinite(sellTime) && nowMs - sellTime > SELL_OVERDUE_MS) overdue += 1;
    }
    // anchor_due_unprotected_current keeps the existing sell alert wired to
    // the one exit failure this strategy can have: a close that has not sold.
    return { sell_overdue_current: overdue, anchor_due_unprotected_current: overdue };
  }
  async consume(event) {
    if (event.type !== "SELL_BREACH") return { accepted: false, reason: "UNSUPPORTED" };
    const fill = await this.transaction((tx) => this.loadFill(tx, event.key));
    if (!fill) { this.releaseLatch(event, "FILL_MISSING"); return { accepted: false, reason: "FILL_MISSING" }; }
    const accountId = field(fill, "account_id", "accountId"); const instId = field(fill, "inst_id", "instId"); const tradeId = field(fill, "trade_id", "tradeId");
    const sellState = field(fill, "sell_state", "sellState");
    if (sellState === "SOLD") { this.releaseLatch(event, "FILL_SOLD"); return { accepted: false, reason: "FILL_SOLD" }; }
    if (sellState === "SELL_TRIGGERED") return this._enqueueTriggered(fill, event);
    const result = await this.transaction((tx) => this.state.markSellTriggered(tx, { accountId, instId, tradeId, version: fill.version, protectionPrice: null, sellTriggerReason: event.reason ?? "SCHEDULED_CLOSE" }));
    if (result?.rowCount !== 1) return { accepted: false, reason: "CAS_LOST", retryable: true };
    const current = result.rows?.[0] ?? { ...fill, sell_state: "SELL_TRIGGERED", sell_trigger_reason: event.reason ?? "SCHEDULED_CLOSE", version: BigInt(fill.version) + 1n };
    this.fills.set(event.key, current);
    const queued = this._enqueueTriggered(current, event);
    if (!queued.accepted) return queued;
    this._emit({ type: "sell_triggered", reason: "SELL_TRIGGERED", triggerReason: event.reason ?? "SCHEDULED_CLOSE", instId, sourceBuyTradeId: tradeId, sellTime: field(fill, "sell_time", "sellTime") });
    return { accepted: true, reason: "SELL_TRIGGERED" };
  }
  _enqueueTriggered(fill, event) {
    const accountId = field(fill, "account_id", "accountId"); const instId = field(fill, "inst_id", "instId"); const tradeId = field(fill, "trade_id", "tradeId");
    const quote = this.market.ticker(instId);
    // An instrument under active delist protection is no longer "live", so
    // _exitGuard only accepts a DELIST-kind attempt for it — a fill reclaimed
    // here while delisting must route the same way or it can never sell.
    const intentKind = this.isDelisting(instId) ? "DELIST" : "SELL";
    const accepted = this.coordinator.enqueue({ intent: intentKind, accountId, instId, baseCcy: field(fill, "base_ccy", "baseCcy"), sourceBuyTradeId: tradeId, remainingSize: subtractDecimal(field(fill, "fill_size", "fillSize"), field(fill, "disposed_size", "disposedSize") ?? "0"), fillVersion: fill.version, sellTime: Number(field(fill, "sell_time", "sellTime")), availableBase: fill.availableBase, bidPx: quote?.bidPx ?? quote?.last, protection: fill.protection_price ?? undefined, reason: event.reason ?? field(fill, "sell_trigger_reason", "sellTriggerReason"), triggerPrice: quote?.bidPx ?? quote?.last, quoteTs: quote?.ts, executionMode: field(fill, "execution_mode", "executionMode"), executionRoute: field(fill, "execution_route", "executionRoute") });
    if (!accepted) {
      this._emit({ type: "sell_trigger_retry", reason: "COORDINATOR_REJECTED", instId, sourceBuyTradeId: tradeId });
      return { accepted: false, reason: "COORDINATOR_REJECTED", retryable: true };
    }
    if (event.resumed) this._emit({ type: "sell_trigger_retry", reason: "SELL_TRIGGERED_RESUMED", instId, sourceBuyTradeId: tradeId });
    return { accepted: true, reason: event.resumed ? "SELL_TRIGGERED_RESUMED" : "SELL_TRIGGERED" };
  }
  async reviewDust() {
    for (const [key, fill] of this.fills) {
      if (field(fill, "sell_state", "sellState") !== "DUST_PENDING") continue;
      const instId = field(fill, "inst_id", "instId"); const instrument = this.market.instrument(instId); const quoteStatus = this.market.quoteStatus(instId, this.market.quoteFreshMs ?? 30_000, this.exchangeNowMs()); const quote = quoteStatus.fresh ? quoteStatus.quote : null;
      const remaining = subtractDecimal(field(fill, "fill_size", "fillSize"), field(fill, "disposed_size", "disposedSize") ?? "0");
      if (instrument && quote && compareDecimal(roundToStep(remaining, instrument.lotSz, "down"), instrument.minSz) >= 0 && compareDecimal(multiplyDecimal(remaining, quote.bidPx ?? quote.last), "0.1") >= 0) {
        this._latch(key); await this.consume({ type: "SELL_BREACH", key, instId, reason: field(fill, "sell_trigger_reason", "sellTriggerReason") ?? "SCHEDULED_CLOSE" });
      }
    }
  }
}
