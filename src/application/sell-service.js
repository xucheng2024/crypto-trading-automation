import { compareDecimal, multiplyDecimal, roundToStep, subtractDecimal } from "../decimal.js";
import { candleFreshness, sellBreakdownPrice, takeProfitPrice } from "../domain/rules.js";

const field = (row, snake, camel) => row[snake] ?? row[camel];

/**
 * SELL watch has a deliberately split boundary. observe* is safe in a WS
 * callback: it touches only the projection/index and returns a critical event.
 * consume* runs later and is the only part that reads/writes durable state.
 */
export class SellService {
  constructor({ state, transaction = async (fn) => fn(null), coordinator, market, clock = { nowMs: () => Date.now() }, exchangeNowMs = () => clock.nowMs(), clockFresh = () => true, triggerClockSync = () => {}, refreshCandle = async () => {}, isDelisting = () => false, telemetry = () => {}, loadFill = async (_tx, key) => this.fills.get(key) }) {
    Object.assign(this, { state, transaction, coordinator, market, clock, exchangeNowMs, clockFresh, triggerClockSync, refreshCandle, isDelisting, telemetry, loadFill });
    this.fills = new Map(); this.byInst = new Map(); this.latches = new Set(); this.candleRefreshes = new Set(); this.clockSyncStale = false;
  }
  key(fill) { return `${field(fill, "account_id", "accountId")}:${field(fill, "inst_id", "instId")}:${field(fill, "trade_id", "tradeId")}`; }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* best effort */ } }
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
  resumeTriggered(activeSourceTradeIds = new Set()) {
    const events = [];
    for (const [key, fill] of this.fills) {
      const tradeId = field(fill, "trade_id", "tradeId");
      if (field(fill, "sell_state", "sellState") !== "SELL_TRIGGERED" || activeSourceTradeIds.has(tradeId) || this.latches.has(key)) continue;
      this.latches.add(key);
      const reason = field(fill, "sell_trigger_reason", "sellTriggerReason") ?? "PRICE_BREAKDOWN";
      const fillPrice = field(fill, "fill_price", "fillPrice");
      const referencePrice = reason === "TAKE_PROFIT" && fillPrice ? takeProfitPrice(fillPrice) : undefined;
      events.push({ type: "SELL_BREACH", priority: "critical", key, instId: field(fill, "inst_id", "instId"), protection: fill.protection_price, referencePrice, reason, resumed: true });
    }
    return events;
  }
  resumeForceHold(activeSourceTradeIds = new Set()) {
    const events = [];
    for (const [key, fill] of this.fills) {
      const tradeId = field(fill, "trade_id", "tradeId"); const forceSellTime = field(fill, "force_sell_time", "forceSellTime");
      if (field(fill, "sell_state", "sellState") !== "WAITING" || activeSourceTradeIds.has(tradeId) || this.latches.has(key) || forceSellTime == null || Number(forceSellTime) > this.clock.nowMs()) continue;
      this.latches.add(key);
      events.push({ type: "SELL_BREACH", priority: "critical", key, instId: field(fill, "inst_id", "instId"), protection: fill.protection_price ?? fill.protectionPrice ?? null, reason: "MAX_HOLD_EXPIRED", resumed: true });
    }
    return events;
  }
  checkForceHold(instId, nowMs = this.clock.nowMs()) {
    const events = [];
    for (const key of this.byInst.get(instId) ?? []) {
      const fill = this.fills.get(key); const forceSellTime = field(fill ?? {}, "force_sell_time", "forceSellTime");
      if (!fill || field(fill, "sell_state", "sellState") !== "WAITING" || forceSellTime == null || Number(forceSellTime) > nowMs || this.latches.has(key)) continue;
      this.latches.add(key);
      events.push({ type: "SELL_BREACH", priority: "critical", key, instId, protection: fill.protection_price ?? fill.protectionPrice ?? null, reason: "MAX_HOLD_EXPIRED" });
    }
    return events;
  }
  reviewForceHold() {
    const events = []; const nowMs = this.clock.nowMs();
    for (const instId of this.byInst.keys()) events.push(...this.checkForceHold(instId, nowMs));
    return events;
  }
  observeCandle(instId) {
    const candle = this.market.candle(instId); const instrument = this.market.instrument(instId);
    if (!instrument) return [];
    if (!this.clockFresh()) {
      if (!this.clockSyncStale) {
        this.clockSyncStale = true;
        this._emit({ type: "sell_protection", reason: "SELL_CLOCK_SYNC_STALE", instId });
        try { Promise.resolve(this.triggerClockSync()).catch(() => {}); } catch { /* best effort */ }
      }
      return this.observeTicker(instId);
    }
    this.clockSyncStale = false;
    const freshness = candleFreshness({ candle, exchangeNowMs: this.exchangeNowMs() });
    if (freshness.state !== "FRESH") {
      const reason = freshness.state === "PENDING" ? "SELL_CANDLE_PENDING" : freshness.state === "MISSING" ? "SELL_CANDLE_MISSING" : "SELL_CANDLE_STALE";
      const fills = [...(this.byInst.get(instId) ?? [])].map((key) => this.fills.get(key)).filter(Boolean);
      this._emit({ type: "sell_protection", reason, instId, candleTs: candle?.ts, expectedTs: freshness.expectedTs, age: freshness.age });
      for (const fill of fills) if (!fill.protection_price) this._emit({ type: "sell_protection", reason: "SELL_PROTECTION_UNARMED", instId, sourceBuyTradeId: field(fill, "trade_id", "tradeId") });
      this._refreshCandle(instId);
      return this.observeTicker(instId);
    }
    const events = [];
    for (const key of this.byInst.get(instId) ?? []) {
      const fill = this.fills.get(key); if (!fill || Number(field(fill, "sell_time", "sellTime")) > this.clock.nowMs()) continue;
      const protection = sellBreakdownPrice(candle.low);
      if (!fill.protection_price || compareDecimal(protection, fill.protection_price) > 0) {
        events.push({ type: "SELL_PROTECTION", key, instId, protection, candleTs: candle.ts, previousClosedLow: candle.low });
      }
    }
    return [...events, ...this.observeTicker(instId)];
  }
  reviewCandleFreshness() {
    for (const instId of this.byInst.keys()) {
      const freshness = candleFreshness({ candle: this.market.candle(instId), exchangeNowMs: this.exchangeNowMs() });
      if (freshness.state === "FRESH") continue;
      const reason = freshness.state === "PENDING" ? "SELL_CANDLE_PENDING" : freshness.state === "MISSING" ? "SELL_CANDLE_MISSING" : "SELL_CANDLE_STALE";
      this._emit({ type: "sell_protection", reason, instId, candleTs: this.market.candle(instId)?.ts, expectedTs: freshness.expectedTs, age: freshness.age });
      for (const key of this.byInst.get(instId) ?? []) {
        const fill = this.fills.get(key);
        if (fill && !fill.protection_price) this._emit({ type: "sell_protection", reason: "SELL_PROTECTION_UNARMED", instId, sourceBuyTradeId: field(fill, "trade_id", "tradeId") });
      }
      this._refreshCandle(instId);
    }
  }
  _refreshCandle(instId) {
    if (this.candleRefreshes.has(instId)) return;
    this.candleRefreshes.add(instId);
    try {
      Promise.resolve(this.refreshCandle(instId)).catch((error) => this._emit({ type: "sell_protection", reason: "SELL_CANDLE_REFRESH_FAILED", instId, error: error?.message })).finally(() => this.candleRefreshes.delete(instId));
    } catch (error) {
      this.candleRefreshes.delete(instId); this._emit({ type: "sell_protection", reason: "SELL_CANDLE_REFRESH_FAILED", instId, error: error?.message });
    }
  }
  observeTicker(instId) {
    const quote = this.market.freshQuote(instId, this.market.quoteFreshMs ?? 30_000);
    const events = [];
    // Requires a fresh quote *and* an actual bidPx — no `?? last` fallback. A market SELL
    // fills against the bid; falling back to `last` when bidPx is missing would trigger on
    // a price nobody can actually sell at. Missing bidPx just waits for the next full quote.
    if (quote && quote.bidPx) {
      for (const key of this.byInst.get(instId) ?? []) {
        const fill = this.fills.get(key); const state = fill && field(fill, "sell_state", "sellState");
        // Only WAITING fills — never re-evaluate an already SELL_TRIGGERED fill here. If its
        // latch was released (queue-full retry, restart) it must be re-armed by
        // resumeTriggered() from the durable sell_trigger_reason, never relabeled TAKE_PROFIT
        // just because price happens to be up when it's re-scanned for an unrelated reason.
        if (!fill || state !== "WAITING" || this.latches.has(key)) continue;
        const fillPrice = field(fill, "fill_price", "fillPrice");
        const takeProfit = fillPrice ? takeProfitPrice(fillPrice) : null;
        if (!takeProfit || compareDecimal(quote.bidPx, takeProfit) < 0) continue;
        this.latches.add(key); // must happen before event enqueue / any await
        // Never write fillPrice*1.20 into `protection` — that field is durably persisted
        // as filled_orders.protection_price (the downside trailing floor) by consume();
        // the take-profit target only travels as referencePrice for decision evidence.
        events.push({ type: "SELL_BREACH", priority: "critical", key, instId, protection: fill.protection_price, referencePrice: takeProfit, triggerPrice: quote.bidPx, quoteTs: quote.ts, reason: "TAKE_PROFIT" });
      }
    }
    events.push(...this.checkForceHold(instId, this.clock.nowMs()));
    if (!quote) return events;
    for (const key of this.byInst.get(instId) ?? []) {
      const fill = this.fills.get(key); const state = fill && field(fill, "sell_state", "sellState");
      // DUST_PENDING is owned exclusively by reviewDust(): it decides
      // sellability from remaining size/notional, not from price alone.
      if (!fill || state === "SOLD" || state === "DUST_PENDING" || Number(field(fill, "sell_time", "sellTime")) > this.clock.nowMs() || !fill.protection_price || compareDecimal(quote.last, fill.protection_price) >= 0 || this.latches.has(key)) continue;
      this.latches.add(key); // must happen before event enqueue / any await
      events.push({ type: "SELL_BREACH", priority: "critical", key, instId, protection: fill.protection_price, triggerPrice: quote.last, quoteTs: quote.ts, reason: "PRICE_BREAKDOWN" });
    }
    return events;
  }
  async consume(event) {
    const fill = await this.transaction((tx) => this.loadFill(tx, event.key));
    if (!fill) { this.releaseLatch(event, "FILL_MISSING"); return { accepted: false, reason: "FILL_MISSING" }; }
    const accountId = field(fill, "account_id", "accountId"); const instId = field(fill, "inst_id", "instId"); const tradeId = field(fill, "trade_id", "tradeId");
    if (event.type === "SELL_PROTECTION") {
      const result = await this.transaction((tx) => this.state.raiseProtection(tx, { accountId, instId, tradeId, version: fill.version, protectionPrice: event.protection }));
      if (result?.rowCount === 1) {
        const current = result.rows?.[0] ?? { ...fill, protection_price: event.protection, version: BigInt(fill.version) + 1n };
        this.fills.set(event.key, current);
        this._emit({ type: "sell_watch_armed", reason: "SELL_WATCH_ARMED", instId, sourceBuyTradeId: tradeId, sellTime: field(fill, "sell_time", "sellTime"), candleTs: event.candleTs, previousClosedLow: event.previousClosedLow, breakdownPrice: event.protection });
      }
      if (result?.rowCount !== 1) return { accepted: false, reason: "CAS_LOST", retryable: true };
      return { accepted: true, reason: "PROTECTION_UPDATED" };
    }
    if (event.type !== "SELL_BREACH") return { accepted: false, reason: "UNSUPPORTED" };
    const sellState = field(fill, "sell_state", "sellState");
    if (sellState === "SOLD") { this.releaseLatch(event, "FILL_SOLD"); return { accepted: false, reason: "FILL_SOLD" }; }
    if (sellState === "SELL_TRIGGERED") return this._enqueueTriggered(fill, event);
    const result = await this.transaction((tx) => this.state.markSellTriggered(tx, { accountId, instId, tradeId, version: fill.version, protectionPrice: event.protection, sellTriggerReason: event.reason ?? "PRICE_BREAKDOWN" }));
    if (result?.rowCount !== 1) return { accepted: false, reason: "CAS_LOST", retryable: true };
    const current = result.rows?.[0] ?? { ...fill, sell_state: "SELL_TRIGGERED", protection_price: event.protection, version: BigInt(fill.version) + 1n };
    this.fills.set(event.key, current);
    const queued = this._enqueueTriggered(current, event);
    if (!queued.accepted) return queued;
    this._emit({ type: "sell_triggered", reason: "SELL_TRIGGERED", instId, sourceBuyTradeId: tradeId, breakdownPrice: event.protection, triggerPrice: event.triggerPrice, quoteTs: event.quoteTs });
    return { accepted: true, reason: "SELL_TRIGGERED" };
  }
  _enqueueTriggered(fill, event) {
    const accountId = field(fill, "account_id", "accountId"); const instId = field(fill, "inst_id", "instId"); const tradeId = field(fill, "trade_id", "tradeId");
    const quote = this.market.ticker(instId);
    // An instrument under active delist protection is no longer "live", so
    // _exitGuard only accepts a DELIST-kind attempt for it — a fill reclaimed
    // here while delisting must route the same way or it can never sell.
    const intentKind = this.isDelisting(instId) ? "DELIST" : "SELL";
    const accepted = this.coordinator.enqueue({ intent: intentKind, accountId, instId, baseCcy: field(fill, "base_ccy", "baseCcy"), sourceBuyTradeId: tradeId, remainingSize: subtractDecimal(field(fill, "fill_size", "fillSize"), field(fill, "disposed_size", "disposedSize") ?? "0"), fillVersion: fill.version, sellTime: Number(field(fill, "sell_time", "sellTime")), availableBase: fill.availableBase, bidPx: quote?.bidPx ?? quote?.last, protection: event.protection ?? fill.protection_price, referencePrice: event.referencePrice, reason: event.reason, triggerPrice: event.triggerPrice, quoteTs: event.quoteTs, executionMode: field(fill, "execution_mode", "executionMode"), executionRoute: field(fill, "execution_route", "executionRoute") });
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
      const instId = field(fill, "inst_id", "instId"); const instrument = this.market.instrument(instId); const quote = this.market.freshQuote(instId, this.market.quoteFreshMs ?? 30_000);
      const remaining = subtractDecimal(field(fill, "fill_size", "fillSize"), field(fill, "disposed_size", "disposedSize") ?? "0");
      if (instrument && quote && compareDecimal(roundToStep(remaining, instrument.lotSz, "down"), instrument.minSz) >= 0 && compareDecimal(multiplyDecimal(remaining, quote.bidPx ?? quote.last), "0.1") >= 0) {
        this.latches.add(key); await this.consume({ type: "SELL_BREACH", key, instId, protection: fill.protection_price });
      }
    }
  }
}
