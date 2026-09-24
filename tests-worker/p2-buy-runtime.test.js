import assert from "node:assert/strict";
import test from "node:test";

import { AccountCapitalSnapshot, BoundedPriorityQueue, MarketProjection, ReadyGate } from "../src/application/trading-engine.js";
import { OrderCoordinator, ownedQuoteBalance } from "../src/application/order-coordinator.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";
import { createCancellableSleep } from "../src/application/production-composition.js";
import { VirtualSloMetrics } from "../src/application/slo-metrics.js";
import { panicSellTime, strategyDay, strategyDayStartMs } from "../src/domain/rules.js";

const clock = (value = 0) => ({ value, nowMs() { return this.value; } });
const config = { accountId: "account", orderVersion: "P2", strategyTag: "STRAT", orderExpiryMs: 1_000, quoteFreshMs: 100, accountFreshMs: 100 };
const clockReady = { clockFresh: () => true, clockSkewMs: 0 };
const DAY = "2026-09-24";
const NOON = strategyDayStartMs(DAY) + 12 * 3_600_000;
const anchor = { ts: strategyDayStartMs(DAY), hash: "anchor-hash" };

function ready() { const gate = new ReadyGate(); for (const key of gate.required) gate.set(key, true); return gate; }
function setupMarket(now, quotes = { "BTC-USDT": "95" }) {
  const market = new MarketProjection({ clock: now });
  for (const [instId, last] of Object.entries(quotes)) {
    market.updateInstrument({ instId, ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base: instId.split("-")[0], version: 1 });
    market.updateTicker({ instId, ts: now.nowMs(), last, askPx: last, bidPx: last });
  }
  return market;
}
function freshAccount(now, version = 1) { const account = new AccountCapitalSnapshot({ clock: now }); for (let index = 1; index <= version; index += 1) account.update({ ts: index, totalEq: "1000", adjEq: "1000" }); return account; }
function usdt(availBal) { return [{ details: [{ ccy: "USDT", availBal, cashBal: availBal }] }]; }
function buyIntent(instId, overrides = {}) { return { intent: "BUY", decisionId: `decision-${instId}`, instId, generation: 0, triggerAt: 1, signalAt: 1, strategyDay: DAY, limitPrice: "100", countRank: 3, anchor, holdHours: "3", configHash: "panic", tradeQuoteCcy: "USDT", ...overrides }; }
function memoryOrders() {
  const attempts = new Map();
  return {
    attempts,
    async reserveBuy(_tx, attempt) { attempts.set(attempt.clOrdId, { ...attempt, state: "PREPARED", reservationState: "ACTIVE" }); return { authorized: true }; },
    async markSubmitted(_tx, id, ordId) { Object.assign(attempts.get(id), { state: "SUBMITTED", ordId }); },
    async markUnknown(_tx, id, reason) { Object.assign(attempts.get(id), { state: "UNKNOWN", reason }); },
    async markNotCreated(_tx, id, reason) { Object.assign(attempts.get(id), { state: "NOT_CREATED", reservationState: "RELEASED", reason }); },
    async markSettled(_tx, id) { Object.assign(attempts.get(id), { state: "SETTLED" }); },
  };
}
function panicCoordinator({ now, market, account = freshAccount(now), orders = memoryOrders(), transport = {}, mode = "FULL", ...options }) {
  return new OrderCoordinator({ transaction: async (fn) => fn({}), orders, state: {}, ownerGuard: { isHeld: () => true }, readyGate: ready(), market, account, mode: () => mode, executionRoute: () => "margin", tradeQuoteCurrency: () => "USDT", clock: now, config, transport: { ...clockReady, ...transport }, ...options });
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

test("P2 quote freshness rejects old source time without discarding diagnostic evidence", () => {
  const now = clock(10_000); const market = new MarketProjection({ clock: now });
  market.updateTicker({ instId: "BTC-USDT", ts: 8_000, last: "10", askPx: "10", bidPx: "9" });
  assert.deepEqual(market.quoteStatus("BTC-USDT", 100, 10_000), {
    quote: { instId: "BTC-USDT", ts: 8_000, last: "10", askPx: "10", bidPx: "9" },
    fresh: false, reason: "SOURCE_STALE", receiptAgeMs: 0, sourceAgeMs: 2_000, sourceTs: 8_000,
  });
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

test("P2 recovery cancel during owner safety wait does not load snapshots", async () => {
  let listed = 0;
  const wait = createCancellableSleep();
  const service = new ReconciliationService({
    ownerGuard: { isHeld: () => true }, readyGate: ready(), safetyWaitMs: 50, sleep: wait.sleep, aborted: () => wait.cancelled,
    state: { listProtection: async () => { listed += 1; return []; }, listDaily: async () => [], listManagedFills: async () => [] },
    orders: { listNonTerminal: async () => [], listTodayBuys: async () => [], listWatermarks: async () => [] },
    transport: {},
  });
  const pending = service.recover({ accountId: "account" });
  wait.cancel();
  await assert.rejects(pending, /STARTUP_CANCELLED/);
  assert.equal(listed, 0);
});

test("P2 recovery paginates fills/history, deduplicates tradeId, persists watermarks, and keeps a lone NOT_FOUND UNKNOWN", async () => {
  const stored = []; const watermarks = []; const calls = [];
  const page = (name) => async (instType, params = {}) => {
    calls.push(`${name}:${instType}:${params.after ?? "first"}`);
    if (params.after) return { data: [] };
    return { data: [{ instId: "BTC-USDT", instType, side: "buy", tradeId: `${instType}-2`, ordId: "o", fillTime: "20", billId: "2", fillSz: "1" }, { instId: "BTC-USDT", instType, side: "buy", tradeId: `${instType}-1`, ordId: "o", fillTime: "10", billId: "1", fillSz: "1" }], next: "next" };
  };
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0, ownership: { accountId: "a", managedAfter: 0, enabledInstIds: ["BTC-USDT"], systemClOrdIdPrefix: "P2", strategyTag: "STRAT" },
    clock: { nowMs: () => 300_020 },
    transaction: async (fn) => fn({}), state: { insertFill: async (_tx, row) => stored.push(row) }, orders: { upsertWatermark: async (_tx, row) => watermarks.push(row) },
    transport: { fills: page("fills"), fillsHistory: page("history"), order: async () => ({ tdMode: "cross", clOrdId: "P2owned", tag: "STRAT" }), ordersPending: async () => [], ordersHistory: async () => [], ordersHistoryArchive: async () => [] },
  });
  const fills = await service.recoverFills({ accountId: "a", overlapBegin: 5 });
  assert.equal(fills.length, 4); assert.deepEqual(stored.map((row) => row.tradeId), ["MARGIN-1", "SPOT-1", "MARGIN-2", "SPOT-2"]); assert.equal(watermarks.length, 2); assert.ok(calls.some((value) => value.endsWith(":next")));
  const outcome = await service.reconcileAttempt({ state: "UNKNOWN", instId: "BTC-USDT", clOrdId: "unknown", ord_id: null });
  assert.equal(outcome.outcome, "RETAIN_UNKNOWN");
});

test("P2 recent UNKNOWN with OKX 51603 settles only after every consistency source confirms absence", async () => {
  const missing = new Error("OKX code 51603"); missing.okxCode = "51603";
  const calls = []; let settled;
  const empty = (name) => async (instType) => { calls.push(`${name}:${instType}`); return []; };
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0,
    clock: { nowMs: () => Date.parse("2026-09-01T15:00:00Z") }, transaction: async (fn) => fn({}), state: {},
    orders: { markSettled: async (_tx, clOrdId, exchangeState, reservationState) => { settled = { clOrdId, exchangeState, reservationState }; return { rowCount: 1 }; } },
    transport: { order: async () => { throw missing; }, ordersPending: empty("pending"), ordersHistory: empty("history"), ordersHistoryArchive: empty("archive"), fills: empty("fills"), fillsHistory: empty("fillsHistory") },
  });
  const outcome = await service.reconcileAttempt({ state: "UNKNOWN", inst_id: "BTC-USDT", cl_ord_id: "unknown", created_at: new Date("2026-09-01T14:52:00Z") });
  assert.equal(outcome.outcome, "TERMINAL_SETTLED");
  assert.deepEqual(settled, { clOrdId: "unknown", exchangeState: "NOT_FOUND", reservationState: "RELEASED" });
  assert.equal(calls.length, 10);
  settled = undefined;
  const incomplete = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0,
    clock: { nowMs: () => Date.parse("2026-09-01T15:00:00Z") }, transaction: async (fn) => fn({}), state: {}, orders: service.orders,
    transport: { order: async () => { throw missing; }, ordersPending: empty("pending"), ordersHistory: empty("history"), ordersHistoryArchive: empty("archive"), fills: empty("fills") },
  });
  assert.equal((await incomplete.reconcileAttempt({ state: "UNKNOWN", inst_id: "BTC-USDT", cl_ord_id: "unknown", created_at: new Date("2026-09-01T14:52:00Z") })).outcome, "RETAIN_UNKNOWN");
  assert.equal(settled, undefined);
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
    ownership: { accountId: "a", managedAfter: 0, enabledInstIds: ["BTC-USDT"] }, telemetry: (event) => { assert.equal(committed, true, "recovery evidence is emitted after commit"); telemetry.push(event); },
    transaction: async (fn) => { const result = await fn({}); committed = true; return result; },
    state: { insertFill: async (_tx, row) => { if (stored.some((existing) => existing.tradeId === row.tradeId)) return { rowCount: 0 }; stored.push(row); return { rowCount: 1 }; }, attachSystemFillAttempt: async () => ({ rowCount: 0 }) },
    orders: { findByClOrdId: async () => ({ cl_ord_id: "system-buy", execution_mode: "cross", execution_route: "margin" }), upsertWatermark: async () => {} },
    transport: { fills: async (instType) => instType === "SPOT" ? [{ instId: "BTC-USDT", instType, side: "buy", tradeId: "recovered", ordId: "o", clOrdId: "system-buy", fillTime: "10", billId: "1", fillSz: "1", fillPx: "2" }] : [], fillsHistory: async () => [], order: async () => ({ tdMode: "cross", clOrdId: "system-buy" }) },
  });
  await service.recoverFills({ accountId: "a" });
  assert.equal(stored[0].source, "SYSTEM"); assert.equal(stored[0].sourceAttemptClOrdId, "system-buy");
  assert.deepEqual(telemetry.filter((event) => event.type === "fill_reconciliation").map((event) => [event.inserted, event.linked, event.systemBuys]), [[1, 0, 1]]);
  assert.doesNotMatch(JSON.stringify(telemetry.find((event) => event.type === "fill_reconciliation")), /system-buy|recovered/);
  assert.deepEqual(telemetry.filter((event) => event.reason === "BUY_LEDGER_CONFIRMED").map((event) => ({ source: event.source, instId: event.instId, clOrdId: event.clOrdId, fillCount: event.fillCount, filledSize: event.filledSize, fillNotional: event.fillNotional, weightedAvgPrice: event.weightedAvgPrice, firstFillTime: event.firstFillTime, lastFillTime: event.lastFillTime, sellTime: event.sellTime, sellState: event.sellState })), [{ source: "SYSTEM", instId: "BTC-USDT", clOrdId: "system-buy", fillCount: 1, filledSize: "1", fillNotional: "2", weightedAvgPrice: "2", firstFillTime: 10, lastFillTime: 10, sellTime: panicSellTime({ strategyDay: strategyDay(10), fillTime: 10 }), sellState: "WAITING" }]);
  assert.equal(stored[0].sellTime, panicSellTime({ strategyDay: strategyDay(10), fillTime: 10 }), "an attempt-less SYSTEM fill uses its own fill day"); assert.equal(stored[0].holdHours, "3");
  await service.recoverFills({ accountId: "a" });
  assert.equal(telemetry.filter((event) => event.reason === "BUY_LEDGER_CONFIRMED").length, 1, "overlap replay does not announce an existing ledger fill again");
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
  const attempt = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", cl_ord_id: "p", strategy_day: "2026-08-14", hold_hours: "3", strategy_config_hash: "cfg", state: "SUBMITTED", decision_market_key: "q1" };
  assert.deepEqual(await coordinator.settleBuy({ attempt, fills: [{ tradeId: "late", fillSz: "0.5", fillTime: "5" }], exchangeState: "canceled", accFillSz: "1" }), { settled: false, reason: "FILLS_INCOMPLETE" });
  assert.equal(fills.length, 0); assert.deepEqual(await coordinator.settleBuy({ attempt, fills: [], exchangeState: "canceled", accFillSz: "0" }), { settled: true });
  assert.equal(settled.at(-1).reservation, "RELEASED");
  assert.deepEqual(await coordinator.settleBuy({ attempt, fills: [{ tradeId: "late", billId: "7", fillSz: "0.5", fillTime: "5" }], exchangeState: "canceled", accFillSz: "0.5" }), { settled: true });
  assert.equal(fills.length, 1); assert.equal(fills[0].billId, "7"); assert.equal(settled.at(-1).reservation, "CONVERTED");
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "SUBMITTED", decision_market_key: "q1" }, nextMarketKey: "q2" }), false);
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "SETTLED", decision_market_key: "q1" }, nextMarketKey: "q1" }), false);
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "SETTLED", decision_market_key: "q1" }, nextMarketKey: "q2" }), true);
});

test("P2 frozen fields survive late fill across Singapore midnight and terminal regressions cannot revive a reservation", async () => {
  const fills = []; const transitions = [];
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { insertFill: async (_tx, fill) => fills.push(fill) }, orders: { markSettled: async (_tx, id, exchange, reservation) => transitions.push({ id, exchange, reservation }) }, config, market: {}, account: {}, ownerGuard: {}, readyGate: {}, transport: {} });
  const attempt = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", cl_ord_id: "midnight", strategy_day: "2026-08-14", hold_hours: "36", strategy_config_hash: "frozen-cfg", state: "UNKNOWN", decision_market_key: "q1" };
  assert.equal((await coordinator.settleBuy({ attempt, fills: [{ tradeId: "late-midnight", fillSz: "0.5", fillTime: "1723651200000" }], exchangeState: "filled", accFillSz: "0.5" })).settled, true);
  assert.deepEqual(fills.map((fill) => [fill.tradeId, fill.holdHours, fill.strategyConfigHash, fill.sellTime, fill.forceSellTime]), [["late-midnight", "36", "frozen-cfg", panicSellTime({ strategyDay: "2026-08-14", fillTime: 1723651200000 }), null]], "the sell schedule uses the attempt's frozen strategy day");
  assert.equal((await coordinator.settleBuy({ attempt: { ...attempt, cl_ord_id: "pg-date", strategy_day: new Date(2026, 7, 14) }, fills: [{ tradeId: "pg", fillSz: "1", fillTime: String(strategyDayStartMs("2026-08-14") + 22 * 3_600_000) }], exchangeState: "filled", accFillSz: "1" })).settled, true);
  assert.equal(fills.at(-1).sellTime, strategyDayStartMs("2026-08-14") + 25 * 3_600_000, "a pg DATE strategy day and a 22:00 fill sell at 01:00");
  assert.equal(transitions[0].reservation, "CONVERTED");
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "SETTLED", decision_market_key: "q1" }, nextMarketKey: "q2" }), true);
  assert.equal(coordinator.canCreateNextBuy({ previousAttempt: { state: "UNKNOWN", decision_market_key: "q1" }, nextMarketKey: "q2" }), false, "late live observation must not revive terminal attempt state");
});
test("P5 BUY queue submits one IOC at a time in 72% trigger order, sized from fresh owned USDT", async () => {
  const now = clock(NOON); const market = setupMarket(now, { "BTC-USDT": "95", "ETH-USDT": "95" });
  const orders = memoryOrders(); const payloads = []; const reads = []; const slo = new VirtualSloMetrics(now); let owned = "500";
  const coordinator = panicCoordinator({ now, market, orders, slo, transport: {
    maxAvailSize: async (instId, options) => { reads.push(["max", instId, options.tdMode, options.ccy]); return [{ instId, availBuy: "5000" }]; },
    balance: async (ccy) => { reads.push(["balance", ccy]); return usdt(owned); },
    submitBatchOrders: async (payload) => { payloads.push(payload); owned = "100"; return payload.map((item) => ({ clOrdId: item.clOrdId, status: "SUBMITTED", ordId: "1" })); },
  } });
  coordinator.enqueue(buyIntent("ETH-USDT", { triggerAt: 20 }));
  coordinator.enqueue(buyIntent("BTC-USDT", { triggerAt: 10 }));
  const first = await coordinator.drainOnce();
  assert.equal(first.count, 1); assert.equal(payloads.length, 1); assert.equal(payloads[0].length, 1, "exactly one order per submission");
  assert.deepEqual({ ...payloads[0][0], clOrdId: undefined }, { instId: "BTC-USDT", tdMode: "cross", side: "buy", ordType: "ioc", px: "100", sz: "4.997", tag: "STRAT", tradeQuoteCcy: "USDT", clOrdId: undefined }, "the earliest 72% trigger buys first, at the frozen limit, with owned USDT (500) not borrowable capacity (5000)");
  assert.deepEqual(reads, [["max", "BTC-USDT", "cross", "USDT"], ["balance", "USDT"]]);
  assert.equal(coordinator.pending.BUY.has("BTC-USDT"), false); assert.equal(coordinator.pending.BUY.has("ETH-USDT"), true);
  const second = await coordinator.drainOnce();
  assert.equal(second.count, 1); assert.equal(payloads[1][0].instId, "ETH-USDT"); assert.equal(payloads[1][0].sz, "0.999", "the next symbol re-reads the remaining owned USDT");
  const attempt = [...orders.attempts.values()][0];
  assert.deepEqual([attempt.decisionReason, attempt.decisionReferencePrice, attempt.executionLimitPrice, attempt.holdHours, attempt.maxHoldHours, attempt.decisionCandleTs, attempt.decisionCandleHash], ["PANIC_BUY_72", "100", "100", "3", null, anchor.ts, "anchor-hash"]);
  assert.deepEqual(slo.assertInvariants(), { maxBatchSize: 1, maxMutationConcurrency: 1, unknownCount: 0 });
  assert.equal((await coordinator.drainOnce()).reason, "EMPTY");
});

test("P5 BUY queue never borrows: owned USDT caps the order and an exhausted balance pauses capacity reads", async () => {
  assert.equal(ownedQuoteBalance(usdt("12.5")), "12.5"); assert.equal(ownedQuoteBalance(usdt("-3")), "0"); assert.equal(ownedQuoteBalance([{ details: [{ ccy: "BTC", availBal: "1" }] }]), "0");
  const now = clock(NOON); const market = setupMarket(now); const events = []; let reads = 0; let submits = 0; const account = freshAccount(now);
  const coordinator = panicCoordinator({ now, market, account, telemetry: (event) => events.push(event), transport: {
    maxAvailSize: async (instId) => { reads += 1; return [{ instId, availBuy: "5000" }]; }, balance: async () => usdt("9.99"), submitBatchOrders: async () => { submits += 1; return []; },
  } });
  coordinator.enqueue(buyIntent("BTC-USDT"));
  assert.equal((await coordinator.drainOnce()).reason, "CAPITAL_EXHAUSTED");
  assert.equal(coordinator.buyCapitalBlocked(), true); assert.equal(submits, 0);
  assert.deepEqual(events.filter((event) => event.type === "block_evidence").map((event) => [event.stage, event.reason, event.ownedQuote, event.notional]), [["SIZING", "CAPITAL_EXHAUSTED", "9.99", "9.99"]]);
  coordinator.enqueue(buyIntent("BTC-USDT", { decisionId: "again" }));
  assert.equal((await coordinator.drainOnce()).reason, "CAPITAL_EXHAUSTED"); assert.equal(reads, 1, "no REST storm while capital is spent");
  account.update({ ts: 99, totalEq: "1000", adjEq: "1000" });
  assert.equal(coordinator.buyCapitalBlocked(), false, "a newer account snapshot re-opens capacity reads");
  now.value += 30_000; coordinator.capitalBlock = { version: account.value.version, at: NOON };
  assert.equal(coordinator.buyCapitalBlocked(), false, "and so does the recheck interval");
});

test("P5 BUY queue drops symbols that bounced above the limit and continues with the next trigger", async () => {
  const now = clock(NOON); const market = setupMarket(now, { "BTC-USDT": "101", "ETH-USDT": "95", "SOL-USDT": "95" }); const events = []; const payloads = [];
  market.updateTicker({ instId: "ETH-USDT", ts: NOON, last: "99", askPx: "100.1", bidPx: "99" });
  const coordinator = panicCoordinator({ now, market, telemetry: (event) => events.push(event), transport: {
    maxAvailSize: async (instId) => [{ instId, availBuy: "500" }], balance: async () => usdt("500"),
    submitBatchOrders: async (payload) => { payloads.push(...payload); return payload.map((item) => ({ clOrdId: item.clOrdId, status: "SUBMITTED" })); },
  } });
  coordinator.enqueue(buyIntent("BTC-USDT", { triggerAt: 1 })); coordinator.enqueue(buyIntent("ETH-USDT", { triggerAt: 2 })); coordinator.enqueue(buyIntent("SOL-USDT", { triggerAt: 3 }));
  assert.equal((await coordinator.drainOnce()).count, 1);
  assert.deepEqual(payloads.map((item) => item.instId), ["SOL-USDT"], "no chase above the 72% limit");
  assert.deepEqual(events.filter((event) => event.type === "block_evidence").map((event) => [event.instId, event.reason]), [["BTC-USDT", "ABOVE_BUY_PRICE"], ["ETH-USDT", "ASK_ABOVE_LIMIT"]]);
  assert.equal(coordinator.pending.BUY.size, 0, "dropped symbols wait for their next qualifying tick");
});

test("P5 BUY UNKNOWN blocks only its own symbol and is chased immediately while the queue moves on", async () => {
  const now = clock(NOON); const market = setupMarket(now, { "BTC-USDT": "95", "ETH-USDT": "95" }); const orders = memoryOrders(); const chased = [];
  const results = ["UNKNOWN", "SUBMITTED"];
  const coordinator = panicCoordinator({ now, market, orders, onBuySubmitted: (attempt) => chased.push([attempt.instId, attempt.state]), transport: {
    maxAvailSize: async (instId) => [{ instId, availBuy: "500" }], balance: async () => usdt("500"),
    submitBatchOrders: async (payload) => payload.map((item) => ({ clOrdId: item.clOrdId, status: results.shift(), reason: "timeout" })),
  } });
  coordinator.enqueue(buyIntent("BTC-USDT", { triggerAt: 1 })); coordinator.enqueue(buyIntent("ETH-USDT", { triggerAt: 2 }));
  await coordinator.drainOnce(); await coordinator.drainOnce();
  assert.deepEqual([...orders.attempts.values()].map((row) => [row.instId, row.state]), [["BTC-USDT", "UNKNOWN"], ["ETH-USDT", "SUBMITTED"]]);
  assert.deepEqual(chased, [["BTC-USDT", "UNKNOWN"], ["ETH-USDT", "SUBMITTED"]]);
});

test("P5 BUY guard fails closed on mode, day change and availability errors without touching capital", async () => {
  const now = clock(NOON); const events = []; let reads = 0;
  const off = panicCoordinator({ now, market: setupMarket(now), mode: "OFF", telemetry: (event) => events.push(event), transport: { maxAvailSize: async () => { reads += 1; return []; }, balance: async () => usdt("500") } });
  off.enqueue(buyIntent("BTC-USDT")); off.enqueue(buyIntent("BTC-USDT"));
  assert.equal((await off.drainOnce()).reason, "NO_ELIGIBLE"); assert.equal(reads, 0); assert.equal(off.pending.BUY.size, 0);
  assert.deepEqual(events.map((event) => [event.stage, event.reason, event.currentMode]), [["COORDINATOR_GUARD", "MODE", "OFF"]]);
  const stale = panicCoordinator({ now, market: setupMarket(now), telemetry: (event) => events.push(event), transport: { maxAvailSize: async () => { reads += 1; return []; } } });
  stale.enqueue(buyIntent("BTC-USDT", { strategyDay: "2026-09-23", decisionId: "yesterday" }));
  assert.equal((await stale.drainOnce()).reason, "NO_ELIGIBLE"); assert.equal(events.at(-1).reason, "STRATEGY_DAY_CHANGED"); assert.equal(reads, 0);
  const failing = panicCoordinator({ now, market: setupMarket(now), telemetry: (event) => events.push(event), transport: { maxAvailSize: async () => { throw new Error("temporary unavailable"); }, balance: async () => usdt("500") } });
  failing.enqueue(buyIntent("BTC-USDT", { decisionId: "avail" }));
  assert.equal((await failing.drainOnce()).reason, "MAX_AVAIL_FAILED");
  assert.equal((await failing.drainOnce()).reason, "CAPACITY_RETRY_WAIT", "a transient read failure backs off instead of spinning");
  assert.equal(failing.pending.BUY.size, 1, "and keeps the intent for the retry");
  assert.equal(events.at(-1).reason, "MAX_AVAIL_FAILED"); assert.equal(events.at(-1).executionRoute, "margin");
});

test("P5 BUY final guard releases the PREPARED reservation when protection or ownership changes before HTTP", async () => {
  const now = clock(NOON); const market = setupMarket(now); let protectedNow = false; let sends = 0;
  const orders = memoryOrders(); const reserve = orders.reserveBuy; orders.reserveBuy = async (tx, attempt) => { protectedNow = true; return reserve(tx, attempt); };
  const coordinator = panicCoordinator({ now, market, orders, isBuyAllowed: () => !protectedNow, transport: { maxAvailSize: async (instId) => [{ instId, availBuy: "500" }], balance: async () => usdt("500"), submitBatchOrders: async () => { sends += 1; return []; } } });
  coordinator.enqueue(buyIntent("BTC-USDT"));
  assert.equal((await coordinator.drainOnce()).reason, "FINAL_GUARD");
  assert.equal(sends, 0); assert.deepEqual([...orders.attempts.values()].map((row) => [row.state, row.reservationState]), [["NOT_CREATED", "RELEASED"]]);
});

test("P2 commit-ack-loss reads the PREPARED business key and a missing batch item becomes UNKNOWN", async () => {
  const now = clock(NOON); const market = setupMarket(now); const events = []; let sends = 0; let existing;
  const transport = { maxAvailSize: async (instId) => [{ instId, availBuy: "100" }], balance: async () => usdt("100") };
  const coordinator = panicCoordinator({ now, market, telemetry: (event) => events.push(event),
    orders: {
      reserveBuy: async (_tx, attempt) => { existing = { ...attempt, state: "PREPARED", payload_hash: attempt.payloadHash }; const error = new Error("connection reset after commit"); error.code = "23505"; throw error; },
      findByClOrdId: async () => existing, markUnknown: async () => {}, markNotCreated: async () => {}, markSubmitted: async () => {},
    },
    transport: { ...transport, submitBatchOrders: async () => { sends += 1; return []; } },
  });
  coordinator.enqueue(buyIntent("BTC-USDT"));
  assert.equal((await coordinator.drainOnce()).reason, "COMMIT_ACK_LOST");
  assert.equal(sends, 0); assert.equal(events.at(-1).reason, "COMMIT_ACK_LOST");
  const orders = memoryOrders();
  const missing = panicCoordinator({ now, market, orders, transport: { ...transport, submitBatchOrders: async () => [] } });
  missing.enqueue(buyIntent("BTC-USDT"));
  await missing.drainOnce();
  assert.equal([...orders.attempts.values()][0].state, "UNKNOWN"); assert.equal([...orders.attempts.values()][0].reason, "MISSING_BATCH_ITEM");
});

test("P5 reconciliation never adopts a manual BUY and applies a manual SELL only while the strategy holds that base", async () => {
  const stored = []; let heldBases = new Set(["BTC"]); const refreshed = [];
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0, ownership: { accountId: "a", managedAfter: 100, enabledInstIds: ["BTC-USDT", "ETH-USDT"], systemClOrdIdPrefix: "P2", strategyTag: "STRAT" },
    onAccountBuy: (instId) => refreshed.push(instId), state: { insertFill: async (_tx, row) => { stored.push(row); return { rowCount: 1 }; }, hasOpenManagedBase: async (_tx, { baseCcy }) => heldBases.has(baseCcy) },
    orders: { findByClOrdId: async (_tx, id) => id === "P2system" ? { cl_ord_id: id, intent: "BUY", strategy_day: DAY, hold_hours: "3", strategy_config_hash: "panic", execution_mode: "cross", execution_route: "margin" } : null, lockExitBase: async () => {}, releasePreparedExitsForBase: async () => ({ rowCount: 0 }) }, transport: {} });
  const fill = { instType: "SPOT", instId: "BTC-USDT", side: "buy", tradeId: "a", fillTime: String(NOON), billId: "1", fillSz: "1" };
  assert.equal(await service.ingestFill({}, fill, { tdMode: "cross", clOrdId: "manual", tag: "other" }), false, "manual BUY is not adopted");
  assert.equal(await service.ingestFill({}, { ...fill, tradeId: "sys" }, { tdMode: "cross", clOrdId: "P2system", tag: "STRAT" }), true);
  assert.equal(await service.ingestFill({}, { ...fill, tradeId: "sell-held", side: "sell" }, { tdMode: "cross", clOrdId: "manual" }), true);
  assert.equal(await service.ingestFill({}, { ...fill, instId: "ETH-USDT", tradeId: "sell-unheld", side: "sell" }, { tdMode: "cross", clOrdId: "manual" }), false, "a manual SELL of a base the strategy never held cannot quarantine future exits");
  assert.equal(await service.ingestFill({}, { ...fill, tradeId: "old", fillTime: "99" }, { tdMode: "cross", clOrdId: "P2system", tag: "STRAT" }), false);
  assert.deepEqual(stored.map((row) => [row.source, row.side, row.tradeId, row.sellTime ?? row.allocationState]), [["SYSTEM", "BUY", "sys", panicSellTime({ strategyDay: DAY, fillTime: NOON })], ["ACCOUNT", "SELL", "sell-held", "PENDING"]]);
  assert.deepEqual(refreshed, []);
});
