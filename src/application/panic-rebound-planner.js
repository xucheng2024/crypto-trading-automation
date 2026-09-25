import { compareDecimal, multiplyDecimal, subtractDecimal } from "../decimal.js";
import { PANIC_MIN_HOLD_HOURS, PANIC_MIN_ORDER_USDT, PANIC_SKIP_COUNT, PANIC_STRATEGY_HASH, panicPrices, rankCountHits, strategyDay, strategyDayCloseSellMs, strategyDayStartMs } from "../domain/rules.js";
import { CLOCK_SYNC_STALE_AFTER_MS } from "../infrastructure/okx/rest-client.js";
import { createDecisionId, payloadHash } from "../domain/order.js";

const OPEN_REFILL_INTERVAL_MS = 5_000;
const PRIME_RETRY_MS = 5_000;
const BACKFILL_BAR = "5m";
const BACKFILL_LIMIT = 300;

function field(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
function protectedInstIds(rows) { return new Set((rows ?? []).filter((row) => ["BLACKLISTED", "EXITING", "EXITED", "DELIST_DUST"].includes(row.state)).map((row) => field(row, "inst_id", "instId"))); }
function optionalNumber(value) { return value === null || value === undefined ? null : Number(value); }

export function normalizePanicDayRow(row) {
  if (!row) return null;
  return {
    instId: field(row, "inst_id", "instId"), strategyDay: String(field(row, "strategy_day", "strategyDay")).slice(0, 10),
    openPrice: String(field(row, "open_price", "openPrice")), openTs: Number(field(row, "open_ts", "openTs")), openSource: field(row, "open_source", "openSource"),
    tickSz: String(field(row, "tick_sz", "tickSz")), countPrice: String(field(row, "count_price", "countPrice")), buyPrice: String(field(row, "buy_price", "buyPrice")),
    countHitAt: optionalNumber(field(row, "count_hit_at", "countHitAt")), countHitPrice: field(row, "count_hit_price", "countHitPrice") ?? null, countHitSource: field(row, "count_hit_source", "countHitSource") ?? null,
    buyHitAt: optionalNumber(field(row, "buy_hit_at", "buyHitAt")), buyHitPrice: field(row, "buy_hit_price", "buyHitPrice") ?? null,
  };
}

// OKX tickers carry sodUtc8, the open of the current UTC+8 day.  A row is only
// trusted once its own timestamp is inside that day, so a snapshot taken just
// before midnight can never seed the next day's open.
export function openRowsFromTickers({ day, tickers = [], instIds, instrument }) {
  const dayStart = strategyDayStartMs(day); const rows = [];
  for (const ticker of tickers) {
    const instId = ticker?.instId; const ts = Number(ticker?.ts);
    if (!instIds.has(instId) || !Number.isFinite(ts) || ts < dayStart || strategyDay(ts) !== day) continue;
    const open = ticker.sodUtc8; const tickSz = instrument(instId)?.tickSz;
    if (!open || !tickSz || compareDecimal(open, "0") <= 0) continue;
    let prices; try { prices = panicPrices({ open, tickSz }); } catch { continue; }
    rows.push({ strategyDay: day, instId, openPrice: String(open), openTs: dayStart, openSource: "TICKER_SOD_UTC8", tickSz: String(tickSz), ...prices });
  }
  return rows;
}

// A restart cannot replay missed ticks.  The earliest bar of the day whose low
// reached the count price bounds the missed first touch; OKX candles are
// newest first and may include the in-progress bar.
export function firstBackfillTouch({ candles = [], dayStart, countPrice }) {
  const bars = candles.map((row) => ({ ts: Number(row?.[0]), low: row?.[3] })).filter((bar) => Number.isFinite(bar.ts) && bar.ts >= dayStart && bar.low && compareDecimal(bar.low, countPrice) <= 0).sort((a, b) => a.ts - b.ts);
  return bars.length ? { ts: bars[0].ts, price: String(bars[0].low) } : null;
}

export function summarizePanicPipelineCoverage({ instIds = [], market, rows, day, exchangeNowMs, quoteFreshMs = 1_500, evaluatorSeen, ranks }) {
  let quoteReady = 0, quoteStale = 0, openReady = 0, countHit = 0, candidate = 0, buyHit = 0, seen = 0, noMarket = 0, openMissing = 0;
  for (const instId of instIds) {
    // A quote that exists but is older than the freshness bound is stale, not
    // missing: quiet pairs and ingest lag must not read as absent market data.
    const status = market?.quoteStatus?.(instId, quoteFreshMs, exchangeNowMs);
    const row = day ? rows?.get(instId) : null;
    if (status?.fresh === true) quoteReady += 1;
    else if (status?.quote) quoteStale += 1;
    else noMarket += 1;
    if (row) openReady += 1; else openMissing += 1;
    if (row?.countHitAt != null) countHit += 1;
    if ((ranks?.get(instId) ?? 0) > PANIC_SKIP_COUNT) candidate += 1;
    if (row?.buyHitAt != null) buyHit += 1;
    if (evaluatorSeen?.has(instId)) seen += 1;
  }
  return {
    type: "instrument_pipeline_coverage", reason: "PIPELINE_COVERAGE", runtime: instIds.length, strategyDay: day ?? undefined,
    quote_ready: quoteReady, quote_stale: quoteStale, open_ready: openReady, count_hit: countHit, candidate, buy_hit: buyHit, evaluator_seen: seen,
    no_market_data: noMarket, open_missing: openMissing,
  };
}

/**
 * Converts market observations into durable panic-rebound BUY intents.  It
 * never sizes or submits: the Coordinator owns capital and order transport.
 */
export class PanicReboundPlanner {
  constructor({ accountId, instIds = [], market, coordinator, state, orders, transaction, rest, readyGate, clock, quoteFreshMs = 1_500, telemetry = () => {}, slo = null, refreshUniverse = null }) {
    Object.assign(this, { accountId, market, coordinator, state, orders, transaction, rest, readyGate, clock, quoteFreshMs, telemetry, slo, refreshUniverse });
    this.setUniverse(instIds);
    this.rows = new Map(); this.ranks = null; this.protected = new Set(); this.ledger = []; this.decisions = new Map(); this.evaluatorSeen = new Set(); this.lastEvaluationAt = new Map();
    this.currentDay = null; this.universeDay = null; this.primePromise = null; this.primeNotBefore = 0; this.refillPromise = null; this.lastRefillAt = 0; this.anchorHashes = new Map();
  }
  setUniverse(instIds) { this.instIds = [...new Set(instIds)]; this.universe = new Set(this.instIds); }
  exchangeNowMs() { return this.clock.nowMs() + Number(this.rest.clockSkewMs ?? 0); }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* observability only */ } }
  restore({ protection = [], ledger = [] } = {}) {
    this.protected = protectedInstIds(protection);
    this.ranks = null; this.ledger = ledger.map((row) => ({ ...row }));
  }
  // Each new day re-reads the protection table so a manual blacklist takes
  // effect without a restart.  It only ever adds: removals need a restart.
  async reloadProtection(day) {
    if (!this.state.listProtection) return;
    try {
      for (const instId of protectedInstIds(await this.transaction((tx) => this.state.listProtection(tx)))) this.protected.add(instId);
      this.ranks = null;
    } catch (error) { this._emit({ type: "strategy_baseline", reason: "PROTECTION_RELOAD_FAILED", strategyDay: day, error: error?.message }); }
  }
  // Blacklisted and delisting pairs leave the count as well as buying.  A
  // mid-day removal can only lower later ranks, so it never creates a buy.
  protect(instId) { this.protected.add(instId); this.ranks = null; }
  rankedRows() { return [...this.rows.values()].filter((row) => !this.protected.has(row.instId)); }
  async reloadLedger() { this.ledger = await this.transaction((tx) => this.state.listManagedFills(tx, this.accountId)); return this.ledger; }
  // Capital from an earlier day is still committed until that position is
  // sold; today's own fills never block further buys with leftover USDT.
  // A remainder below the minimum order or worth less than the minimum buy
  // (e.g. the base-currency buy fee left after the close sell) is dust: it
  // must never block new positions, even while still marked SELL_TRIGGERED.
  hasPriorDayPosition(day) {
    const dayStart = strategyDayStartMs(day);
    return this.ledger.some((fill) => {
      if (String(fill.side).toUpperCase() !== "BUY" || !["WAITING", "SELL_TRIGGERED"].includes(field(fill, "sell_state", "sellState")) || Number(field(fill, "fill_time", "fillTime")) >= dayStart) return false;
      const remaining = subtractDecimal(field(fill, "fill_size", "fillSize"), field(fill, "disposed_size", "disposedSize") ?? "0");
      if (compareDecimal(remaining, "0") <= 0) return false;
      const minSz = this.market.instrument(field(fill, "inst_id", "instId"))?.minSz;
      if (minSz && compareDecimal(remaining, minSz) < 0) return false;
      const fillPrice = field(fill, "fill_price", "fillPrice");
      return !fillPrice || compareDecimal(multiplyDecimal(remaining, fillPrice), PANIC_MIN_ORDER_USDT) >= 0;
    });
  }
  rank(instId) {
    this.ranks ??= rankCountHits(this.rankedRows());
    return this.ranks.get(instId) ?? null;
  }
  _applyRows(day, rows) {
    if (this.rowsDay && day < this.rowsDay) return; // a slow refill never replaces a newer day
    const next = new Map();
    for (const raw of rows) {
      const row = normalizePanicDayRow(raw);
      // Rows persisted for pairs outside today's universe (e.g. by an earlier
      // revision with a wider list) must never enter the count ranking.
      if (!row || row.strategyDay !== day || !this.universe.has(row.instId)) continue;
      next.set(row.instId, row);
      this.market.setPanicLevels?.(row.instId, { day, countPrice: row.countPrice, buyPrice: row.buyPrice });
    }
    this.rows = next; this.ranks = null; this.rowsDay = day;
  }
  _replaceRow(raw) {
    const row = normalizePanicDayRow(raw);
    if (!row || row.strategyDay !== this.rowsDay) return null;
    this.rows.set(row.instId, row); this.ranks = null; return row;
  }
  async syncDay(day) {
    const dayStart = strategyDayStartMs(day);
    let persisted = await this.transaction((tx) => this.state.listPanicDay(tx, day));
    const tickers = await this.rest.tickers("SPOT");
    const known = new Set(persisted.map((row) => field(row, "inst_id", "instId")));
    const missing = new Set(this.instIds.filter((instId) => !known.has(instId)));
    const opens = missing.size ? openRowsFromTickers({ day, tickers, instIds: missing, instrument: (instId) => this.market.instrument(instId) }) : [];
    if (opens.length) {
      await this.transaction((tx) => this.state.claimDailyOpens(tx, opens));
      persisted = await this.transaction((tx) => this.state.listPanicDay(tx, day));
    }
    // A missing earlier touch would let a true first-two instrument rank
    // later on a second touch, so any backfill read failure fails the sync.
    const tickerById = new Map(tickers.map((row) => [row.instId, row]));
    let backfilled = 0;
    for (const row of persisted.map(normalizePanicDayRow)) {
      if (row.countHitAt != null || !this.universe.has(row.instId) || this.market.panicTouch?.(row.instId, day)?.count) continue;
      const low = tickerById.get(row.instId)?.low24h;
      if (low && compareDecimal(low, row.countPrice) > 0) continue;
      const touch = firstBackfillTouch({ candles: await this.rest.candles(row.instId, { bar: BACKFILL_BAR, limit: BACKFILL_LIMIT }), dayStart, countPrice: row.countPrice });
      if (!touch) continue;
      const result = await this.transaction((tx) => this.state.recordCountHit(tx, { strategyDay: day, instId: row.instId, hitAt: touch.ts, price: touch.price, source: "BACKFILL" }));
      if (result?.rowCount) { backfilled += 1; this._emit({ type: "trading_decision", side: "BUY", stage: "PLANNER", reason: "COUNT_HIT_RECORDED", reasonCode: "COUNT_HIT_RECORDED", instId: row.instId, strategyDay: day, countHitAt: touch.ts, countHitPrice: touch.price, countHitSource: "BACKFILL" }); }
    }
    if (backfilled) persisted = await this.transaction((tx) => this.state.listPanicDay(tx, day));
    this._applyRows(day, persisted);
    this.lastRefillAt = this.clock.nowMs();
    const ready = this.instIds.filter((instId) => this.rows.has(instId)).length;
    return { opens: ready, openMissing: this.instIds.length - ready, backfilled, countHits: [...this.rows.values()].filter((row) => row.countHitAt != null).length };
  }
  async prime() {
    if (this.primePromise) return this.primePromise;
    this.primePromise = (async () => {
      const day = strategyDay(this.exchangeNowMs()); this.readyGate.set("strategy", false);
      try {
        // The startup baseline already built today's universe; each later day
        // re-reads live USDT spot pairs so new listings join the count.
        if (!this.universeDay) this.universeDay = day;
        else if (this.universeDay !== day) await this.reloadProtection(day);
        if (this.universeDay !== day && this.refreshUniverse) {
          try { await this.refreshUniverse(); this.universeDay = day; }
          catch (error) { this._emit({ type: "strategy_baseline", reason: "UNIVERSE_REFRESH_FAILED", strategyDay: day, error: error?.message }); }
        }
        // The new day becomes current only once its own opens and touches are
        // applied: ticks during the sync must never see yesterday's prices,
        // ranks or limits under today's strategy day.
        const summary = await this.syncDay(day);
        this.currentDay = day;
        this.readyGate.set("strategy", true);
        this._emit({ type: "strategy_baseline", reason: "STRATEGY_READY", strategyDay: day, instruments: this.instIds.length, ...summary });
        return day;
      } catch (error) {
        this.currentDay = null; this.primeNotBefore = this.clock.nowMs() + PRIME_RETRY_MS;
        this.readyGate.set("strategy", false); this._emit({ type: "strategy_baseline", reason: "STRATEGY_BASELINE_FAILED", strategyDay: day, error: error?.message }); throw error;
      } finally { this.primePromise = null; }
    })();
    return this.primePromise;
  }
  _scheduleRefill() {
    if (this.refillPromise || this.primePromise || this.clock.nowMs() - this.lastRefillAt < OPEN_REFILL_INTERVAL_MS || !this.currentDay) return;
    const day = this.currentDay;
    this.refillPromise = this.syncDay(day)
      .then((summary) => this._emit({ type: "strategy_baseline", reason: "DAILY_OPEN_REFILLED", strategyDay: day, ...summary }))
      .catch((error) => { this.lastRefillAt = this.clock.nowMs(); this._emit({ type: "strategy_baseline", reason: "DAILY_OPEN_REFILL_FAILED", strategyDay: day, error: error?.message }); })
      .finally(() => { this.refillPromise = null; });
  }
  emitDecision(instId, event, force = false) {
    const key = `${event.reason}:${event.strategyDay ?? ""}:${event.generation ?? ""}`;
    if (!force && this.decisions.get(instId) === key) return;
    this.decisions.set(instId, key); this._emit({ stage: "PLANNER", reasonCode: event.reason, ...event, instId });
  }
  async observe(event) {
    const started = this.clock.nowMs();
    try { return await this._observe(event); }
    finally { this.slo?.record("decision_eval", started); }
  }
  async _recordCountHit(row, touch) {
    const result = await this.transaction((tx) => this.state.recordCountHit(tx, { strategyDay: row.strategyDay, instId: row.instId, hitAt: touch.ts, price: touch.price, source: "LIVE" }));
    const current = result?.rows?.[0] ? this._replaceRow(result.rows[0]) : this._replaceRow(await this.transaction((tx) => this.state.findPanicDayRow(tx, row.strategyDay, row.instId)));
    if (result?.rowCount) this.emitDecision(row.instId, { type: "trading_decision", side: "BUY", reason: "COUNT_HIT_RECORDED", strategyDay: row.strategyDay, countHitAt: touch.ts, countHitPrice: touch.price, countHitSource: "LIVE", countRank: this.rank(row.instId), openPrice: row.openPrice, countPrice: row.countPrice }, true);
    return current ?? row;
  }
  async _recordBuyHit(row, touch) {
    const result = await this.transaction((tx) => this.state.recordBuyHit(tx, { strategyDay: row.strategyDay, instId: row.instId, hitAt: touch.ts, price: touch.price }));
    const current = result?.rows?.[0] ? this._replaceRow(result.rows[0]) : this._replaceRow(await this.transaction((tx) => this.state.findPanicDayRow(tx, row.strategyDay, row.instId)));
    if (result?.rowCount) this.emitDecision(row.instId, { type: "trading_decision", side: "BUY", reason: "BUY_PRICE_REACHED", strategyDay: row.strategyDay, buyHitAt: touch.ts, buyHitPrice: touch.price, countRank: this.rank(row.instId), openPrice: row.openPrice, buyPrice: row.buyPrice }, true);
    return current ?? row;
  }
  async _anchorHash(row) {
    const key = `${row.strategyDay}:${row.instId}`;
    if (!this.anchorHashes.has(key)) {
      if (this.anchorHashes.size >= 2_000) this.anchorHashes.clear();
      this.anchorHashes.set(key, await payloadHash({ instId: row.instId, strategyDay: row.strategyDay, openPrice: row.openPrice, openTs: row.openTs, openSource: row.openSource }));
    }
    return this.anchorHashes.get(key);
  }
  async _observe(event) {
    const instId = event?.instId; if (!instId || !this.universe.has(instId)) return { queued: false, reason: "IGNORED" };
    this.evaluatorSeen.add(instId); this.lastEvaluationAt.set(instId, this.clock.nowMs());
    const exchangeNowMs = this.exchangeNowMs(); const day = strategyDay(exchangeNowMs);
    if (this.currentDay !== day) {
      this.readyGate.set("strategy", false);
      if (this.clock.nowMs() >= this.primeNotBefore) void this.prime().catch(() => {});
      return { queued: false, reason: "STRATEGY_DAY_REFRESH" };
    }
    const quoteStatus = this.market.quoteStatus(instId, this.quoteFreshMs, exchangeNowMs); const quote = quoteStatus.quote;
    let row = this.rowsDay === day ? this.rows.get(instId) : null;
    const base = { type: "trading_decision", side: "BUY", strategyDay: day, last: quote?.last, askPx: quote?.askPx, quoteTs: quote?.ts, quoteAgeMs: quoteStatus.sourceAgeMs, quoteReceiptAgeMs: quoteStatus.receiptAgeMs, quoteFreshness: quoteStatus.reason, openPrice: row?.openPrice, countPrice: row?.countPrice, buyPrice: row?.buyPrice, configHash: PANIC_STRATEGY_HASH };
    const decide = (reason, extra = {}, force = false) => { this.emitDecision(instId, { ...base, ...extra, reason }, force); return { queued: false, reason }; };
    if (!row) { this._scheduleRefill(); return decide("DAILY_OPEN_PENDING"); }
    if (this.protected.has(instId)) return decide("INSTRUMENT_PROTECTED");
    if (row.countHitAt == null) {
      const touch = this.market.panicTouch?.(instId, day)?.count;
      if (!touch) return decide("ABOVE_COUNT_PRICE");
      row = await this._recordCountHit(row, touch);
      if (row.countHitAt == null) return decide("COUNT_HIT_PENDING");
    }
    const countRank = this.rank(instId);
    Object.assign(base, { countRank, countHitAt: row.countHitAt });
    if (!countRank || countRank <= PANIC_SKIP_COUNT) return decide("SKIPPED_FIRST_TWO");
    if (!quoteStatus.fresh) return decide("QUOTE_STALE");
    if (compareDecimal(quote.last, row.buyPrice) > 0) return decide("ABOVE_BUY_PRICE");
    if (row.buyHitAt == null) row = await this._recordBuyHit(row, this.market.panicTouch?.(instId, day)?.buy ?? { ts: Number(quote.ts), price: quote.last });
    Object.assign(base, { buyHitAt: row.buyHitAt });
    const instrument = this.market.instrument(instId);
    let reason;
    if (!instrument || instrument.state !== "live") reason = "INSTRUMENT_NOT_TRADABLE";
    else if (!quote.askPx || compareDecimal(quote.askPx, row.buyPrice) > 0) reason = "ASK_ABOVE_LIMIT";
    else if (!this.rest.clockFresh(CLOCK_SYNC_STALE_AFTER_MS)) reason = "CLOCK_SYNC_STALE";
    else if (exchangeNowMs >= strategyDayCloseSellMs(day)) reason = "DAY_CLOSED";
    else if (this.hasPriorDayPosition(day)) reason = "PRIOR_POSITION_OPEN";
    else if (this.coordinator.buyCapitalBlocked?.()) reason = "CAPITAL_EXHAUSTED";
    if (reason) return decide(reason);
    const cycleStarted = this.clock.nowMs();
    let cycle;
    try { cycle = await this.transaction((tx) => this.orders.listBuyCycle(tx, this.accountId, instId, day)); }
    finally { this.slo?.record("buy_cycle_tx", cycleStarted); }
    const previous = cycle.attempts.at(-1); const active = cycle.attempts.find((attempt) => ["PREPARED", "SUBMITTED", "UNKNOWN"].includes(attempt.state));
    if (active) return decide("ACTIVE_BUY_ATTEMPT", { clOrdId: active.cl_ord_id });
    const anchor = { ts: strategyDayStartMs(day), hash: await this._anchorHash(row) };
    const marketKey = await payloadHash({ quote, anchor });
    if (previous && previous.decision_market_key === marketKey) return decide("DUPLICATE_MARKET_SNAPSHOT");
    const generation = previous ? Number(previous.generation) + 1 : 0;
    const decisionId = await createDecisionId({ accountId: this.accountId, instId, strategyDay: day, generation, marketKey });
    const intent = { intent: "BUY", accountId: this.accountId, instId, decisionId, generation, triggerAt: row.buyHitAt, signalAt: this.clock.nowMs(), strategyDay: day, limitPrice: row.buyPrice, openPrice: row.openPrice, countPrice: row.countPrice, countRank, anchor, holdHours: PANIC_MIN_HOLD_HOURS, configHash: PANIC_STRATEGY_HASH, previousAttempt: previous, nextMarketKey: marketKey };
    const queued = this.coordinator.enqueue(intent);
    decide(queued ? "BUY_QUEUED" : "BUY_QUEUE_REJECTED", { decisionId, generation, priceLimitGap: subtractDecimal(row.buyPrice, quote.askPx) });
    return { queued, reason: queued ? "BUY_QUEUED" : "BUY_QUEUE_REJECTED" };
  }
  pipelineCoverage() {
    return summarizePanicPipelineCoverage({ instIds: this.instIds, market: this.market, rows: this.rows, day: this.currentDay, exchangeNowMs: this.exchangeNowMs(), quoteFreshMs: this.quoteFreshMs, evaluatorSeen: this.evaluatorSeen, ranks: this.ranks ?? rankCountHits(this.rankedRows()) });
  }
  health() {
    const now = this.clock.nowMs(); const ages = this.instIds.map((instId) => this.lastEvaluationAt.get(instId)).filter((observedAt) => Number.isFinite(observedAt)).map((observedAt) => Math.max(0, now - observedAt));
    return { decision_missing_instruments: this.instIds.length - ages.length, decision_oldest_age_ms: ages.length ? Math.max(...ages) : 0 };
  }
}
