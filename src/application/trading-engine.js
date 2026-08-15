import { compareDecimal } from "../decimal.js";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${key}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** A single process projection: callbacks only mutate memory and enqueue bounded work. */
export class MarketProjection {
  constructor({ clock = { nowMs: () => Date.now() } } = {}) { this.clock = clock; this.tickers = new Map(); this.candles = new Map(); this.instruments = new Map(); }
  updateTicker(row) { return this.#update(this.tickers, row.instId, row, "ticker"); }
  refreshTicker(row) {
    const result = this.updateTicker(row);
    if (result.reason === "DUPLICATE") {
      const entry = this.tickers.get(row.instId);
      if (entry) entry.receivedAt = this.clock.nowMs();
      return { ...result, refreshed: true };
    }
    return result;
  }
  updateCandle(row) { if (!row.confirm) return { accepted: false, reason: "UNCONFIRMED" }; return this.#update(this.candles, row.instId, row, "candle"); }
  updateInstrument(row) { return this.#update(this.instruments, row.instId, row, "instrument"); }
  ticker(instId) { return this.tickers.get(instId)?.value; }
  candle(instId) { return this.candles.get(instId)?.value; }
  instrument(instId) { return this.instruments.get(instId)?.value; }
  freshQuote(instId, maxAgeMs) { const entry = this.tickers.get(instId); return Boolean(entry && this.clock.nowMs() - entry.receivedAt <= maxAgeMs) ? entry.value : null; }
  marketKey(instId) { const ticker = this.ticker(instId); const candle = this.candle(instId); return ticker && candle ? stable({ quote: ticker, candle }) : null; }
  #update(map, id, value, kind) {
    if (!id) return { accepted: false, reason: "MISSING_INST" };
    const prior = map.get(id); const ts = Number(value.ts ?? value.uTime ?? 0); const fingerprint = stable(value);
    if (prior && ts < prior.ts) return { accepted: false, reason: "OUT_OF_ORDER", version: prior.version };
    if (prior && ts === prior.ts && fingerprint === prior.fingerprint) return { accepted: false, reason: "DUPLICATE", version: prior.version };
    const next = { value: { ...value }, ts, fingerprint, version: (prior?.version ?? 0) + 1, receivedAt: this.clock.nowMs(), kind };
    map.set(id, next); return { accepted: true, corrected: Boolean(prior && ts === prior.ts), version: next.version, value: next.value };
  }
}

export class AccountCapitalSnapshot {
  constructor({ clock = { nowMs: () => Date.now() } } = {}) { this.clock = clock; this.value = null; }
  update(row) {
    const ts = Number(row.ts ?? row.uTime ?? row.pTime ?? 0);
    if (this.value && ts < this.value.ts) return false;
    if (!row.totalEq || !row.adjEq || compareDecimal(row.totalEq, "0") <= 0 || compareDecimal(row.adjEq, "0") <= 0) return false;
    this.value = { ...row, ts, receivedAt: this.clock.nowMs(), version: (this.value?.version ?? 0) + 1 };
    return true;
  }
  fresh(maxAgeMs) { return Boolean(this.value && this.clock.nowMs() - this.value.receivedAt <= maxAgeMs); }
}

export class ReadyGate {
  constructor(required = ["owner", "database", "public", "private", "business", "account", "instruments", "strategy"]) { this.required = new Set(required); this.states = new Map([...this.required].map((name) => [name, false])); }
  set(name, healthy) { this.states.set(name, healthy === true); }
  get ready() { return [...this.required].every((name) => this.states.get(name) === true); }
  snapshot() { return { ready: this.ready, dependencies: Object.fromEntries(this.states) }; }
}

export class BoundedPriorityQueue {
  constructor({ capacity = 1_000 } = {}) { this.capacity = capacity; this.critical = []; this.normal = []; this.tickers = new Map(); }
  enqueue(event) {
    if (event.type === "ticker") { this.tickers.set(event.instId, event); return true; }
    const target = event.priority === "critical" ? this.critical : this.normal;
    if (target.length >= this.capacity) return false;
    target.push(event); return true;
  }
  take(nowMs = Infinity) { return this.#takeReady(this.critical, nowMs) ?? this.#takeReady(this.normal, nowMs) ?? this.#takeTicker(); }
  #takeReady(rows, nowMs) {
    const index = rows.findIndex((event) => !Number.isFinite(event.notBefore) || event.notBefore <= nowMs);
    return index < 0 ? null : rows.splice(index, 1)[0];
  }
  #takeTicker() { const first = this.tickers.keys().next(); if (first.done) return null; const value = this.tickers.get(first.value); this.tickers.delete(first.value); return value; }
  get size() { return this.critical.length + this.normal.length + this.tickers.size; }
}

export class TradingEngine {
  constructor({ projection = new MarketProjection(), account = new AccountCapitalSnapshot(), readyGate = new ReadyGate(), queue = new BoundedPriorityQueue(), clock = { nowMs: () => Date.now() }, timers = globalThis, watchdogMs = 5_000, onWatchdog = () => {}, onMarketEvent = async (event) => event, onOrderEvent = async (event) => event, sellService = null, coordinator = null, slo = null } = {}) {
    Object.assign(this, { projection, account, readyGate, queue, clock, timers, watchdogMs, onWatchdog, onMarketEvent, onOrderEvent, sellService, coordinator, slo }); this.watchdog = null;
  }
  receiveTicker(row) {
    const started = this.clock.nowMs();
    const result = this.projection.updateTicker(row);
    if (result.accepted) {
      this.queue.enqueue({ type: "ticker", instId: row.instId, enqueuedAt: this.clock.nowMs() });
      this.enqueueSellEvents(this.sellService?.observeTicker(row.instId) ?? []);
    }
    // Ingress SLO boundary: normalized WS event through projection and into
    // the bounded consumer queue. Keep the old metric for dashboard continuity.
    this.slo?.record("event_enqueue", started); this.slo?.record("ws_projection_enqueue", started); this.slo?.observe("queue_depth", this.queue.size);
    if (Number.isFinite(Number(row.ts)) && this.clock.nowMs() >= Number(row.ts)) this.slo?.observe("market_source_lag", this.clock.nowMs() - Number(row.ts));
    return result;
  }
  receiveCandle(row) {
    const result = this.projection.updateCandle(row);
    if (result.accepted) {
      if (!this.queue.enqueue({ type: "market-recheck", instId: row.instId, priority: "normal", enqueuedAt: this.clock.nowMs() })) this.slo?.increment("queue_dropped_recheck");
      this.enqueueSellEvents(this.sellService?.observeCandle(row.instId) ?? []);
    }
    return result;
  }
  receiveOrder(row) { const accepted = this.queue.enqueue({ type: "ORDER_UPDATE", priority: "critical", order: row, enqueuedAt: this.clock.nowMs() }); if (!accepted) this.slo?.increment("queue_dropped_order"); return accepted; }
  rebuildExitWatches(fills) { this.sellService?.rebuild(fills); }
  enqueueSellEvents(events) {
    let accepted = 0;
    for (const event of events) {
      const queued = { ...event, enqueuedAt: event.enqueuedAt ?? this.clock.nowMs() };
      if (this.queue.enqueue(queued)) accepted += 1;
      else {
        this.sellService?.releaseLatch?.(event, "QUEUE_FULL");
        this.slo?.increment("queue_dropped_sell");
      }
    }
    return accepted;
  }
  _retrySellEvent(event, reason) {
    const retryCount = Number(event.retryCount ?? 0) + 1;
    const delayMs = Math.min(30_000, 100 * (2 ** Math.min(retryCount - 1, 8)));
    const retry = { ...event, retryCount, notBefore: this.clock.nowMs() + delayMs, enqueuedAt: this.clock.nowMs() };
    if (this.queue.enqueue(retry)) {
      this.sellService?.noteRetry?.(retry, reason, delayMs);
      return true;
    }
    this.sellService?.releaseLatch?.(event, "RETRY_QUEUE_FULL");
    this.slo?.increment("queue_dropped_sell");
    return false;
  }
  takeOne() {
    const event = this.queue.take(this.clock.nowMs()); if (!event) return null;
    if (Number.isFinite(event.enqueuedAt)) this.slo?.record("queue_wait", event.enqueuedAt);
    return event;
  }
  async dispatch(event) {
    if (!event) return null;
    if (event.type === "SELL_BREACH" || event.type === "SELL_PROTECTION") {
      try {
        const result = await this.sellService.consume(event);
        if (result?.retryable) this._retrySellEvent(event, result.reason);
        return result;
      } catch (error) {
        this._retrySellEvent(event, error?.message ?? "SELL_CONSUME_FAILED");
        throw error;
      }
    }
    if (event.type === "ORDER_UPDATE") return this.onOrderEvent(event.order);
    if (event.type === "ticker" || event.type === "market-recheck") return this.onMarketEvent(event);
    return event;
  }
  async consumeOne() { return this.dispatch(this.takeOne()); }
  startWatchdog() { if (!this.watchdog) this.watchdog = this.timers.setInterval(() => this.onWatchdog(this.snapshot()), this.watchdogMs); }
  stopWatchdog() { if (this.watchdog) this.timers.clearInterval(this.watchdog); this.watchdog = null; }
  snapshot() { return { ready: this.readyGate.snapshot(), queue: this.queue.size }; }
}
