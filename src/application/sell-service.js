import { compareDecimal, multiplyDecimal, roundToStep, subtractDecimal } from "../decimal.js";

const field = (row, snake, camel) => row[snake] ?? row[camel];

/**
 * SELL watch has a deliberately split boundary. observe* is safe in a WS
 * callback: it touches only the projection/index and returns a critical event.
 * consume* runs later and is the only part that reads/writes durable state.
 */
export class SellService {
  constructor({ state, transaction = async (fn) => fn(null), coordinator, market, clock = { nowMs: () => Date.now() }, telemetry = () => {}, loadFill = async (_tx, key) => this.fills.get(key) }) {
    Object.assign(this, { state, transaction, coordinator, market, clock, telemetry, loadFill });
    this.fills = new Map(); this.byInst = new Map(); this.latches = new Set();
  }
  key(fill) { return `${field(fill, "account_id", "accountId")}:${field(fill, "inst_id", "instId")}:${field(fill, "trade_id", "tradeId")}`; }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* best effort */ } }
  rebuild(fills) {
    this.fills.clear(); this.byInst.clear(); this.latches.clear();
    for (const fill of fills) {
      if (field(fill, "side", "side") !== "BUY" || !["WAITING", "SELL_TRIGGERED", "DUST_PENDING"].includes(field(fill, "sell_state", "sellState"))) continue;
      const key = this.key(fill); this.fills.set(key, { ...fill });
      const instId = field(fill, "inst_id", "instId"); const rows = this.byInst.get(instId) ?? []; rows.push(key); this.byInst.set(instId, rows);
    }
  }
  observeCandle(instId) {
    const candle = this.market.candle(instId); const instrument = this.market.instrument(instId);
    if (!candle || !candle.confirm || !instrument) return [];
    const events = [];
    for (const key of this.byInst.get(instId) ?? []) {
      const fill = this.fills.get(key); if (!fill || Number(field(fill, "sell_time", "sellTime")) > this.clock.nowMs()) continue;
      const protection = roundToStep(candle.low, instrument.tickSz, "up");
      // Same-ts correction and later candles can only raise the in-memory
      // candidate. Durable max() happens in consumeProtection.
      if (!fill.protection_price || compareDecimal(protection, fill.protection_price) > 0) {
        fill.protection_price = protection; events.push({ type: "SELL_PROTECTION", key, instId, protection });
      }
    }
    return [...events, ...this.observeTicker(instId)];
  }
  observeTicker(instId) {
    const quote = this.market.freshQuote(instId, this.market.quoteFreshMs ?? 30_000); if (!quote) return [];
    const events = [];
    for (const key of this.byInst.get(instId) ?? []) {
      const fill = this.fills.get(key); const state = fill && field(fill, "sell_state", "sellState");
      if (!fill || state === "SOLD" || Number(field(fill, "sell_time", "sellTime")) > this.clock.nowMs() || !fill.protection_price || compareDecimal(quote.last, fill.protection_price) > 0 || this.latches.has(key)) continue;
      this.latches.add(key); // must happen before event enqueue / any await
      events.push({ type: "SELL_BREACH", priority: "critical", key, instId, protection: fill.protection_price });
    }
    return events;
  }
  async consume(event) {
    const fill = await this.transaction((tx) => this.loadFill(tx, event.key));
    if (!fill) return { accepted: false, reason: "FILL_MISSING" };
    const accountId = field(fill, "account_id", "accountId"); const instId = field(fill, "inst_id", "instId"); const tradeId = field(fill, "trade_id", "tradeId");
    if (event.type === "SELL_PROTECTION") {
      const result = await this.transaction((tx) => this.state.raiseProtection(tx, { accountId, instId, tradeId, version: fill.version, protectionPrice: event.protection }));
      return { accepted: result?.rowCount === 1, reason: "PROTECTION_UPDATED" };
    }
    if (event.type !== "SELL_BREACH") return { accepted: false, reason: "UNSUPPORTED" };
    const result = await this.transaction((tx) => this.state.markSellTriggered(tx, { accountId, instId, tradeId, version: fill.version, protectionPrice: event.protection }));
    if (result?.rowCount !== 1) return { accepted: false, reason: "CAS_LOST" };
    const current = result.rows?.[0] ?? { ...fill, sell_state: "SELL_TRIGGERED", protection_price: event.protection, version: BigInt(fill.version) + 1n };
    this.fills.set(event.key, current);
    this.coordinator.enqueue({ intent: "SELL", accountId, instId, baseCcy: field(current, "base_ccy", "baseCcy"), sourceBuyTradeId: tradeId, remainingSize: subtractDecimal(field(current, "fill_size", "fillSize"), field(current, "disposed_size", "disposedSize") ?? "0"), fillVersion: current.version, sellTime: Number(field(current, "sell_time", "sellTime")), availableBase: current.availableBase, bidPx: this.market.ticker(instId)?.bidPx ?? this.market.ticker(instId)?.last, executionMode: field(current, "execution_mode", "executionMode") });
    this._emit({ type: "sell_triggered", reason: "SELL_TRIGGERED", sourceBuyTradeId: tradeId });
    return { accepted: true, reason: "SELL_TRIGGERED" };
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
