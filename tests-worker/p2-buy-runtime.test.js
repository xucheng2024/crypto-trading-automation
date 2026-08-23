import assert from "node:assert/strict";
import test from "node:test";

import { AccountCapitalSnapshot, BoundedPriorityQueue, MarketProjection, ReadyGate } from "../src/application/trading-engine.js";
import { OrderCoordinator } from "../src/application/order-coordinator.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";
import { VirtualSloMetrics } from "../src/application/slo-metrics.js";
import { payloadHash } from "../src/domain/order.js";
import { dailyLimit, expectedClosedCandleTs } from "../src/domain/rules.js";

const clock = (value = 0) => ({ value, nowMs() { return this.value; } });
const config = { accountId: "account", orderVersion: "P2", strategyTag: "STRAT", orderExpiryMs: 1_000, quoteFreshMs: 100, accountFreshMs: 100 };
const clockReady = { clockFresh: () => true, clockSkewMs: 0 };

function ready() { const gate = new ReadyGate(); for (const key of gate.required) gate.set(key, true); return gate; }
function setupMarket(now) {
  const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: "BTC", version: 1 });
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "95", askPx: "95", bidPx: "94" });
  market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), open: "90", high: "90", low: "89", confirm: true });
  return market;
}

test("P2 runtime coalesces ticker pressure and accepts same-ms corrections", () => {
  const now = clock(); const projection = new MarketProjection({ clock: now }); const queue = new BoundedPriorityQueue({ capacity: 1 });
  assert.equal(projection.updateTicker({ instId: "BTC-USDT", ts: 1, last: "10" }).accepted, true);
  assert.equal(projection.updateTicker({ instId: "BTC-USDT", ts: 1, last: "11" }).corrected, true);
  assert.equal(projection.updateTicker({ instId: "BTC-USDT", ts: 1, last: "11" }).reason, "DUPLICATE");
  assert.equal(projection.updateTicker({ instId: "BTC-USDT", ts: 0, last: "9" }).reason, "OUT_OF_ORDER");
  queue.enqueue({ type: "ticker", instId: "BTC-USDT", payload: 1 }); queue.enqueue({ type: "ticker", instId: "BTC-USDT", payload: 2 });
  assert.equal(queue.size, 1); assert.equal(queue.take().payload, 2);
});

test("P2 recovery keeps READY false, waits owner safety window, and treats PREPARED as query-only UNKNOWN", async () => {
  let waited = 0; const gate = ready(); const calls = [];
  const service = new ReconciliationService({
    ownerGuard: { isHeld: () => true }, readyGate: gate, safetyWaitMs: 50, sleep: async (ms) => { waited += ms; },
    transport: { order: async (query) => { calls.push(query); return { state: "NOT_FOUND" }; } },
    state: { listProtection: async () => [], listDaily: async () => [], listManagedFills: async () => [] },
    orders: { listNonTerminal: async () => [{ state: "PREPARED", clOrdId: "P" }, { state: "UNKNOWN", clOrdId: "U" }], listTodayBuys: async () => [], listWatermarks: async () => [] },
  });
  const result = await service.recover({ accountId: "account" });
  assert.equal(waited, 50); assert.equal(result.ready, false); assert.deepEqual(calls, [{ instId: undefined, clOrdId: "P" }, { instId: undefined, clOrdId: "U" }]);
  assert.equal(gate.ready, false); service.completeBaseline("public"); service.connectionLost("private"); assert.equal(gate.ready, false);
});

test("P2 BUY coordinator uses one fake batch, persists item-independent outcomes, and does not resend UNKNOWN", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150", mgnRatio: "2" });
  const attempts = new Map(); const events = []; const slo = new VirtualSloMetrics(now); let sends = 0;
  const orders = {
    async reserveBuy(_tx, attempt) { attempts.set(attempt.clOrdId, { ...attempt, state: "PREPARED", reservationState: "ACTIVE" }); return { authorized: true }; },
    async markSubmitted(_tx, id, ordId) { Object.assign(attempts.get(id), { state: "SUBMITTED", ordId }); },
    async markUnknown(_tx, id) { Object.assign(attempts.get(id), { state: "UNKNOWN" }); },
    async markNotCreated(_tx, id) { Object.assign(attempts.get(id), { state: "NOT_CREATED", reservationState: "RELEASED" }); },
    async markSettled(_tx, id) { Object.assign(attempts.get(id), { state: "SETTLED" }); },
  };
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders, state: { insertFill: async () => {} }, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: (instId) => instId === "SOL-USDT" ? "spot" : "margin", clock: now, config, slo, telemetry: (event) => events.push(event), transport: {
    ...clockReady,
    maxAvailSize: async (ids, options) => { assert.equal(options.tdMode, "cross"); assert.equal(options.ccy, "USDT"); return ids.split(",").map((instId) => ({ instId, availBuy: "100" })); },
    submitBatchOrders: async (payload) => { sends += 1; assert.equal(payload.length, 3); assert.ok(payload.filter((item) => item.instId !== "SOL-USDT").every((item) => item.tdMode === "cross" && item.ordType === "ioc" && item.tradeQuoteCcy === "USDT")); const spotOrder = payload.find((item) => item.instId === "SOL-USDT"); assert.equal(spotOrder.tdMode, "cross"); assert.equal("tradeQuoteCcy" in spotOrder, false); return [{ clOrdId: payload[0].clOrdId, status: "SUBMITTED", ordId: "1" }, { clOrdId: payload[1].clOrdId, status: "NOT_CREATED", reason: "rejected" }, { clOrdId: payload[2].clOrdId, status: "UNKNOWN", reason: "timeout" }]; },
  } });
  for (const instId of ["BTC-USDT", "ETH-USDT", "SOL-USDT"]) {
    if (instId !== "BTC-USDT") { market.updateInstrument({ instId, ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: instId.split("-")[0], version: 1 }); market.updateTicker({ instId, ts: 2, last: "95", askPx: "95", bidPx: "94" }); market.updateCandle({ instId, ts: expectedClosedCandleTs(now.nowMs()), open: "90", high: "90", low: "89", confirm: true }); }
    coordinator.enqueue({ intent: "BUY", decisionId: `decision-${instId}`, instId, generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg", tradeQuoteCcy: "USDT" });
  }
  const result = await coordinator.drainOnce();
  assert.equal(result.count, 3); assert.equal(sends, 1); assert.deepEqual([...attempts.values()].map((row) => row.state).sort(), ["NOT_CREATED", "SUBMITTED", "UNKNOWN"]);
  assert.deepEqual(slo.assertInvariants(), { maxBatchSize: 3, maxMutationConcurrency: 1, unknownCount: 1 }); assert.equal(slo.samples.get("signal_post")[0], 0);
  assert.ok([...attempts.values()].every((row) => row.decisionId === `decision-${row.instId}`)); assert.ok(events.filter((event) => event.type === "order_lifecycle").every((event) => event.decisionId));
  assert.equal(slo.samples.get("buy_reserve_db").length, 3); assert.deepEqual(slo.samples.get("buy_reservation_tx"), [0]);
  assert.equal(events.at(-1).count, 3); await coordinator.drainOnce(); assert.equal(sends, 1, "UNKNOWN is never blindly resent");
});

test("P5 BUY coordinator emits one structured block per unchanged decision stage", async () => {
  const now = clock(10); const events = [];
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market: setupMarket(now), account: new AccountCapitalSnapshot({ clock: now }), mode: () => "OFF", clock: now, config, telemetry: (event) => events.push(event), transport: clockReady });
  const intent = { intent: "BUY", decisionId: "D-BLOCK", instId: "BTC-USDT", generation: 0, strategyDay: "2026-08-14" };
  await coordinator.prepareBuys([intent]); await coordinator.prepareBuys([intent]);
  assert.deepEqual(events, [{ type: "block_evidence", side: "BUY", stage: "COORDINATOR_GUARD", reason: "MODE", reasonCode: "MODE", decisionId: "D-BLOCK", clOrdId: undefined, instId: "BTC-USDT", strategyDay: "2026-08-14", generation: 0, executionMode: undefined, executionRoute: undefined, currentMode: "OFF" }]);
});

test("P5 BUY availability failure emits bounded structured evidence and remains retryable", async () => {
  const now = clock(10); const events = []; const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market: setupMarket(now), account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config, telemetry: (event) => events.push(event), transport: { ...clockReady, maxAvailSize: async () => { throw new Error("temporary unavailable"); } } });
  const intent = { intent: "BUY", decisionId: "D-AVAIL", instId: "BTC-USDT", generation: 0, strategyDay: "2026-08-14", dailyLimitPrice: "100" };
  assert.deepEqual(await coordinator.prepareBuys([intent]), []); assert.deepEqual(await coordinator.prepareBuys([intent]), []);
  const blocks = events.filter((event) => event.type === "block_evidence"); assert.equal(blocks.length, 1); assert.equal(blocks[0].reason, "MAX_AVAIL_FAILED"); assert.equal(blocks[0].executionRoute, "margin");
});

test("P2 BUY final guard releases PREPARED reservation when owner, mode, READY, or freshness is lost", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  let held = true; const attempts = new Map(); let sends = 0;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: {}, market, account, readyGate: ready(), ownerGuard: { isHeld: () => held }, mode: () => "FULL", clock: now, config,
    orders: { reserveBuy: async (_tx, a) => { attempts.set(a.clOrdId, { ...a, state: "PREPARED" }); held = false; return { authorized: true }; }, markNotCreated: async (_tx, id) => Object.assign(attempts.get(id), { state: "NOT_CREATED", reservationState: "RELEASED" }) },
    transport: { ...clockReady, maxAvailSize: async () => [{ instId: "BTC-USDT", availBuy: "100" }], submitBatchOrders: async () => { sends += 1; return []; } },
  });
  coordinator.enqueue({ intent: "BUY", instId: "BTC-USDT", generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg" });
  assert.equal((await coordinator.drainOnce()).reason, "FINAL_GUARD"); assert.equal(sends, 0); assert.equal([...attempts.values()][0].reservationState, "RELEASED");
});

test("P2 BUY attempt uses the exact market snapshot admitted by its construction guard", async () => {
  const now = clock(720_000); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  const quoteA = { instId: "BTC-USDT", ts: 1, last: "95", askPx: "95", bidPx: "94" };
  const quoteB = { instId: "BTC-USDT", ts: 2, last: "96", askPx: "96", bidPx: "95" };
  const candleA = { instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), high: "90", low: "89", confirm: true };
  const candleB = { instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), high: "91", low: "90", confirm: true };
  const instrumentA = { instId: "BTC-USDT", state: "live", tickSz: "0.3", lotSz: "0.001", minSz: "0.001", base: "BTC", version: "A" };
  const instrumentB = { ...instrumentA, tickSz: "0.2", version: "B" };
  let quoteReads = 0; let candleReads = 0; let instrumentReads = 0; let tickerReads = 0; let attempt;
  const market = {
    freshQuote: () => quoteReads++ === 0 ? quoteA : quoteB,
    ticker: () => { tickerReads += 1; return quoteB; },
    candle: () => candleReads++ === 0 ? candleA : candleB,
    instrument: () => instrumentReads++ === 0 ? instrumentA : instrumentB,
  };
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: {}, market, account, readyGate: ready(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", executionRoute: () => "margin", tradeQuoteCurrency: () => "USDT", clock: now, config,
    orders: { reserveBuy: async (_tx, row) => { attempt = row; return { authorized: true }; }, markSubmitted: async () => {} },
    transport: { ...clockReady, submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "SUBMITTED", ordId: "snapshot" })) },
  });
  const result = await coordinator.submitBuys([{ intent: "BUY", instId: "BTC-USDT", generation: 0, strategyDay: "2026-08-14", dailyLimitPrice: "100.1", breakoutPrice: "1", holdHours: "24", configHash: "cfg", availBuy: "100" }]);
  assert.equal(result.submitted, true);
  assert.equal(tickerReads, 0, "attempt construction must not re-read the raw ticker");
  assert.equal(attempt.decisionQuoteHash, await payloadHash(quoteA));
  assert.equal(attempt.decisionCandleHash, await payloadHash(candleA));
  assert.equal(attempt.executionLimitPrice, "99.9");
  assert.equal(attempt.instrumentVersion, "A");
  assert.equal(attempt.decisionReferencePrice, "90.27", "reference price comes from the guard's candle, not the queued intent");
  assert.equal(attempt.decisionReason, "BUY_BREAKOUT_CONFIRMED");
});

test("P2 BUY attempt records BUY_DIP_CONFIRMED and the dip price as reference at generation 0", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  market.updateTicker({ instId: "BTC-USDT", ts: 3, last: "85", askPx: "85", bidPx: "84" });
  let attempt;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: {}, market, account, readyGate: ready(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", executionRoute: () => "margin", tradeQuoteCurrency: () => "USDT", clock: now, config,
    orders: { reserveBuy: async (_tx, row) => { attempt = row; return { authorized: true }; }, markSubmitted: async () => {} },
    transport: { ...clockReady, submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "SUBMITTED", ordId: "dip" })) },
  });
  const result = await coordinator.submitBuys([{ intent: "BUY", instId: "BTC-USDT", generation: 0, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg", availBuy: "100" }]);
  assert.equal(result.submitted, true);
  assert.equal(attempt.decisionReason, "BUY_DIP_CONFIRMED");
  assert.equal(attempt.decisionReferencePrice, "94");
});

test("P2 BUY guard blocks a DIP-only trigger once generation is no longer zero", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  market.updateTicker({ instId: "BTC-USDT", ts: 3, last: "85", askPx: "85", bidPx: "84" });
  const events = [];
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config, telemetry: (event) => events.push(event), transport: clockReady });
  const previousAttempt = { state: "SETTLED", decision_market_key: "old" };
  assert.deepEqual(await coordinator.prepareBuys([{ intent: "BUY", instId: "BTC-USDT", generation: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", previousAttempt, nextMarketKey: "new" }]), []);
  const block = events.find((event) => event.type === "block_evidence");
  assert.equal(block.reason, "DIP_FIRST_ENTRY_ONLY");
  assert.equal(block.dipPrice, "94");
});

test("P2 BUY guard fails closed on a DIP trigger when generation is missing or null", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  market.updateTicker({ instId: "BTC-USDT", ts: 3, last: "85", askPx: "85", bidPx: "84" });
  const eventsA = [];
  const coordinatorA = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config, telemetry: (event) => eventsA.push(event), transport: clockReady });
  assert.deepEqual(await coordinatorA.prepareBuys([{ intent: "BUY", instId: "BTC-USDT", strategyDay: "2026-08-14", dailyLimitPrice: "100" }]), []);
  assert.equal(eventsA.find((event) => event.type === "block_evidence").reason, "DIP_FIRST_ENTRY_ONLY");
  const eventsB = [];
  const coordinatorB = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config, telemetry: (event) => eventsB.push(event), transport: clockReady });
  assert.deepEqual(await coordinatorB.prepareBuys([{ intent: "BUY", instId: "BTC-USDT", generation: null, strategyDay: "2026-08-14", dailyLimitPrice: "100" }]), []);
  assert.equal(eventsB.find((event) => event.type === "block_evidence").reason, "DIP_FIRST_ENTRY_ONLY");
});

test("P2 BUY guard allows a generation 1 buy when BREAKOUT confirms even inside the DIP zone", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  market.updateTicker({ instId: "BTC-USDT", ts: 3, last: "92", askPx: "92", bidPx: "91" });
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config, transport: { ...clockReady, maxAvailSize: async () => [{ instId: "BTC-USDT", availBuy: "100" }] } });
  const previousAttempt = { state: "SETTLED", decision_market_key: "old" };
  const prepared = await coordinator.prepareBuys([{ intent: "BUY", instId: "BTC-USDT", generation: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", previousAttempt, nextMarketKey: "new" }]);
  assert.equal(prepared.length, 1);
});

test("P2 BUY guard evidence does not throw when price is outside the daily limit", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  market.updateTicker({ instId: "BTC-USDT", ts: 3, last: "101", askPx: "101", bidPx: "100" });
  const events = [];
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config, telemetry: (event) => events.push(event), transport: clockReady });
  await assert.doesNotReject(coordinator.prepareBuys([{ intent: "BUY", instId: "BTC-USDT", generation: 0, strategyDay: "2026-08-14", dailyLimitPrice: "100" }]));
  const block = events.find((event) => event.type === "block_evidence");
  assert.equal(block.reason, "PRICE_OUTSIDE");
  assert.equal(block.breakoutPrice, "90.27");
  assert.equal(block.dipPrice, "94");
});

test("P2 BUY submit trusts the fresh guard signal over a stale queued DIP trigger", async () => {
  const now = clock(720_000); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  const quote = { instId: "BTC-USDT", ts: 1, last: "92", askPx: "92", bidPx: "91" };
  const candle = { instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), high: "90", low: "89", confirm: true };
  const instrument = { instId: "BTC-USDT", state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: "BTC", version: "A" };
  const market = { freshQuote: () => quote, ticker: () => quote, candle: () => candle, instrument: () => instrument };
  let attempt;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: {}, market, account, readyGate: ready(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", executionRoute: () => "margin", tradeQuoteCurrency: () => "USDT", clock: now, config,
    orders: { reserveBuy: async (_tx, row) => { attempt = row; return { authorized: true }; }, markSubmitted: async () => {} },
    transport: { ...clockReady, submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "SUBMITTED", ordId: "stale-trigger" })) },
  });
  const result = await coordinator.submitBuys([{ intent: "BUY", instId: "BTC-USDT", generation: 0, strategyDay: "2026-08-14", dailyLimitPrice: "100", trigger: "DIP", breakoutPrice: "1", dipPrice: "1", holdHours: "24", configHash: "cfg", availBuy: "100" }]);
  assert.equal(result.submitted, true);
  assert.equal(attempt.decisionReason, "BUY_BREAKOUT_CONFIRMED");
  assert.equal(attempt.decisionReferencePrice, "90.27");
});

test("P2 BUY guard evaluates DIP against the cached daily limit, not a tickSz-rounded execution price", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  // tickSz changed intraday from what the planner originally saw (e.g. "0.1") to "1": rounding
  // dailyLimitPrice="99.9" down to tickSz=1 gives limitPrice=99 -> dipPrice=93.06, while the
  // planner (which never tick-rounds) computed dipPrice=99.9*0.94=93.906 from the cached daily
  // limit. last=93.5 falls between the two thresholds and must be judged consistently.
  market.updateInstrument({ instId: "BTC-USDT", ts: 2, state: "live", tickSz: "1", lotSz: "0.001", minSz: "0.001", base: "BTC", version: 2 });
  market.updateTicker({ instId: "BTC-USDT", ts: 3, last: "93.5", askPx: "93.5", bidPx: "93.4" });
  market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), high: "200", low: "199", confirm: true });
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config, transport: { ...clockReady, maxAvailSize: async () => [{ instId: "BTC-USDT", availBuy: "100" }] } });
  const prepared = await coordinator.prepareBuys([{ intent: "BUY", instId: "BTC-USDT", generation: 0, strategyDay: "2026-08-14", dailyLimitPrice: "99.9" }]);
  assert.equal(prepared.length, 1, "93.5 must clear the DIP line computed from the cached 99.9 daily limit (93.906), matching what the planner already queued against");
});

test("P2 BUY enqueue dedupes pending DIP intents per instId so a second tick cannot open a second generation 0 attempt", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config, transport: clockReady });
  coordinator.enqueue({ intent: "BUY", instId: "BTC-USDT", decisionId: "D-DIP-1", generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", trigger: "DIP" });
  coordinator.enqueue({ intent: "BUY", instId: "BTC-USDT", decisionId: "D-DIP-2", generation: 0, eligibleSince: 2, strategyDay: "2026-08-14", dailyLimitPrice: "100", trigger: "DIP" });
  assert.equal(coordinator.pending.BUY.size, 1);
  assert.equal(coordinator.pending.BUY.get("BTC-USDT").decisionId, "D-DIP-2", "the latest market snapshot replaces the earlier pending intent, never adds a second one");
});

test("P5 route refresh cannot change a BUY route between availability and submission", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  let route = "margin"; let quote = "USDT";
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => route, tradeQuoteCurrency: () => quote, clock: now, config,
    transport: { ...clockReady, maxAvailSize: async () => { route = "spot"; quote = null; return [{ instId: "BTC-USDT", availBuy: "100" }]; } },
  });
  const prepared = await coordinator.prepareBuys([{ intent: "BUY", instId: "BTC-USDT", generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg", executionMode: "cash" }]);
  assert.equal(prepared[0].executionMode, "cross"); assert.equal(prepared[0].executionRoute, "margin"); assert.equal(prepared[0].tradeQuoteCcy, "USDT"); assert.equal(route, "spot");
});

test("P5 zero margin-route availability never retries the same instrument as a spot route", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150" });
  const modes = []; let submissions = 0;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), orders: {}, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", clock: now, config,
    transport: { ...clockReady, maxAvailSize: async (_ids, options) => { modes.push(options.tdMode); return [{ instId: "BTC-USDT", availBuy: "0" }]; }, submitBatchOrders: async () => { submissions += 1; return []; } },
  });
  coordinator.enqueue({ intent: "BUY", instId: "BTC-USDT", generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg" });
  assert.equal((await coordinator.drainOnce()).reason, "NO_ELIGIBLE"); assert.deepEqual(modes, ["cross"]); assert.equal(submissions, 0);
});

test("P5 BUY sizing uses the full fresh OKX capacity without an equity cap", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  let attempt;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => "FULL", executionRoute: () => "margin", tradeQuoteCurrency: () => "USDT", clock: now, config,
    orders: { reserveBuy: async (_tx, row) => { attempt = row; return { authorized: true }; }, markSubmitted: async () => {} },
    transport: { ...clockReady, maxAvailSize: async () => [{ instId: "BTC-USDT", availBuy: "1000" }], submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "SUBMITTED", ordId: "one" })) },
  });
  coordinator.enqueue({ intent: "BUY", instId: "BTC-USDT", generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg" });
  assert.equal((await coordinator.drainOnce()).submitted, true);
  assert.equal(attempt.plannedSize, "9.995");
  assert.equal(attempt.reservedExposureUsd, "999.99975");
});

test("P2 recovery paginates fills/history, deduplicates tradeId, persists watermarks, and keeps a lone NOT_FOUND UNKNOWN", async () => {
  const stored = []; const watermarks = []; const calls = [];
  const page = (name) => async (instType, params = {}) => {
    calls.push(`${name}:${instType}:${params.after ?? "first"}`);
    if (params.after) return { data: [] };
    return { data: [{ instId: "BTC-USDT", instType, side: "buy", tradeId: `${instType}-2`, ordId: "o", fillTime: "20", billId: "2", fillSz: "1" }, { instId: "BTC-USDT", instType, side: "buy", tradeId: `${instType}-1`, ordId: "o", fillTime: "10", billId: "1", fillSz: "1" }], next: "next" };
  };
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0, ownership: { accountId: "a", managedAfter: 0, enabledInstIds: ["BTC-USDT"], holdHoursByInst: { "BTC-USDT": "24" }, configHash: "cfg" },
    clock: { nowMs: () => 300_020 },
    transaction: async (fn) => fn({}), state: { insertFill: async (_tx, row) => stored.push(row) }, orders: { upsertWatermark: async (_tx, row) => watermarks.push(row) },
    transport: { fills: page("fills"), fillsHistory: page("history"), order: async () => ({ tdMode: "cross", clOrdId: "external", tag: "other" }), ordersPending: async () => [], ordersHistory: async () => [], ordersHistoryArchive: async () => [] },
  });
  const fills = await service.recoverFills({ accountId: "a", overlapBegin: 5 });
  assert.equal(fills.length, 4); assert.deepEqual(stored.map((row) => row.tradeId), ["MARGIN-1", "SPOT-1", "MARGIN-2", "SPOT-2"]); assert.equal(watermarks.length, 2); assert.ok(calls.some((value) => value.endsWith(":next")));
  const outcome = await service.reconcileAttempt({ state: "UNKNOWN", instId: "BTC-USDT", clOrdId: "unknown", ord_id: null });
  assert.equal(outcome.outcome, "RETAIN_UNKNOWN");
});

test("P3 fill recovery advances an empty instType only to a lagged successful-read fence", async () => {
  const watermarks = [];
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0, clock: { nowMs: () => 600_000 },
    ownership: { accountId: "a", managedAfter: 0, enabledInstIds: [] }, transaction: async (fn) => fn({}), state: {}, orders: { upsertWatermark: async (_tx, row) => watermarks.push(row) },
    transport: { fills: async (instType) => instType === "SPOT" ? [{ instId: "IGNORED-USDT", instType, side: "sell", tradeId: "s", fillTime: "100", billId: "1", fillSz: "1" }] : [], fillsHistory: async () => [] },
  });
  await service.recoverFills({ accountId: "a" });
  assert.deepEqual(watermarks.map(({ instType, watermark }) => [instType, watermark]), [["SPOT", 300_000], ["MARGIN", 300_000]]);
});

test("P2 recovery links a matched SYSTEM fill and emits only post-commit aggregate evidence", async () => {
  const stored = []; const telemetry = []; let committed = false;
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0,
    ownership: { accountId: "a", managedAfter: 0, enabledInstIds: ["BTC-USDT"], holdHoursByInst: { "BTC-USDT": "24" }, configHash: "cfg" }, telemetry: (event) => { assert.equal(committed, true, "recovery evidence is emitted after commit"); telemetry.push(event); },
    transaction: async (fn) => { const result = await fn({}); committed = true; return result; },
    state: { insertFill: async (_tx, row) => { if (stored.some((existing) => existing.tradeId === row.tradeId)) return { rowCount: 0 }; stored.push(row); return { rowCount: 1 }; }, attachSystemFillAttempt: async () => ({ rowCount: 0 }) },
    orders: { findByClOrdId: async () => ({ cl_ord_id: "system-buy", execution_mode: "cross", execution_route: "margin" }), upsertWatermark: async () => {} },
    transport: { fills: async (instType) => instType === "SPOT" ? [{ instId: "BTC-USDT", instType, side: "buy", tradeId: "recovered", ordId: "o", clOrdId: "system-buy", fillTime: "10", billId: "1", fillSz: "1", fillPx: "2" }] : [], fillsHistory: async () => [], order: async () => ({ tdMode: "cross", clOrdId: "system-buy" }) },
  });
  await service.recoverFills({ accountId: "a" });
  assert.equal(stored[0].source, "SYSTEM"); assert.equal(stored[0].sourceAttemptClOrdId, "system-buy");
  assert.deepEqual(telemetry.filter((event) => event.type === "fill_reconciliation").map((event) => [event.inserted, event.linked, event.systemBuys]), [[1, 0, 1]]);
  assert.doesNotMatch(JSON.stringify(telemetry.find((event) => event.type === "fill_reconciliation")), /system-buy|recovered/);
  assert.deepEqual(telemetry.filter((event) => event.reason === "BUY_LEDGER_CONFIRMED").map((event) => ({ source: event.source, instId: event.instId, clOrdId: event.clOrdId, fillCount: event.fillCount, filledSize: event.filledSize, fillNotional: event.fillNotional, weightedAvgPrice: event.weightedAvgPrice, firstFillTime: event.firstFillTime, lastFillTime: event.lastFillTime, sellTime: event.sellTime, sellState: event.sellState })), [{ source: "SYSTEM", instId: "BTC-USDT", clOrdId: "system-buy", fillCount: 1, filledSize: "1", fillNotional: "2", weightedAvgPrice: "2", firstFillTime: 10, lastFillTime: 10, sellTime: 86_400_010, sellState: "WAITING" }]);
  await service.recoverFills({ accountId: "a" });
  assert.equal(telemetry.filter((event) => event.reason === "BUY_LEDGER_CONFIRMED").length, 1, "overlap replay does not announce an existing ledger fill again");
});

test("P2 ACCOUNT ledger preserves confirmed mode and derives spot/margin route before stopping later SYSTEM BUY", async () => {
  const stored = []; const stopped = []; const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0, ownership: { accountId: "a", managedAfter: 100, enabledInstIds: ["BTC-USDT"], holdHoursByInst: { "BTC-USDT": "24" }, configHash: "cfg" }, onAccountBuy: (instId) => stopped.push(instId), state: { insertFill: async (_tx, row) => stored.push(row) }, orders: {}, transport: {} });
  const crossBuy = { instType: "SPOT", instId: "BTC-USDT", side: "buy", tradeId: "a", fillTime: "101", billId: "1", fillSz: "1" };
  assert.equal(await service.ingestFill({}, crossBuy, { tdMode: "cross", clOrdId: "manual", tag: "other" }), true);
  assert.equal(await service.ingestFill({}, { ...crossBuy, tradeId: "cash" }, { tdMode: "cash" }), true);
  assert.equal(await service.ingestFill({}, { ...crossBuy, tradeId: "old", fillTime: "99" }, { tdMode: "cross" }), false);
  assert.equal(await service.ingestFill({}, { ...crossBuy, tradeId: "swap", instType: "SWAP" }, { tdMode: "cross" }), false);
  assert.equal(await service.ingestFill({}, { ...crossBuy, tradeId: "other", instId: "ETH-USDT" }, { tdMode: "cross" }), false);
  assert.deepEqual(stopped, ["BTC-USDT", "BTC-USDT"]); assert.deepEqual(stored.map((row) => [row.source, row.side, row.tradeId, row.executionMode, row.executionRoute]), [["ACCOUNT", "BUY", "a", "cross", "spot"], ["ACCOUNT", "BUY", "cash", "cash", "spot"]]);
});

test("P2 boundaries retain fee reservation, daily-gain edge, and tick changes", () => {
  assert.deepEqual(dailyLimit({ todayOpen: "100", yesterdayOpen: "100", yesterdayClose: "110", bestLimit: "95", tickSz: "0.1" }), { skipped: false, price: "95" });
  assert.equal(dailyLimit({ todayOpen: "100", yesterdayOpen: "100", yesterdayClose: "110.0001", bestLimit: "95", tickSz: "0.1" }).reason, "SKIPPED_YESTERDAY_GAIN");
  const market = setupMarket(clock(0)); market.updateInstrument({ instId: "BTC-USDT", ts: 3, state: "live", tickSz: "0.3", lotSz: "0.001", minSz: "0.001", base: "BTC", version: 2 });
  assert.equal(market.instrument("BTC-USDT").tickSz, "0.3", "daily cache is not rewritten by the new rule");
});

test("P2 50-asset replay keeps only latest ticker per asset", () => {
  const queue = new BoundedPriorityQueue({ capacity: 5 });
  for (let index = 1; index <= 50; index += 1) {
    const instId = `C${String(index).padStart(2, "0")}-USDT`;
    for (let tick = 2; tick <= 100; tick += 1) queue.enqueue({ type: "ticker", instId, tick });
  }
  assert.equal(queue.size, 50, "coalescing bounds each asset to its newest market event");
});

test("P2 BUY settlement records fills with reservation conversion atomically and gates next generation by a new key", async () => {
  const fills = []; const settled = []; const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { insertFill: async (_tx, fill) => fills.push(fill) }, orders: { markSettled: async (_tx, id, exchange, reservation) => settled.push({ id, exchange, reservation }) }, config, market: {}, account: {}, ownerGuard: {}, readyGate: {}, transport: {} });
  const attempt = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", cl_ord_id: "p", hold_hours: "24", strategy_config_hash: "cfg", state: "SUBMITTED", decision_market_key: "q1" };
  assert.deepEqual(await coordinator.settleBuy({ attempt, fills: [{ tradeId: "late", fillSz: "0.5", fillTime: "5" }], exchangeState: "canceled", accFillSz: "1" }), { settled: false, reason: "FILLS_INCOMPLETE" });
  assert.equal(fills.length, 0); assert.deepEqual(await coordinator.settleBuy({ attempt, fills: [], exchangeState: "canceled", accFillSz: "0" }), { settled: true });
  assert.equal(settled.at(-1).reservation, "RELEASED");
  assert.deepEqual(await coordinator.settleBuy({ attempt, fills: [{ tradeId: "late", billId: "7", fillSz: "0.5", fillTime: "5" }], exchangeState: "canceled", accFillSz: "0.5" }), { settled: true });
  assert.equal(fills.length, 1); assert.equal(fills[0].billId, "7"); assert.equal(settled.at(-1).reservation, "CONVERTED");
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "SUBMITTED", decision_market_key: "q1" }, nextMarketKey: "q2" }), false);
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "SETTLED", decision_market_key: "q1" }, nextMarketKey: "q1" }), false);
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "SETTLED", decision_market_key: "q1" }, nextMarketKey: "q2" }), true);
});

test("P2 commit-ack-loss reads the PREPARED business key and missing batch items become UNKNOWN", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150", mgnRatio: "2" });
  const events = []; let sends = 0; let existing;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: ready(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", clock: now, config, telemetry: (event) => events.push(event), state: {},
    orders: {
      reserveBuy: async (_tx, attempt) => { existing = { ...attempt, state: "PREPARED", payload_hash: attempt.payloadHash }; const error = new Error("connection reset after commit"); error.code = "23505"; throw error; },
      findByClOrdId: async () => existing,
      markUnknown: async () => {}, markNotCreated: async () => {}, markSubmitted: async () => {},
    },
    transport: { ...clockReady, maxAvailSize: async () => [{ instId: "BTC-USDT", availBuy: "100" }], submitBatchOrders: async () => { sends += 1; return []; } },
  });
  coordinator.enqueue({ intent: "BUY", instId: "BTC-USDT", generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg" });
  assert.equal((await coordinator.drainOnce()).reason, "COMMIT_ACK_LOST");
  assert.equal(sends, 0); assert.equal(events.at(-1).reason, "COMMIT_ACK_LOST");

  const attempts = new Map();
  const missing = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: ready(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", clock: now, config, state: {},
    orders: { reserveBuy: async (_tx, attempt) => { attempts.set(attempt.clOrdId, { state: "PREPARED" }); return { authorized: true }; }, markUnknown: async (_tx, id, reason) => Object.assign(attempts.get(id), { state: "UNKNOWN", reason }), markNotCreated: async () => {}, markSubmitted: async () => {} },
    transport: { ...clockReady, maxAvailSize: async () => [{ instId: "BTC-USDT", availBuy: "100" }], submitBatchOrders: async () => [] },
  });
  missing.enqueue({ intent: "BUY", instId: "BTC-USDT", generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg" });
  await missing.drainOnce();
  assert.equal([...attempts.values()][0].state, "UNKNOWN"); assert.equal([...attempts.values()][0].reason, "MISSING_BATCH_ITEM");
});

test("P2 insufficient funds waits for a newer safe risk version, while protection blocks before and after PREPARED", async () => {
  const now = clock(10); const market = setupMarket(now); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "150", adjEq: "150", mgnRatio: "2" });
  let maxAvailReads = 0; let submits = 0; let protectedAtReserve = false; let removed = false; const events = [];
  const attempts = new Map(); const intent = { intent: "BUY", instId: "BTC-USDT", generation: 0, eligibleSince: 1, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg" };
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: ready(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", isBuyAllowed: () => !removed, clock: now, config, telemetry: (event) => events.push(event), state: {},
    orders: { reserveBuy: async (_tx, attempt) => { attempts.set(attempt.clOrdId, { state: "PREPARED" }); protectedAtReserve = true; removed = true; return { authorized: true }; }, markNotCreated: async (_tx, id, reason) => Object.assign(attempts.get(id), { state: "NOT_CREATED", reservationState: "RELEASED", reason }), markUnknown: async () => {}, markSubmitted: async () => {} },
    transport: { ...clockReady, maxAvailSize: async () => { maxAvailReads += 1; return maxAvailReads === 1 ? [{ instId: "BTC-USDT", availBuy: "0" }] : [{ instId: "BTC-USDT", availBuy: "10" }]; }, submitBatchOrders: async () => { submits += 1; return []; } },
  });
  coordinator.enqueue(intent);
  assert.equal((await coordinator.drainOnce()).reason, "NO_ELIGIBLE");
  assert.equal((await coordinator.drainOnce()).reason, "NO_ELIGIBLE");
  assert.equal(maxAvailReads, 1, "new ticker/self-spin cannot retry an insufficient-funds candidate");
  account.update({ ts: 2, totalEq: "150", adjEq: "150", mgnRatio: "2" });
  assert.equal((await coordinator.drainOnce()).reason, "FINAL_GUARD");
  assert.equal(maxAvailReads, 2); assert.equal(submits, 0); assert.equal(protectedAtReserve, true);
  assert.equal([...attempts.values()][0].reservationState, "RELEASED");
  assert.ok(events.some((event) => event.reason === "INSUFFICIENT_FUNDS_WAIT_RISK_VERSION"));
});

test("P2 frozen fields survive late fill across Singapore midnight and terminal regressions cannot revive a reservation", async () => {
  const fills = []; const transitions = [];
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { insertFill: async (_tx, fill) => fills.push(fill) }, orders: { markSettled: async (_tx, id, exchange, reservation) => transitions.push({ id, exchange, reservation }) }, config, market: {}, account: {}, ownerGuard: {}, readyGate: {}, transport: {} });
  const attempt = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", cl_ord_id: "midnight", strategy_day: "2026-08-14", hold_hours: "36", strategy_config_hash: "frozen-cfg", state: "UNKNOWN", decision_market_key: "q1" };
  assert.equal((await coordinator.settleBuy({ attempt, fills: [{ tradeId: "late-midnight", fillSz: "0.5", fillTime: "1723651200000" }], exchangeState: "filled", accFillSz: "0.5" })).settled, true);
  assert.deepEqual(fills.map((fill) => [fill.tradeId, fill.holdHours, fill.strategyConfigHash]), [["late-midnight", "36", "frozen-cfg"]]);
  assert.equal(transitions[0].reservation, "CONVERTED");
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "SETTLED", decision_market_key: "q1" }, nextMarketKey: "q2" }), true);
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "UNKNOWN", decision_market_key: "q1" }, nextMarketKey: "q2" }), false, "late live observation must not revive terminal attempt state");
});
