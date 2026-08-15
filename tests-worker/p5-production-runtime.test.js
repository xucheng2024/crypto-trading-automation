import assert from "node:assert/strict";
import test from "node:test";

import { BuySignalPlanner, selectDailyCandles } from "../src/application/buy-signal-planner.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";
import { AccountCapitalSnapshot, MarketProjection, ReadyGate } from "../src/application/trading-engine.js";

const current = Date.parse("2026-08-14T12:00:00+08:00");
const today = Date.parse("2026-08-14T00:00:00+08:00");
const yesterday = Date.parse("2026-08-13T00:00:00+08:00");

test("P5 daily selection and production planner create a BUY only above the strict 3m breakout", async () => {
  const rows = [
    [String(today), "100", "105", "90", "94", "1", "1", "1", "0"],
    [String(yesterday), "100", "101", "90", "100", "1", "1", "1", "1"],
  ];
  assert.deepEqual(selectDailyCandles(rows, "2026-08-14"), { todayCandleTs: today, todayOpen: "100", yesterdayCandleTs: yesterday, yesterdayOpen: "100", yesterdayClose: "100" });
  const clock = { nowMs: () => current }; const market = new MarketProjection({ clock });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: "BTC", version: "1" });
  market.updateTicker({ instId: "BTC-USDT", ts: current, last: "94.9", askPx: "94.9", bidPx: "94.8" });
  market.updateCandle({ instId: "BTC-USDT", ts: current - 180_000, open: "93", high: "94.5", low: "92", close: "94", confirm: true });
  const account = new AccountCapitalSnapshot({ clock }); account.update({ ts: current, totalEq: "100", adjEq: "99" });
  const gate = new ReadyGate(); const stored = new Map(); const intents = []; const events = []; const metricNames = [];
  const state = {
    findDaily: async (_tx, instId, day) => stored.get(`${instId}:${day}`),
    claimDaily: async (_tx, row) => { stored.set(`${row.instId}:${row.strategyDay}`, row); return row; },
    recordAdversePrice: async () => ({ rowCount: 0 }), listManagedFills: async () => [],
  };
  const planner = new BuySignalPlanner({ accountId: "a", instIds: ["BTC-USDT"], strategyConfig: { contentHash: "a".repeat(64), rows: { "BTC-USDT": { bestLimit: "95", holdHours: "6" } } }, market, account,
    coordinator: { enqueue: (intent) => Boolean(intents.push(intent)) }, state, orders: { listBuyCycle: async () => ({ attempts: [], consumedUsd: "0" }) }, transaction: async (fn) => fn({}), rest: { clockSkewMs: 0, clockFresh: () => true, candles: async (_instId, options) => options.bar === "1D" ? rows : [[String(current - 180_000), "93", "94.5", "92", "94", "1", "1", "1", "1"]] }, readyGate: gate, clock, telemetry: (event) => events.push(event), slo: { record: (name) => metricNames.push(name) },
  });
  await planner.prime(); assert.equal(gate.snapshot().dependencies.strategy, true); assert.equal(stored.get("BTC-USDT:2026-08-14").todayOpen, "100");
  assert.deepEqual(await planner.observe({ type: "ticker", instId: "BTC-USDT" }), { queued: true, reason: "BUY_QUEUED" });
  assert.equal(intents[0].dailyLimitPrice, "95"); assert.equal(intents[0].breakoutPrice, "94.7835"); assert.equal(intents[0].holdHours, "6");
  assert.match(intents[0].decisionId, /^D[A-Z2-7]{26}$/); assert.equal(events.find((event) => event.reason === "BUY_QUEUED").decisionId, intents[0].decisionId);
  assert.ok(metricNames.includes("buy_cycle_tx"));
  market.updateTicker({ instId: "BTC-USDT", ts: current + 1, last: "94.7835", askPx: "94.7835", bidPx: "94.7" });
  assert.equal((await planner.observe({ type: "ticker", instId: "BTC-USDT" })).reason, "BREAKOUT_NOT_CONFIRMED");
  assert.ok(events.some((event) => event.reason === "BUY_QUEUED")); assert.ok(events.some((event) => event.reason === "BREAKOUT_NOT_CONFIRMED"));
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

test("P5 private external order observation immediately ingests an ACCOUNT buy and refreshes its projections", async () => {
  const stored = []; const refreshed = []; let inTransaction = false;
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true, onLost: () => {} }, readyGate: new ReadyGate(), safetyWaitMs: 0, transaction: async (fn) => { inTransaction = true; try { return await fn({}); } finally { inTransaction = false; } },
    ownership: { accountId: "a", managedAfter: 0, enabledInstIds: ["BTC-USDT"], holdHoursByInst: { "BTC-USDT": "24" }, configHash: "cfg" },
    orders: { findByClOrdId: async () => null }, state: { insertFill: async (_tx, row) => { stored.push(row); return { rowCount: 1 }; } },
    transport: { fills: async (type) => type === "SPOT" ? [{ instId: "BTC-USDT", instType: "SPOT", side: "buy", ordId: "external-1", tradeId: "trade-1", fillSz: "1", fillPx: "90", fillTime: "2" }] : [], fillsHistory: async () => [] },
    onAccountBuy: async (instId) => { assert.equal(inTransaction, false, "projection refresh runs only after the fill transaction commits"); refreshed.push(instId); },
  });
  assert.deepEqual(await service.observeOrder({ instId: "BTC-USDT", ordId: "external-1", state: "filled", accFillSz: "1", tdMode: "cross" }), { handled: true, source: "ACCOUNT", fills: 1 });
  assert.deepEqual(stored.map((row) => [row.source, row.side, row.sellState]), [["ACCOUNT", "BUY", "WAITING"]]);
  assert.deepEqual(refreshed, ["BTC-USDT"]);
});

test("P5 planner refuses a new BUY when any managed position lacks a fresh quote", async () => {
  const clock = { nowMs: () => current }; const market = new MarketProjection({ clock });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: "BTC", version: "1" });
  market.updateTicker({ instId: "BTC-USDT", ts: current, last: "95", askPx: "95", bidPx: "94.9" });
  market.updateCandle({ instId: "BTC-USDT", ts: current - 180_000, high: "94", low: "90", confirm: true });
  const account = new AccountCapitalSnapshot({ clock }); account.update({ ts: current, totalEq: "100", adjEq: "100" });
  const intents = []; let restCalls = 0;
  const planner = new BuySignalPlanner({ accountId: "a", instIds: ["BTC-USDT"], strategyConfig: { contentHash: "b".repeat(64), rows: { "BTC-USDT": { bestLimit: "100", holdHours: "24" } } }, market, account,
    coordinator: { enqueue: (intent) => Boolean(intents.push(intent)) }, state: {}, orders: { listBuyCycle: async () => ({ attempts: [], consumedUsd: "0" }) }, transaction: async (fn) => fn({}), rest: { clockSkewMs: 0, clockFresh: () => true, tickers: async () => { restCalls += 1; return [{ instId: "ETH-USDT", ts: current, last: "10", bidPx: "9.9", askPx: "10" }]; } }, readyGate: new ReadyGate(), clock,
  });
  planner.currentDay = "2026-08-14"; planner.daily.set("BTC-USDT:2026-08-14", { status: "READY", dailyLimitPrice: "100" });
  planner.ledger = [{ account_id: "a", inst_id: "ETH-USDT", side: "BUY", fill_size: "1", disposed_size: "0" }];
  assert.deepEqual(await planner.observe({ type: "ticker", instId: "BTC-USDT" }), { queued: false, reason: "MANAGED_EXPOSURE_STALE" });
  await planner.quoteRefreshPromise;
  assert.equal(restCalls, 1); assert.equal(intents.length, 1); assert.equal(intents[0].managedExposure, "9.9");
});

function makeTwoInstrumentStaleQuotePlanner() {
  const clock = { nowMs: () => current }; const market = new MarketProjection({ clock });
  for (const instId of ["BTC-USDT", "SOL-USDT"]) {
    market.updateInstrument({ instId, ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: instId.split("-")[0], version: "1" });
    market.updateTicker({ instId, ts: current, last: "95", askPx: "95", bidPx: "94.9" });
    market.updateCandle({ instId, ts: current - 180_000, high: "94", low: "90", confirm: true });
  }
  const account = new AccountCapitalSnapshot({ clock }); account.update({ ts: current, totalEq: "100", adjEq: "100" });
  const intents = []; let restCalls = 0;
  const planner = new BuySignalPlanner({ accountId: "a", instIds: ["BTC-USDT", "SOL-USDT"], strategyConfig: { contentHash: "d".repeat(64), rows: { "BTC-USDT": { bestLimit: "100", holdHours: "24" }, "SOL-USDT": { bestLimit: "100", holdHours: "24" } } }, market, account,
    coordinator: { enqueue: (intent) => Boolean(intents.push(intent)) }, state: {}, orders: { listBuyCycle: async () => ({ attempts: [], consumedUsd: "0" }) }, transaction: async (fn) => fn({}),
    rest: { clockSkewMs: 0, clockFresh: () => true, tickers: async () => { restCalls += 1; return [{ instId: "ETH-USDT", ts: current, last: "10", bidPx: "9.9", askPx: "10" }]; } }, readyGate: new ReadyGate(), clock,
  });
  planner.currentDay = "2026-08-14";
  planner.daily.set("BTC-USDT:2026-08-14", { status: "READY", dailyLimitPrice: "100" });
  planner.daily.set("SOL-USDT:2026-08-14", { status: "READY", dailyLimitPrice: "100" });
  planner.ledger = [{ account_id: "a", inst_id: "ETH-USDT", side: "BUY", fill_size: "1", disposed_size: "0" }];
  return { planner, intents, restCalls: () => restCalls };
}

test("P5 planner replays every instrument stalled behind a shared quote refresh, driven end to end through observe()", async () => {
  const { planner, intents } = makeTwoInstrumentStaleQuotePlanner();
  // Both go stale through the real observe() path: BTC-USDT's own trigger starts the shared
  // refresh; SOL-USDT's trigger arrives while it's already in flight and must not be dropped.
  assert.deepEqual(await planner.observe({ type: "ticker", instId: "BTC-USDT" }), { queued: false, reason: "MANAGED_EXPOSURE_STALE" });
  await planner.observe({ type: "ticker", instId: "SOL-USDT" });
  while (planner.quoteRefreshPromise) await planner.quoteRefreshPromise;
  assert.equal(planner.pendingQuoteRecheck.size, 0);
  assert.deepEqual(intents.map((intent) => intent.instId).sort(), ["BTC-USDT", "SOL-USDT"]);
});

test("P5 planner starts a fresh drain when a trigger lands between an inner drain settling and an old-style finalizer", async () => {
  const { planner, intents } = makeTwoInstrumentStaleQuotePlanner();
  // Register this continuation on the inner drain *before* refreshManagedQuotes
  // could register an external .finally().  With the old implementation it
  // runs first, sees the old outer promise still set, and strands BTC in the
  // Set after that finalizer clears it.  Inline clearing makes this start a
  // genuinely new drain instead.
  const drain = planner._drainQuoteRecheck.bind(planner); let second; let injectOnce = true;
  planner._drainQuoteRecheck = () => {
    const current = drain();
    if (injectOnce) {
      injectOnce = false;
      current.then(() => { second = planner.refreshManagedQuotes("BTC-USDT"); });
    }
    return current;
  };
  const first = planner.refreshManagedQuotes("SOL-USDT");
  await first;
  assert.ok(second, "the inner-drain continuation fired");
  assert.notEqual(second, first);
  await second;
  assert.equal(planner.pendingQuoteRecheck.size, 0);
  assert.deepEqual(intents.map((intent) => intent.instId).sort(), ["BTC-USDT", "SOL-USDT"]);
});

test("P5 planner blocks a new-day duplicate position but permits the current BUY cycle", async () => {
  const clock = { nowMs: () => current }; const market = new MarketProjection({ clock });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: "BTC", version: "1" });
  market.updateTicker({ instId: "BTC-USDT", ts: current, last: "95", askPx: "95", bidPx: "94.9" }); market.updateCandle({ instId: "BTC-USDT", ts: current - 180_000, high: "94", low: "90", confirm: true });
  const account = new AccountCapitalSnapshot({ clock }); account.update({ ts: current, totalEq: "100", adjEq: "100" }); const intents = []; let attempts = [];
  const planner = new BuySignalPlanner({ accountId: "a", instIds: ["BTC-USDT"], strategyConfig: { contentHash: "c".repeat(64), rows: { "BTC-USDT": { bestLimit: "100", holdHours: "24" } } }, market, account,
    coordinator: { enqueue: (intent) => Boolean(intents.push(intent)) }, state: {}, orders: { listBuyCycle: async () => ({ attempts, consumedUsd: "10" }) }, transaction: async (fn) => fn({}), rest: { clockSkewMs: 0, clockFresh: () => true }, readyGate: new ReadyGate(), clock,
  });
  planner.currentDay = "2026-08-14"; planner.daily.set("BTC-USDT:2026-08-14", { status: "READY", dailyLimitPrice: "100" }); planner.ledger = [{ account_id: "a", inst_id: "BTC-USDT", side: "BUY", fill_size: "0.1", disposed_size: "0" }];
  assert.equal((await planner.observe({ type: "ticker", instId: "BTC-USDT" })).reason, "STRATEGY_POSITION_EXISTS");
  attempts = [{ state: "SETTLED", generation: 0, decision_market_key: "old", frozen_target_usd: "295" }]; market.updateTicker({ instId: "BTC-USDT", ts: current + 1, last: "95.1", askPx: "95.1", bidPx: "95" });
  assert.equal((await planner.observe({ type: "ticker", instId: "BTC-USDT" })).reason, "BUY_QUEUED"); assert.equal(intents.length, 1);
});

test("P5 planner blocks pending/stale candles and stale exchange clock, then self-heals on the expected candle", async () => {
  const clock = { value: current, nowMs() { return this.value; } }; const market = new MarketProjection({ clock });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: "BTC", version: "1" });
  market.updateTicker({ instId: "BTC-USDT", ts: current, last: "95", askPx: "95", bidPx: "94.9" });
  market.updateCandle({ instId: "BTC-USDT", ts: current - 360_000, high: "94", low: "90", confirm: true });
  const account = new AccountCapitalSnapshot({ clock }); account.update({ ts: current, totalEq: "100", adjEq: "100" }); const intents = []; let clockIsFresh = true;
  const planner = new BuySignalPlanner({ accountId: "a", instIds: ["BTC-USDT"], strategyConfig: { contentHash: "d".repeat(64), rows: { "BTC-USDT": { bestLimit: "100", holdHours: "24" } } }, market, account,
    coordinator: { enqueue: (intent) => Boolean(intents.push(intent)) }, state: {}, orders: { listBuyCycle: async () => ({ attempts: [], consumedUsd: "0" }) }, transaction: async (fn) => fn({}), rest: { clockSkewMs: 0, clockFresh: () => clockIsFresh }, readyGate: new ReadyGate(), clock,
  });
  planner.currentDay = "2026-08-14"; planner.daily.set("BTC-USDT:2026-08-14", { status: "READY", dailyLimitPrice: "100" });
  assert.equal((await planner.observe({ type: "ticker", instId: "BTC-USDT" })).reason, "CANDLE_PENDING");
  clock.value += 31_000; market.updateTicker({ instId: "BTC-USDT", ts: clock.value, last: "95", askPx: "95", bidPx: "94.9" });
  assert.equal((await planner.observe({ type: "ticker", instId: "BTC-USDT" })).reason, "CANDLE_STALE");
  market.updateCandle({ instId: "BTC-USDT", ts: current - 180_000, high: "94", low: "90", confirm: true }); clockIsFresh = false;
  assert.equal((await planner.observe({ type: "market-recheck", instId: "BTC-USDT" })).reason, "CLOCK_SYNC_STALE");
  clockIsFresh = true;
  assert.equal((await planner.observe({ type: "market-recheck", instId: "BTC-USDT" })).reason, "BUY_QUEUED"); assert.equal(intents.length, 1);
});
