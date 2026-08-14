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
  constructor(required = ["owner", "database", "public", "private", "business", "account", "instruments"]) { this.required = new Set(required); this.states = new Map([...this.required].map((name) => [name, false])); }
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
  take() { return this.critical.shift() ?? this.normal.shift() ?? this.#takeTicker(); }
  #takeTicker() { const first = this.tickers.keys().next(); if (first.done) return null; const value = this.tickers.get(first.value); this.tickers.delete(first.value); return value; }
  get size() { return this.critical.length + this.normal.length + this.tickers.size; }
}

export class TradingEngine {
  constructor({ projection = new MarketProjection(), account = new AccountCapitalSnapshot(), readyGate = new ReadyGate(), queue = new BoundedPriorityQueue(), clock = { nowMs: () => Date.now() }, timers = globalThis, watchdogMs = 5_000, onWatchdog = () => {}, sellService = null, coordinator = null, slo = null } = {}) {
    Object.assign(this, { projection, account, readyGate, queue, clock, timers, watchdogMs, onWatchdog, sellService, coordinator, slo }); this.pendingBuy = new Map(); this.activeBuy = new Set(); this.watchdog = null;
  }
  receiveTicker(row) {
    const started = this.clock.nowMs();
    const result = this.projection.updateTicker(row);
    if (result.accepted) { this.queue.enqueue({ type: "ticker", instId: row.instId }); for (const event of this.sellService?.observeTicker(row.instId) ?? []) this.queue.enqueue(event); }
    // Ingress SLO boundary: normalized WS event through projection and into
    // the bounded consumer queue. Keep the old metric for dashboard continuity.
    this.slo?.record("event_enqueue", started); this.slo?.record("ws_projection_enqueue", started); this.slo?.observe("queue_depth", this.queue.size);
    return result;
  }
  receiveCandle(row) {
    const result = this.projection.updateCandle(row);
    if (result.accepted) { this.queue.enqueue({ type: "market-recheck", instId: row.instId, priority: "normal" }); for (const event of this.sellService?.observeCandle(row.instId) ?? []) this.queue.enqueue(event); }
    return result;
  }
  rebuildExitWatches(fills) { this.sellService?.rebuild(fills); }
  async consumeOne() {
    const event = this.queue.take(); if (!event) return null;
    if (event.type === "SELL_BREACH" || event.type === "SELL_PROTECTION") return this.sellService.consume(event);
    return event;
  }
  protectInstrument(instId) { this.pendingBuy.delete(instId); return this.activeBuy.has(instId); }
  queueBuy(intent) { if (this.activeBuy.has(intent.instId)) return false; const current = this.pendingBuy.get(intent.instId); if (!current || intent.generation < current.generation || (intent.generation === current.generation && intent.eligibleSince <= current.eligibleSince)) this.pendingBuy.set(intent.instId, intent); return true; }
  takeBuyBatch(limit = 5) { return [...this.pendingBuy.values()].sort((a, b) => a.generation - b.generation || a.eligibleSince - b.eligibleSince || a.instId.localeCompare(b.instId)).slice(0, limit); }
  markBuyActive(instId) { this.pendingBuy.delete(instId); this.activeBuy.add(instId); }
  markBuyTerminal(instId) { this.activeBuy.delete(instId); }
  startWatchdog() { if (!this.watchdog) this.watchdog = this.timers.setInterval(() => this.onWatchdog(this.snapshot()), this.watchdogMs); }
  stopWatchdog() { if (this.watchdog) this.timers.clearInterval(this.watchdog); this.watchdog = null; }
  snapshot() { return { ready: this.readyGate.snapshot(), pendingBuy: this.pendingBuy.size, activeBuy: this.activeBuy.size, queue: this.queue.size }; }
}
