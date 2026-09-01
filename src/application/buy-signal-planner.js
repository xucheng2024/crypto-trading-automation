import { compareDecimal, subtractDecimal } from "../decimal.js";
import { buySignal, candleFreshness, dailyLimit, strategyDay } from "../domain/rules.js";
import { CLOCK_SYNC_STALE_AFTER_MS } from "../infrastructure/okx/rest-client.js";
import { createDecisionId, payloadHash } from "../domain/order.js";

function field(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }
function normalizeDaily(row) {
  if (!row) return null;
  return {
    instId: field(row, "inst_id", "instId"), strategyDay: String(field(row, "strategy_day", "strategyDay")),
    status: row.status, dailyLimitPrice: field(row, "daily_limit_price", "dailyLimitPrice"), inputHash: field(row, "input_hash", "inputHash"),
    todayCandleTs: Number(field(row, "today_candle_ts", "todayCandleTs")), todayOpen: field(row, "today_open", "todayOpen"),
    yesterdayCandleTs: Number(field(row, "yesterday_candle_ts", "yesterdayCandleTs")), yesterdayOpen: field(row, "yesterday_open", "yesterdayOpen"),
    yesterdayClose: field(row, "yesterday_close", "yesterdayClose"), bestLimit: field(row, "best_limit", "bestLimit"), tickSz: field(row, "tick_sz", "tickSz"),
    strategyConfigHash: field(row, "strategy_config_hash", "strategyConfigHash"),
  };
}

export function selectDailyCandles(rows, currentDay) {
  const parsed = (rows ?? []).map((row) => ({ row, ts: Number(row?.[0]), day: strategyDay(Number(row?.[0])), confirm: String(row?.[8]) === "1" })).filter((item) => Number.isFinite(item.ts));
  const today = parsed.filter((item) => item.day === currentDay).sort((a, b) => b.ts - a.ts)[0];
  const yesterday = parsed.filter((item) => item.day < currentDay && item.confirm).sort((a, b) => b.ts - a.ts)[0];
  if (!today || !yesterday) throw new Error(`DAILY_CANDLES_INCOMPLETE:${currentDay}`);
  const value = (item, index) => String(item.row[index] ?? "");
  return { todayCandleTs: today.ts, todayOpen: value(today, 1), yesterdayCandleTs: yesterday.ts, yesterdayOpen: value(yesterday, 1), yesterdayClose: value(yesterday, 4) };
}

export function summarizeInstrumentPipelineCoverage({ instIds = [], market, strategyConfig, daily, currentDay, evaluatorSeen, decisions }) {
  const drops = { no_market_data: 0, candle_not_initialized: 0, no_strategy_row: 0, strategy_state_never_created: 0, filtered_before_evaluator: 0, unknown: 0 };
  let quoteReady = 0, candleReady = 0, strategyRow = 0, dailyState = 0, evaluator = 0, emitted = 0;
  for (const instId of instIds) {
    const hasQuote = Boolean(market?.ticker?.(instId));
    const hasCandle = Boolean(market?.candle?.(instId));
    const hasStrategy = Boolean(strategyConfig?.rows?.[instId]?.bestLimit);
    const hasDaily = Boolean(currentDay && daily?.get(`${instId}:${currentDay}`));
    const seen = Boolean(evaluatorSeen?.has(instId));
    const emittedDecision = Boolean(decisions?.has(instId));
    if (hasQuote) quoteReady += 1;
    if (hasCandle) candleReady += 1;
    if (hasStrategy) strategyRow += 1;
    if (hasDaily) dailyState += 1;
    if (seen) evaluator += 1;
    if (emittedDecision) emitted += 1;
    else if (!hasQuote) drops.no_market_data += 1;
    else if (!hasCandle) drops.candle_not_initialized += 1;
    else if (!hasStrategy) drops.no_strategy_row += 1;
    else if (!hasDaily) drops.strategy_state_never_created += 1;
    else if (!seen) drops.filtered_before_evaluator += 1;
    else drops.unknown += 1;
  }
  return {
    type: "instrument_pipeline_coverage", reason: "PIPELINE_COVERAGE", runtime: instIds.length,
    quote_ready: quoteReady, candle_ready: candleReady, strategy_row: strategyRow, daily_state: dailyState,
    evaluator_seen: evaluator, decision_emit: emitted, ...drops,
  };
}

export function normalizeConfirmed3mCandle(instId, rows) {
  const row = (rows ?? []).filter((value) => String(value?.[8]) === "1").sort((a, b) => Number(b[0]) - Number(a[0]))[0];
  return normalizeConfirmed3mCandleAt(instId, row ? [row] : [], row?.[0]);
}

export function normalizeConfirmed3mCandleAt(instId, rows, expectedTs) {
  const row = (rows ?? []).find((value) => String(value?.[8]) === "1" && Number(value?.[0]) === Number(expectedTs));
  if (!row) return null;
  const [ts, open, high, low, close, volume, volumeCcy, volumeCcyQuote] = row;
  if (!Number.isFinite(Number(ts))) return null;
  return { instId, ts: Number(ts), open, high, low, close, volume, volumeCcy, volumeCcyQuote, confirm: true };
}

/** Converts market observations into durable, guarded BUY intents. */
export class BuySignalPlanner {
  constructor({ accountId, instIds, strategyConfig, market, account, coordinator, state, orders, transaction, rest, readyGate, clock, quoteFreshMs = 1_500, telemetry = () => {}, slo = null }) {
    Object.assign(this, { accountId, instIds, strategyConfig, market, account, coordinator, state, orders, transaction, rest, readyGate, clock, quoteFreshMs, telemetry, slo });
    this.daily = new Map(); this.protected = new Set(); this.ledger = []; this.decisions = new Map(); this.evaluatorSeen = new Set(); this.lastEvaluationAt = new Map(); this.currentDay = null; this.primePromise = null;
  }
  exchangeNowMs() { return this.clock.nowMs() + Number(this.rest.clockSkewMs ?? 0); }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* observability only */ } }
  restore({ protection = [], daily = [], ledger = [] } = {}) {
    this.protected = new Set(protection.filter((row) => ["BLACKLISTED", "EXITING", "EXITED", "DELIST_DUST"].includes(row.state)).map((row) => field(row, "inst_id", "instId")));
    this.daily = new Map(daily.map(normalizeDaily).filter(Boolean).map((row) => [`${row.instId}:${row.strategyDay}`, row]));
    this.ledger = ledger.map((row) => ({ ...row }));
  }
  async reloadLedger() { this.ledger = await this.transaction((tx) => this.state.listManagedFills(tx, this.accountId)); return this.ledger; }
  hasOpenManagedBuy(instId) {
    return this.ledger.some((fill) => String(fill.side).toUpperCase() === "BUY" && field(fill, "inst_id", "instId") === instId && compareDecimal(subtractDecimal(field(fill, "fill_size", "fillSize"), field(fill, "disposed_size", "disposedSize") ?? "0"), "0") > 0);
  }
  async ensureDaily(instId, day) {
    const key = `${instId}:${day}`; const cached = this.daily.get(key);
    if (cached) return cached;
    const existing = await this.transaction((tx) => this.state.findDaily(tx, instId, day));
    if (existing) { const normalized = normalizeDaily(existing); this.daily.set(key, normalized); return normalized; }
    const instrument = this.market.instrument(instId); const config = this.strategyConfig.rows[instId];
    if (!instrument || !config) throw new Error(`DAILY_CONFIG_MISSING:${instId}`);
    const candles = selectDailyCandles(await this.rest.candles(instId, { bar: "1D", limit: 4 }), day);
    const calculated = dailyLimit({ ...candles, bestLimit: config.bestLimit, tickSz: instrument.tickSz });
    const input = { instId, strategyDay: day, ...candles, bestLimit: config.bestLimit, tickSz: instrument.tickSz, strategyConfigHash: this.strategyConfig.contentHash };
    const inputHash = await payloadHash(input);
    const claimed = await this.transaction((tx) => this.state.claimDaily(tx, { ...input, status: calculated.skipped ? calculated.reason : "READY", dailyLimitPrice: calculated.price, inputHash }));
    const normalized = normalizeDaily(claimed); this.daily.set(key, normalized);
    this.emitDecision(instId, { type: "trading_decision", side: "BUY", reason: normalized.status, strategyDay: day, dailyLimitPrice: normalized.dailyLimitPrice, todayOpen: normalized.todayOpen, yesterdayOpen: normalized.yesterdayOpen, yesterdayClose: normalized.yesterdayClose, configHash: normalized.strategyConfigHash }, true);
    return normalized;
  }
  async ensureThreeMinuteCandle(instId) {
    if (this.market.candle(instId)?.confirm) return this.market.candle(instId);
    const rows = await this.rest.candles(instId, { bar: "3m", limit: 3 });
    const candle = normalizeConfirmed3mCandle(instId, rows);
    if (!candle) throw new Error(`CANDLE3M_BASELINE_MISSING:${instId}`);
    this.market.updateCandle(candle); return candle;
  }
  async prime() {
    if (this.primePromise) return this.primePromise;
    this.primePromise = (async () => {
      const day = strategyDay(this.exchangeNowMs()); this.readyGate.set("strategy", false);
      try {
        await Promise.all(this.instIds.map((instId) => Promise.all([this.ensureDaily(instId, day), this.ensureThreeMinuteCandle(instId)])));
        this.currentDay = day; this.readyGate.set("strategy", true);
        this._emit({ type: "strategy_baseline", reason: "STRATEGY_READY", strategyDay: day, instruments: this.instIds.length });
        return day;
      } catch (error) {
        this.readyGate.set("strategy", false); this._emit({ type: "strategy_baseline", reason: "STRATEGY_BASELINE_FAILED", error: error?.message }); throw error;
      } finally { this.primePromise = null; }
    })();
    return this.primePromise;
  }
  emitDecision(instId, event, force = false) {
    const key = `${event.reason}:${event.strategyDay ?? ""}`;
    if (!force && this.decisions.get(instId) === key) return;
    this.decisions.set(instId, key); this._emit({ stage: "PLANNER", reasonCode: event.reason, ...event, instId });
  }
  async observe(event) {
    const started = this.clock.nowMs();
    try { return await this._observe(event); }
    finally { this.slo?.record("decision_eval", started); }
  }
  async _observe(event) {
    const instId = event?.instId; if (!instId || !this.instIds.includes(instId)) return { queued: false, reason: "IGNORED" };
    this.evaluatorSeen.add(instId); this.lastEvaluationAt.set(instId, this.clock.nowMs());
    const exchangeNowMs = this.exchangeNowMs(); const day = strategyDay(exchangeNowMs);
    if (this.currentDay !== day) { this.readyGate.set("strategy", false); void this.prime().catch(() => {}); return { queued: false, reason: "STRATEGY_DAY_REFRESH" }; }
    if (event.type === "market-recheck" && this.hasOpenManagedBuy(instId)) {
      const low = this.market.candle(instId)?.low;
      if (low) await this.transaction((tx) => this.state.recordAdversePrice?.(tx, { accountId: this.accountId, instId, price: low }));
    }
    const instrument = this.market.instrument(instId); const quote = this.market.freshQuote(instId, this.quoteFreshMs); const candle = this.market.candle(instId); const daily = this.daily.get(`${instId}:${day}`); const candleState = candleFreshness({ candle, exchangeNowMs });
    const base = { type: "trading_decision", side: "BUY", strategyDay: day, quoteTs: quote?.ts, quoteAgeMs: quote?.ts ? exchangeNowMs - Number(quote.ts) : undefined, last: quote?.last, askPx: quote?.askPx, candleTs: candle?.ts, candleAgeMs: candle?.ts ? exchangeNowMs - Number(candle.ts) : undefined, previousClosedHigh: candle?.high, dailyLimitPrice: daily?.dailyLimitPrice, configHash: this.strategyConfig.contentHash };
    let reason;
    if (!daily) reason = "DAILY_LIMIT_PENDING";
    else if (daily.status !== "READY") reason = daily.status;
    else if (!instrument || instrument.state !== "live") reason = "INSTRUMENT_NOT_TRADABLE";
    else if (this.protected.has(instId)) reason = "INSTRUMENT_PROTECTED";
    else if (!quote) reason = "QUOTE_STALE";
    else if (!candle?.confirm) reason = "CANDLE_MISSING";
    else if (candleState.state === "PENDING") reason = "CANDLE_PENDING";
    else if (candleState.state !== "FRESH") reason = "CANDLE_STALE";
    else if (!this.rest.clockFresh(CLOCK_SYNC_STALE_AFTER_MS)) reason = "CLOCK_SYNC_STALE";
    if (reason) { this.emitDecision(instId, { ...base, reason }); return { queued: false, reason }; }
    const signal = buySignal({ last: quote.last, askPx: quote.askPx, limitPrice: daily.dailyLimitPrice, previousClosedHigh: candle.high });
    if (!signal.eligible) { this.emitDecision(instId, { ...base, reason: signal.reason, breakoutPrice: signal.breakoutPrice, dipPrice: signal.dipPrice }); return { queued: false, reason: signal.reason }; }
    const cycleStarted = this.clock.nowMs();
    let cycle;
    try { cycle = await this.transaction((tx) => this.orders.listBuyCycle(tx, this.accountId, instId, day)); }
    finally { this.slo?.record("buy_cycle_tx", cycleStarted); }
    if (this.hasOpenManagedBuy(instId) && cycle.attempts.length === 0) { this.emitDecision(instId, { ...base, reason: "STRATEGY_POSITION_EXISTS" }); return { queued: false, reason: "STRATEGY_POSITION_EXISTS" }; }
    const previous = cycle.attempts.at(-1); const active = cycle.attempts.find((row) => ["PREPARED", "SUBMITTED", "UNKNOWN"].includes(row.state));
    if (active) { this.emitDecision(instId, { ...base, reason: "ACTIVE_BUY_ATTEMPT", clOrdId: active.cl_ord_id }); return { queued: false, reason: "ACTIVE_BUY_ATTEMPT" }; }
    const marketKey = await payloadHash({ quote, candle });
    if (previous && previous.decision_market_key === marketKey) { this.emitDecision(instId, { ...base, reason: "DUPLICATE_MARKET_SNAPSHOT" }); return { queued: false, reason: "DUPLICATE_MARKET_SNAPSHOT" }; }
    const generation = previous ? Number(previous.generation) + 1 : 0;
    if (signal.trigger === "DIP" && generation !== 0) {
      this.emitDecision(instId, { ...base, reason: "DIP_FIRST_ENTRY_ONLY", breakoutPrice: signal.breakoutPrice, dipPrice: signal.dipPrice, trigger: signal.trigger, generation });
      return { queued: false, reason: "DIP_FIRST_ENTRY_ONLY" };
    }
    const decisionId = await createDecisionId({ accountId: this.accountId, instId, strategyDay: day, generation, marketKey });
    const intent = { intent: "BUY", accountId: this.accountId, instId, decisionId, generation, eligibleSince: this.clock.nowMs(), signalAt: this.clock.nowMs(), strategyDay: day, dailyLimitPrice: daily.dailyLimitPrice, breakoutPrice: signal.breakoutPrice, dipPrice: signal.dipPrice, trigger: signal.trigger, holdHours: this.strategyConfig.rows[instId].holdHours, maxHoldHours: this.strategyConfig.rows[instId].maxHoldHours, configHash: this.strategyConfig.contentHash, previousAttempt: previous, nextMarketKey: marketKey };
    const queued = this.coordinator.enqueue(intent);
    this.emitDecision(instId, { ...base, reason: queued ? "BUY_QUEUED" : "BUY_QUEUE_REJECTED", decisionId, breakoutPrice: signal.breakoutPrice, dipPrice: signal.dipPrice, trigger: signal.trigger, breakoutGap: subtractDecimal(quote.last, signal.breakoutPrice), priceLimitGap: subtractDecimal(daily.dailyLimitPrice, quote.askPx), generation: intent.generation }, true);
    return { queued, reason: queued ? "BUY_QUEUED" : "BUY_QUEUE_REJECTED" };
  }
  pipelineCoverage() {
    return summarizeInstrumentPipelineCoverage({
      instIds: this.instIds, market: this.market, strategyConfig: this.strategyConfig, daily: this.daily,
      currentDay: this.currentDay, evaluatorSeen: this.evaluatorSeen, decisions: this.decisions,
    });
  }
  health() {
    const now = this.clock.nowMs(); const ages = this.instIds.map((instId) => this.lastEvaluationAt.get(instId)).filter((observedAt) => Number.isFinite(observedAt)).map((observedAt) => Math.max(0, now - observedAt));
    return { decision_missing_instruments: this.instIds.length - ages.length, decision_oldest_age_ms: ages.length ? Math.max(...ages) : 0 };
  }
}
