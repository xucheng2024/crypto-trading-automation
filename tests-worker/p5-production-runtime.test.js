import assert from "node:assert/strict";
import test from "node:test";

import { PanicReboundPlanner, firstBackfillTouch, openRowsFromTickers } from "../src/application/panic-rebound-planner.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";
import { MarketProjection, ReadyGate } from "../src/application/trading-engine.js";
import { strategyDayStartMs } from "../src/domain/rules.js";

const DAY = "2026-09-24";
const DAY_START = strategyDayStartMs(DAY);
const HOUR = 3_600_000;

// In-memory stand-in for the panic_daily_instruments repository, with the same
// write-once first-touch semantics and pg-style string bigints.
function memoryState(fills = []) {
  const rows = new Map(); const key = (day, instId) => `${day}:${instId}`;
  const copy = (row) => row ? { ...row } : null;
  return {
    rows, fills,
    listPanicDay: async (_tx, day) => [...rows.values()].filter((row) => row.strategy_day === day).map(copy),
    findPanicDayRow: async (_tx, day, instId) => copy(rows.get(key(day, instId))),
    claimDailyOpens: async (_tx, list) => { for (const row of list) if (!rows.has(key(row.strategyDay, row.instId))) rows.set(key(row.strategyDay, row.instId), { strategy_day: row.strategyDay, inst_id: row.instId, open_price: row.openPrice, open_ts: String(row.openTs), open_source: row.openSource, tick_sz: row.tickSz, count_price: row.countPrice, buy_price: row.buyPrice, count_hit_at: null, count_hit_price: null, count_hit_source: null, buy_hit_at: null, buy_hit_price: null }); return { rowCount: list.length }; },
    recordCountHit: async (_tx, { strategyDay, instId, hitAt, price, source }) => { const row = rows.get(key(strategyDay, instId)); if (!row || row.count_hit_at != null) return { rowCount: 0, rows: [] }; Object.assign(row, { count_hit_at: String(hitAt), count_hit_price: price, count_hit_source: source }); return { rowCount: 1, rows: [copy(row)] }; },
    recordBuyHit: async (_tx, { strategyDay, instId, hitAt, price }) => { const row = rows.get(key(strategyDay, instId)); if (!row || row.buy_hit_at != null || row.count_hit_at == null) return { rowCount: 0, rows: [] }; Object.assign(row, { buy_hit_at: String(hitAt), buy_hit_price: price }); return { rowCount: 1, rows: [copy(row)] }; },
    listManagedFills: async () => fills,
  };
}

function harness({ instIds = ["A-USDT", "B-USDT", "C-USDT", "D-USDT", "E-USDT", "F-USDT"], now = DAY_START + 10 * HOUR, state = memoryState(), tickers = null, candles = async () => [], capitalBlocked = () => false, cycles = new Map() } = {}) {
  const clock = { value: now, nowMs() { return this.value; } };
  const market = new MarketProjection({ clock });
  for (const instId of instIds) {
    market.updateInstrument({ instId, ts: 1, state: "live", tickSz: "0.01", lotSz: "0.001", minSz: "0.001", base: instId.split("-")[0], version: "1" });
    market.updateTicker({ instId, ts: now - 1, last: "100", askPx: "100", bidPx: "100" });
  }
  const intents = []; const events = []; const gate = new ReadyGate(); const candleCalls = [];
  const rest = { clockSkewMs: 0, clockFresh: () => true, tickers: async () => tickers ?? instIds.map((instId) => ({ instId, ts: String(clock.value), sodUtc8: "100", low24h: "95", last: "100" })), candles: async (instId, options) => { candleCalls.push([instId, options]); return candles(instId, options); } };
  const planner = new PanicReboundPlanner({ accountId: "a", instIds, market, state, transaction: async (fn) => fn({}), rest, readyGate: gate, clock, telemetry: (event) => events.push(event),
    coordinator: { enqueue: (intent) => Boolean(intents.push(intent)), buyCapitalBlocked: capitalBlocked },
    orders: { listBuyCycle: async (_tx, _account, instId) => ({ attempts: cycles.get(instId) ?? [], consumedUsd: "0" }) } });
  const tick = (instId, last, askPx = last, ts = clock.value) => { clock.value = Math.max(clock.value, ts); market.updateTicker({ instId, ts, last, askPx, bidPx: last }); };
  const observe = async (instId) => (await planner.observe({ type: "ticker", instId })).reason;
  return { clock, market, planner, intents, events, gate, state, tick, observe, candleCalls };
}

test("P5 panic planner counts every 82% touch, skips the first two forever, and buys later candidates at 72%", async () => {
  const h = harness();
  h.planner.restore({ protection: [{ inst_id: "F-USDT", state: "BLACKLISTED" }], ledger: [] });
  await h.planner.prime();
  assert.equal(h.gate.snapshot().dependencies.strategy, true);
  assert.deepEqual([...h.state.rows.values()].map((row) => [row.inst_id, row.open_price, row.count_price, row.buy_price]).slice(0, 1), [["A-USDT", "100", "82", "72"]]);
  assert.equal(await h.observe("E-USDT"), "ABOVE_COUNT_PRICE");
  const t = DAY_START + 10 * HOUR;
  h.tick("A-USDT", "81", "81", t + 1); h.tick("B-USDT", "81.5", "81.5", t + 2); h.tick("F-USDT", "80", "80", t + 3); h.tick("C-USDT", "81", "81", t + 4);
  // D gaps from 100 straight through both levels in one tick.
  h.tick("D-USDT", "71", "71.9", t + 5);
  // Planner events can be processed out of exchange order; ranks use touch time.
  assert.equal(await h.observe("D-USDT"), "SKIPPED_FIRST_TWO", "with only D recorded its provisional rank is 1: conservative until earlier touches land");
  for (const instId of ["C-USDT", "A-USDT", "F-USDT", "B-USDT"]) await h.observe(instId);
  assert.deepEqual(["A-USDT", "B-USDT", "F-USDT", "C-USDT", "D-USDT"].map((instId) => h.planner.rank(instId)), [1, 2, 3, 4, 5]);
  assert.equal(await h.observe("A-USDT"), "SKIPPED_FIRST_TWO"); assert.equal(await h.observe("B-USDT"), "SKIPPED_FIRST_TWO");
  assert.equal(await h.observe("F-USDT"), "ABOVE_BUY_PRICE", "a blacklisted symbol still counts toward the tally");
  assert.equal(await h.observe("C-USDT"), "ABOVE_BUY_PRICE");
  assert.equal(await h.observe("D-USDT"), "BUY_QUEUED");
  assert.deepEqual([h.intents[0].instId, h.intents[0].limitPrice, h.intents[0].countRank, h.intents[0].generation, h.intents[0].holdHours, h.intents[0].triggerAt, h.intents[0].strategyDay], ["D-USDT", "72", 5, 0, "3", t + 5, DAY]);
  assert.equal(h.intents[0].anchor.ts, DAY_START); assert.match(h.intents[0].decisionId, /^D[A-Z2-7]{26}$/);
  h.tick("A-USDT", "60", "60", t + 6);
  assert.equal(await h.observe("A-USDT"), "SKIPPED_FIRST_TWO", "the first two are never bought even far below 72%");
  h.tick("F-USDT", "70", "70", t + 7);
  assert.equal(await h.observe("F-USDT"), "INSTRUMENT_PROTECTED", "counted but never bought");
  h.tick("C-USDT", "71.5", "72.01", t + 8);
  assert.equal(await h.observe("C-USDT"), "ASK_ABOVE_LIMIT", "an IOC at 72% cannot fill against a higher ask");
  h.tick("C-USDT", "71.5", "71.99", t + 9);
  assert.equal(await h.observe("C-USDT"), "BUY_QUEUED", "a second candidate can buy with leftover capital");
  assert.equal(h.state.rows.get(`${DAY}:D-USDT`).count_hit_source, "LIVE"); assert.equal(h.state.rows.get(`${DAY}:D-USDT`).buy_hit_at, String(t + 5));
  assert.ok(h.events.some((event) => event.reason === "COUNT_HIT_RECORDED" && event.instId === "D-USDT"));
  assert.ok(h.events.some((event) => event.reason === "BUY_PRICE_REACHED" && event.instId === "D-USDT"));
});

test("P5 panic planner records a coalesced wick and keeps retrying the same symbol with new generations", async () => {
  const cycles = new Map();
  const h = harness({ instIds: ["A-USDT", "B-USDT", "C-USDT"], cycles });
  await h.planner.prime();
  const t = DAY_START + 11 * HOUR;
  h.tick("A-USDT", "80", "80", t + 1); h.tick("B-USDT", "80", "80", t + 2);
  h.tick("C-USDT", "70", "70", t + 3); h.tick("C-USDT", "90", "90", t + 4);
  assert.equal(await h.observe("A-USDT"), "SKIPPED_FIRST_TWO"); assert.equal(await h.observe("B-USDT"), "SKIPPED_FIRST_TWO");
  assert.equal(await h.observe("C-USDT"), "ABOVE_BUY_PRICE", "the wick is ranked even though the queue only saw 90");
  assert.equal(h.state.rows.get(`${DAY}:C-USDT`).count_hit_at, String(t + 3));
  assert.equal(h.state.rows.get(`${DAY}:C-USDT`).buy_hit_at, null, "the buy trigger needs a live quote at or below 72%");
  h.tick("C-USDT", "71", "71", t + 5);
  assert.equal(await h.observe("C-USDT"), "BUY_QUEUED");
  cycles.set("C-USDT", [{ state: "SUBMITTED", generation: 0, cl_ord_id: "active" }]);
  h.tick("C-USDT", "70.5", "70.5", t + 6);
  assert.equal(await h.observe("C-USDT"), "ACTIVE_BUY_ATTEMPT", "an UNKNOWN or open attempt blocks only this symbol");
  cycles.set("C-USDT", [{ state: "SETTLED", generation: 0, decision_market_key: "old" }]);
  assert.equal(await h.observe("C-USDT"), "BUY_QUEUED", "a partial fill leaves leftover capital for another IOC at the same limit");
  assert.equal(h.intents.at(-1).generation, 1);
});

test("P5 panic planner blocks on an earlier day's open position and spent capital, but not on today's fills", async () => {
  const fills = [];
  let blocked = false;
  const h = harness({ instIds: ["A-USDT", "B-USDT", "C-USDT"], state: memoryState(fills), capitalBlocked: () => blocked });
  await h.planner.prime();
  const t = DAY_START + 12 * HOUR;
  for (const [index, instId] of ["A-USDT", "B-USDT", "C-USDT"].entries()) h.tick(instId, "70", "70", t + index);
  for (const instId of ["A-USDT", "B-USDT"]) await h.observe(instId);
  h.planner.restore({ ledger: [{ side: "BUY", inst_id: "X-USDT", sell_state: "WAITING", fill_time: String(DAY_START - HOUR), fill_size: "1", disposed_size: "0" }] });
  assert.equal(await h.observe("C-USDT"), "PRIOR_POSITION_OPEN");
  h.planner.restore({ ledger: [{ side: "BUY", inst_id: "X-USDT", sell_state: "SOLD", fill_time: String(DAY_START - HOUR), fill_size: "1", disposed_size: "1" }, { side: "BUY", inst_id: "D-USDT", sell_state: "WAITING", fill_time: String(t - 1), fill_size: "1", disposed_size: "0" }] });
  blocked = true;
  assert.equal(await h.observe("C-USDT"), "CAPITAL_EXHAUSTED");
  blocked = false;
  assert.equal(await h.observe("C-USDT"), "BUY_QUEUED", "once the prior position is sold, a candidate still at or below 72% can be bought");
});

test("P5 panic planner restart backfills missed first touches before ranking and never re-seeds an open", async () => {
  const state = memoryState();
  const t = DAY_START + 9 * HOUR;
  const first = harness({ instIds: ["A-USDT", "B-USDT", "C-USDT"], state, now: t });
  await first.planner.prime();
  first.tick("C-USDT", "80", "80", t + 10 * 60_000); await first.observe("C-USDT");
  assert.equal(first.planner.rank("C-USDT"), 1);
  // Restart: A and B touched 82% while the process was down.
  const bars = { "A-USDT": [[String(t + 300_000), "90", "91", "81", "85"], [String(t), "95", "96", "90", "91"], [String(DAY_START - 300_000), "80", "80", "10", "80"]], "B-USDT": [[String(t + 600_000), "90", "91", "81.9", "85"]] };
  const restarted = harness({ instIds: ["A-USDT", "B-USDT", "C-USDT"], state, now: t + 20 * 60_000,
    tickers: ["A-USDT", "B-USDT", "C-USDT"].map((instId) => ({ instId, ts: String(t + 20 * 60_000), sodUtc8: "999", low24h: instId === "C-USDT" ? "80" : "81" })), candles: async (instId) => bars[instId] ?? [] });
  await restarted.planner.prime();
  assert.deepEqual(restarted.candleCalls.map(([instId, options]) => [instId, options.bar]), [["A-USDT", "5m"], ["B-USDT", "5m"]], "only unranked symbols whose 24h low reached the count price are read");
  assert.equal(state.rows.get(`${DAY}:A-USDT`).open_price, "100", "a later ticker never overwrites the day's open");
  assert.deepEqual(["A-USDT", "B-USDT", "C-USDT"].map((instId) => [restarted.planner.rank(instId), state.rows.get(`${DAY}:${instId}`).count_hit_source]), [[1, "BACKFILL"], [2, "BACKFILL"], [3, "LIVE"]], "a pre-day bar is ignored and C drops to rank 3");
  restarted.tick("C-USDT", "70", "70", t + 21 * 60_000);
  assert.equal(await restarted.observe("C-USDT"), "BUY_QUEUED");
  const failing = harness({ instIds: ["A-USDT"], state: memoryState(), tickers: [{ instId: "A-USDT", ts: String(DAY_START + HOUR), sodUtc8: "100", low24h: "50" }], candles: async () => { throw new Error("candles unavailable"); } });
  await assert.rejects(failing.planner.prime(), /candles unavailable/);
  assert.equal(failing.gate.snapshot().dependencies.strategy, false, "an unreadable backfill fails closed instead of mis-ranking");
});

test("P5 panic planner seeds opens only from same-day tickers and refreshes on the next day", async () => {
  assert.deepEqual(openRowsFromTickers({ day: DAY, instIds: new Set(["A-USDT", "B-USDT", "C-USDT"]), instrument: () => ({ tickSz: "0.01" }), tickers: [
    { instId: "A-USDT", ts: String(DAY_START - 1), sodUtc8: "100" }, { instId: "B-USDT", ts: String(DAY_START), sodUtc8: "50" }, { instId: "C-USDT", ts: String(DAY_START), sodUtc8: "0" }, { instId: "Z-USDT", ts: String(DAY_START), sodUtc8: "1" },
  ] }).map((row) => [row.instId, row.openPrice, row.countPrice, row.buyPrice]), [["B-USDT", "50", "41", "36"]]);
  assert.deepEqual(firstBackfillTouch({ candles: [["300", "1", "1", "0.5", "1"], ["200", "1", "1", "0.8", "1"], ["100", "1", "1", "0.7", "1"]], dayStart: 150, countPrice: "0.82" }), { ts: 200, price: "0.8" });
  let refreshed = 0;
  const h = harness({ instIds: ["A-USDT"], tickers: [{ instId: "A-USDT", ts: String(DAY_START - 10), sodUtc8: "100" }] });
  h.planner.refreshUniverse = async () => { refreshed += 1; };
  await h.planner.prime();
  assert.equal(await h.observe("A-USDT"), "DAILY_OPEN_PENDING", "a pre-midnight snapshot never seeds today's open");
  h.clock.value = DAY_START + 86_400_000 + 1;
  assert.equal(await h.observe("A-USDT"), "STRATEGY_DAY_REFRESH");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed, 1, "each new strategy day refreshes the live USDT universe");
  assert.equal(h.planner.currentDay, "2026-09-25");
});

test("P5 panic planner never evaluates a new day's ticks against yesterday's rows while the rollover sync is in flight", async () => {
  const h = harness({ instIds: ["A-USDT", "B-USDT", "C-USDT"] });
  await h.planner.prime();
  const t = DAY_START + 23 * HOUR;
  for (const [index, instId] of ["A-USDT", "B-USDT", "C-USDT"].entries()) h.tick(instId, "71", "71", t + index);
  for (const instId of ["A-USDT", "B-USDT"]) await h.observe(instId);
  // Midnight: the new day's ticker snapshot is slow to arrive.
  let release; const slow = new Promise((resolve) => { release = resolve; });
  const rest = h.planner.rest; const tickers = rest.tickers; rest.tickers = async () => { await slow; return tickers(); };
  const next = DAY_START + 86_400_000 + 1_000;
  h.clock.value = next; h.tick("C-USDT", "71", "71", next);
  assert.equal(await h.observe("C-USDT"), "STRATEGY_DAY_REFRESH");
  assert.equal(await h.observe("C-USDT"), "STRATEGY_DAY_REFRESH", "until the new day's opens are applied, nothing uses yesterday's 72% limit");
  assert.equal(h.intents.length, 0);
  release(); await h.planner.primePromise;
  assert.equal(h.planner.currentDay, "2026-09-25");
  assert.equal(await h.observe("C-USDT"), "SKIPPED_FIRST_TWO", "on the new day C is re-ranked from scratch: it is that day's first touch");
  assert.equal(h.intents.length, 0);
});

test("P5 panic planner ignores prior-day dust but blocks on a real prior-day position", async () => {
  const h = harness({ instIds: ["A-USDT"] });
  const prior = { side: "BUY", inst_id: "A-USDT", sell_state: "SELL_TRIGGERED", fill_time: String(DAY_START - HOUR), fill_price: "72" };
  h.planner.restore({ ledger: [{ ...prior, fill_size: "13.881", disposed_size: "13.867" }] });
  assert.equal(h.planner.hasPriorDayPosition(DAY), false, "0.014 units worth ~1 USDT is dust even while SELL_TRIGGERED");
  h.planner.restore({ ledger: [{ ...prior, fill_size: "13.881", disposed_size: "13.8805" }] });
  assert.equal(h.planner.hasPriorDayPosition(DAY), false, "below the instrument minimum size");
  h.planner.restore({ ledger: [{ ...prior, fill_size: "13.881", disposed_size: "13" }] });
  assert.equal(h.planner.hasPriorDayPosition(DAY), true, "0.881 units worth ~63 USDT is a real position");
  h.planner.restore({ ledger: [{ ...prior, sell_state: "DUST_PENDING", fill_size: "13.881", disposed_size: "0" }] });
  assert.equal(h.planner.hasPriorDayPosition(DAY), false, "DUST_PENDING never blocks");
  h.planner.restore({ ledger: [{ ...prior, fill_time: String(DAY_START + HOUR), fill_size: "13.881", disposed_size: "0" }] });
  assert.equal(h.planner.hasPriorDayPosition(DAY), false, "today's own fills never block buying with leftover USDT");
});

test("P5 panic planner pipeline coverage counts stages without listing names", async () => {
  const h = harness({ instIds: ["A-USDT", "B-USDT", "C-USDT"] });
  await h.planner.prime();
  h.tick("A-USDT", "70", "70"); await h.observe("A-USDT");
  const coverage = h.planner.pipelineCoverage();
  assert.deepEqual(coverage, { type: "instrument_pipeline_coverage", reason: "PIPELINE_COVERAGE", runtime: 3, strategyDay: DAY, quote_ready: 3, open_ready: 3, count_hit: 1, candidate: 0, buy_hit: 0, evaluator_seen: 1, no_market_data: 0, open_missing: 0 });
  assert.equal(JSON.stringify(coverage).includes("A-USDT"), false);
  assert.deepEqual(h.planner.health(), { decision_missing_instruments: 2, decision_oldest_age_ms: 0 });
});

test("P5 private terminal order observation loads fills and closes the durable attempt", async () => {
  const settled = []; const attempt = { intent: "BUY", inst_id: "BTC-USDT", cl_ord_id: "P5BUY", ord_id: "10" };
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true, onLost: () => {} }, readyGate: new ReadyGate(), safetyWaitMs: 0, transaction: async (fn) => fn({}),
    orders: { findByClOrdId: async () => attempt }, state: {}, transport: {
      fills: async (type) => type === "SPOT" ? [{ instId: "BTC-USDT", ordId: "10", clOrdId: "P5BUY", tradeId: "1", fillSz: "1", fillPx: "90", fillTime: "2" }] : [], fillsHistory: async () => [],
    }, onTerminal: async (value) => settled.push(value),
  });
  assert.deepEqual(await service.observeOrder({ instId: "BTC-USDT", clOrdId: "P5BUY", ordId: "10", state: "filled", accFillSz: "1" }), { handled: true });
  assert.equal(settled.length, 1); assert.equal(settled[0].fills[0].fillPx, "90"); assert.equal(settled[0].accFillSz, "1");
});
