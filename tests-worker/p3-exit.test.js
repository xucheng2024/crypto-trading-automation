import assert from "node:assert/strict";
import test from "node:test";
import { AccountCapitalSnapshot, MarketProjection, ReadyGate } from "../src/application/trading-engine.js";
import { OrderCoordinator } from "../src/application/order-coordinator.js";
import { SellService } from "../src/application/sell-service.js";
import { InstrumentProtectionService } from "../src/application/instrument-protection-service.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";
import { ExitSubmissionReconciler } from "../src/application/exit-submission-reconciler.js";

const config = { accountId: "p3", strategyTag: "P3", orderVersion: "v1", orderExpiryMs: 1_000, accountFreshMs: 10_000, quoteFreshMs: 10_000 };
const clock = () => ({ nowMs: () => 1_000 });
function gate() { const value = new ReadyGate(); for (const key of value.required) value.set(key, true); return value; }

test("P3 exits submit immediate five-base batches with DELIST priority and no shared-account excess", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  const attempts = new Map(); const payloads = []; let mode = "OFF";
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { markDust: async () => ({ rowCount: 1 }) }, market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => mode, clock: now, config,
    orders: {
      reserveExit: async (_tx, row) => { attempts.set(row.clOrdId, { ...row, state: "PREPARED" }); return { authorized: true }; },
      markSubmitted: async (_tx, id) => { attempts.get(id).state = "SUBMITTED"; }, markUnknown: async (_tx, id) => { attempts.get(id).state = "UNKNOWN"; }, markNotCreated: async (_tx, id) => { attempts.get(id).state = "NOT_CREATED"; },
    },
    transport: {
      maxAvailSize: async (ids, options) => { assert.deepEqual(options, { tdMode: "cross" }); return ids.split(",").map((instId) => ({ instId, availSell: "2" })); },
      submitBatchOrders: async (rows) => { payloads.push(rows); return rows.map((row, index) => ({ clOrdId: row.clOrdId, status: index === 0 ? "UNKNOWN" : "SUBMITTED", ordId: String(index) })); },
    },
  });
  for (let index = 0; index < 20; index += 1) {
    const base = `C${String(index).padStart(2, "0")}`; const instId = `${base}-USDT`;
    market.updateInstrument({ instId, ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base });
    coordinator.enqueue({ intent: "SELL", instId, baseCcy: base, sourceBuyTradeId: `buy-${base}`, remainingSize: "1", bidPx: "10", fillVersion: 1, sellTime: 1, ...(index === 0 ? { executionRoute: "spot" } : {}) });
  }
  coordinator.enqueue({ intent: "DELIST", instId: "C19-USDT", baseCcy: "C19", sourceBuyTradeId: "delist-buy", remainingSize: "1", availableBase: "100", bidPx: "10", fillVersion: 1, sellTime: 1 });
  assert.equal((await coordinator.drainOnce()).count, 1, "DELIST preempts queued SELL");
  for (let index = 0; index < 4; index += 1) await coordinator.drainOnce();
  assert.deepEqual(payloads.map((batch) => batch.length), [1, 5, 5, 5, 5]);
  for (const batch of payloads.flat()) {
    assert.equal(batch.side, "sell"); assert.equal(batch.ordType, "market"); assert.equal(batch.sz, "1");
    if (batch.instId === "C00-USDT") { assert.equal(batch.tdMode, "cross"); assert.equal("reduceOnly" in batch, false); }
    else { assert.equal(batch.tdMode, "cross"); assert.equal(batch.reduceOnly, true); }
  }
  assert.equal([...attempts.values()].filter((row) => row.state === "UNKNOWN").length, 5, "UNKNOWN keeps its own reservation and no replacement is enqueued");
  mode = "OFF"; coordinator.enqueue({ intent: "SELL", instId: "C00-USDT", baseCcy: "C00", sourceBuyTradeId: "off", remainingSize: "1", availableBase: "1", bidPx: "10", sellTime: 1 });
  assert.equal((await coordinator.drainOnce()).submitted, true);
});

test("P3 submitted exits receive a bounded read-only confirmation before the periodic recovery pass", async () => {
  const timers = { handles: [], setTimeout(fn, delay) { const handle = { fn, delay, cleared: false }; this.handles.push(handle); return handle; }, clearTimeout(handle) { handle.cleared = true; } };
  let attempt = { cl_ord_id: "sell-fast", intent: "SELL", state: "SUBMITTED" }; const observed = [];
  const confirmation = new ExitSubmissionReconciler({
    timers, delaysMs: [250, 500], transaction: async (fn) => fn({}),
    orders: { findByClOrdId: async (_tx, id) => id === "sell-fast" ? attempt : null, listNonTerminal: async () => [attempt] },
    reconciliation: { reconcileAttempt: async (row) => { observed.push(row.cl_ord_id); return { outcome: "TERMINAL_SETTLED" }; } },
  });
  assert.equal(confirmation.schedule(attempt), true); assert.equal(timers.handles[0].delay, 250);
  await confirmation._confirm(confirmation.pending.get("sell-fast"));
  assert.deepEqual(observed, ["sell-fast"]); assert.equal(confirmation.pending.size, 0, "settlement stops the short confirmation loop");
  attempt = { cl_ord_id: "sell-restart", intent: "SELL", state: "SUBMITTED" };
  assert.equal(await confirmation.schedulePending("p3"), 1, "startup resumes the same read-only safety net for durable exits");
  confirmation.stop(); assert.equal(confirmation.pending.size, 0);
});

test("P3 shutdown drains an in-flight exit confirmation before releasing its timer state", async () => {
  const timers = { handles: [], setTimeout(fn) { const handle = { fn, cleared: false }; this.handles.push(handle); return handle; }, clearTimeout(handle) { handle.cleared = true; } };
  let release; const settled = new Promise((resolve) => { release = resolve; }); let completed = false;
  const confirmation = new ExitSubmissionReconciler({
    timers, delaysMs: [1], transaction: async (fn) => fn({}), orders: { findByClOrdId: async () => ({ cl_ord_id: "sell-drain", intent: "SELL", state: "SUBMITTED" }) },
    reconciliation: { reconcileAttempt: async () => { await settled; completed = true; return { outcome: "FOUND" }; } },
  });
  confirmation.schedule({ cl_ord_id: "sell-drain", intent: "SELL" }); timers.handles[0].fn(); await Promise.resolve();
  let stopped = false; const stopping = confirmation.stop().then(() => { stopped = true; }); await Promise.resolve();
  assert.equal(stopped, false); release(); await stopping; assert.equal(completed, true); assert.equal(confirmation.pending.size, 0);
});

test("P3 final exit guard bumps generation instead of permanently colliding with NOT_CREATED", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" }); market.updateTicker({ instId: "BTC-USDT", ts: 1, last: "10", bidPx: "10" });
  const ready = gate(); const attempts = []; let first = true;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: ready, ownerGuard: { isHeld: () => true }, mode: () => "OFF", clock: now, config,
    orders: { reserveExit: async (_tx, row) => { attempts.push(row); if (first) { first = false; ready.set("database", false); } return { authorized: true }; }, markNotCreated: async () => {}, markSubmitted: async () => {}, markUnknown: async () => {} },
    transport: { maxAvailSize: async () => [{ instId: "BTC-USDT", availSell: "1" }], submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "SUBMITTED" })) },
  });
  coordinator.enqueue({ intent: "SELL", instId: "BTC-USDT", baseCcy: "BTC", sourceBuyTradeId: "guard-retry", remainingSize: "1", fillVersion: 1, sellTime: 1 });
  assert.equal((await coordinator.drainOnce()).reason, "FINAL_GUARD"); assert.equal(coordinator.pending.SELL.get("BTC:guard-retry").generation, 1);
  ready.set("database", true); assert.equal((await coordinator.drainOnce()).submitted, true); assert.deepEqual(attempts.map((row) => row.generation), [0, 1]);
});

test("P3 deterministic exchange rejection refreshes availability and retries exactly once with a new generation", async () => {
  let current = 1_000; const now = { nowMs: () => current }; const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" }); market.updateTicker({ instId: "BTC-USDT", ts: 1, last: "10", bidPx: "10" });
  const attempts = []; let submissions = 0; let availabilityReads = 0;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", clock: now, config,
    orders: { reserveExit: async (_tx, row) => { attempts.push(row); return { authorized: true }; }, markNotCreated: async () => {}, markSubmitted: async () => {}, markUnknown: async () => {} },
    transport: { maxAvailSize: async () => { availabilityReads += 1; return [{ instId: "BTC-USDT", availSell: "1" }]; }, submitBatchOrders: async (rows) => { submissions += 1; return rows.map((row) => submissions === 1 ? { clOrdId: row.clOrdId, status: "NOT_CREATED", sCode: "51008", reason: "rejected" } : { clOrdId: row.clOrdId, status: "SUBMITTED", ordId: "one" }); } },
  });
  coordinator.enqueue({ intent: "SELL", instId: "BTC-USDT", baseCcy: "BTC", sourceBuyTradeId: "rejected-retry", remainingSize: "1", fillVersion: 1, sellTime: 1 });
  assert.equal((await coordinator.drainOnce()).response[0].status, "NOT_CREATED");
  assert.equal(coordinator.pending.SELL.get("BTC:rejected-retry").notBefore, 2_000);
  assert.equal((await coordinator.drainOnce()).reason, "NO_ELIGIBLE");
  current = 2_000; assert.equal((await coordinator.drainOnce()).response[0].status, "SUBMITTED");
  assert.deepEqual(attempts.map((row) => row.generation), [0, 1]); assert.equal(availabilityReads, 2); assert.equal(coordinator.pending.SELL.size, 0);
});

test("P3 exit availability failures defer retries instead of retrying on every work loop", async () => {
  let current = 1_000; const now = { nowMs: () => current }; const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const events = []; let availabilityCalls = 0;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", clock: now, config, telemetry: (event) => events.push(event),
    transport: { maxAvailSize: async () => { availabilityCalls += 1; const error = new Error("temporary unavailable"); error.diagnostic = { failureClass: "TIMEOUT", endpoint: "/api/v5/account/max-avail-size", durationMs: 15, attempts: 4 }; throw error; } },
  });
  coordinator.enqueue({ intent: "SELL", instId: "BTC-USDT", baseCcy: "BTC", sourceBuyTradeId: "availability-retry", remainingSize: "1", fillVersion: 1, sellTime: 1 });
  assert.equal((await coordinator.drainOnce()).reason, "NO_ELIGIBLE");
  assert.equal(availabilityCalls, 1); assert.equal(coordinator.pending.SELL.get("BTC:availability-retry").lastDeferReason, "MAX_AVAIL_FAILED");
  assert.equal(coordinator.pending.SELL.get("BTC:availability-retry").notBefore, 2_000);
  coordinator.enqueue({ intent: "SELL", instId: "BTC-USDT", baseCcy: "BTC", sourceBuyTradeId: "availability-retry", remainingSize: "1", fillVersion: 1, sellTime: 1, bidPx: "99" });
  assert.equal(coordinator.pending.SELL.get("BTC:availability-retry").notBefore, 2_000, "a duplicate SELL enqueue must not erase an active availability backoff");
  coordinator.enqueue({ intent: "SELL", instId: "ETH-USDT", baseCcy: "ETH", sourceBuyTradeId: "availability-other", remainingSize: "1", fillVersion: 1, sellTime: 1 });
  await coordinator.drainOnce(); assert.equal(availabilityCalls, 1, "the retry is held until its backoff expires");
  current = 2_000; await coordinator.drainOnce(); assert.equal(availabilityCalls, 2);
  assert.equal(events.filter((event) => event.reason === "MAX_AVAIL_FAILED").length, 2, "each failed availability round emits one bounded error summary");
  assert.deepEqual(events.at(-1), { type: "exit_deferred", intent: "SELL", reason: "MAX_AVAIL_FAILED", candidateCount: 1, error: "TIMEOUT", failureClass: "TIMEOUT", endpoint: "/api/v5/account/max-avail-size", durationMs: 15, attempts: 4 });
});

test("P3 stuck exit diagnostics expose only bounded operational evidence", () => {
  const now = { nowMs: () => 700_000 };
  const coordinator = new OrderCoordinator({ clock: now, config: {} });
  coordinator.pending.SELL.set("CATI:one", { instId: "CATI-USDT", firstDeferredAt: 100_000, lastDeferReason: "NOT_READY" });
  coordinator.pending.DELIST.set("CFG:two", { instId: "CFG-USDT", firstDeferredAt: 200_000, lastDeferReason: "INSTRUMENT_NOT_TRADABLE" });
  coordinator.pending.SELL.set("NEW:three", { instId: "NEW-USDT", firstDeferredAt: 650_000, lastDeferReason: "NOT_READY" });
  assert.deepEqual(coordinator.stuckExitSnapshot(300_000), { count: 2, oldestAgeMs: 600_000, reasons: "INSTRUMENT_NOT_TRADABLE:1,NOT_READY:1", instruments: "CATI-USDT,CFG-USDT" });
  assert.equal(coordinator.stuckExitCount(300_000), 2);
});

test("P3 market WS storm blocks BUY but never suppresses an already-triggered exit", () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const ready = gate(); ready.set("public", false); ready.set("private", false); ready.set("business", false);
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: ready, ownerGuard: { isHeld: () => true }, mode: () => "FULL", clock: now, config, transport: { clockFresh: () => true } });
  assert.equal(coordinator._buyGuard({ instId: "BTC-USDT", generation: 0 }).reason, "NOT_READY");
  assert.equal(coordinator._exitGuard({ instId: "BTC-USDT", baseCcy: "BTC", remainingSize: "1" }, "SELL").allowed, true);
});

test("P3 dust transition drops the hot pending intent and synchronizes the watch", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" }); market.updateTicker({ instId: "BTC-USDT", ts: 1, last: "1", bidPx: "1" });
  const row = { account_id: "p3", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "dust-sync", side: "BUY", fill_size: "0.05", disposed_size: "0", sell_time: 1, sell_state: "DUST_PENDING", version: 2 }; let availCalls = 0; let applied;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "OFF", clock: now, config, onExitDust: ({ row: value }) => { applied = value; },
    state: { markDust: async (_tx, args) => { assert.equal(args.tradeId, "dust-sync"); return { rowCount: 1, rows: [row] }; } }, orders: {}, transport: { maxAvailSize: async () => { availCalls += 1; return [{ instId: "BTC-USDT", availSell: "0.05" }]; } },
  });
  coordinator.enqueue({ intent: "SELL", instId: "BTC-USDT", baseCcy: "BTC", sourceBuyTradeId: "dust-sync", remainingSize: "0.05", fillVersion: 1, sellTime: 1, bidPx: "1" });
  assert.equal((await coordinator.drainOnce()).reason, "NO_ELIGIBLE"); assert.equal(coordinator.pending.SELL.size, 0); assert.equal(applied, row);
  await coordinator.drainOnce(); assert.equal(availCalls, 1);
});

test("P3 rebuild reports a redacted sell-watch state snapshot", () => {
  const telemetry = []; const sell = new SellService({ market: new MarketProjection({ clock: { nowMs: () => 1 } }), coordinator: { enqueue: () => true }, telemetry: (event) => telemetry.push(event) });
  sell.rebuild([
    { account_id: "secret", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "one", side: "BUY", sell_state: "WAITING" },
    { account_id: "secret", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "two", side: "BUY", sell_state: "SELL_TRIGGERED" },
    { account_id: "secret", inst_id: "ETH-USDT", base_ccy: "ETH", trade_id: "three", side: "BUY", sell_state: "DUST_PENDING" },
  ]);
  assert.deepEqual(telemetry.at(-1), { type: "sell_watch_loaded", reason: "SELL_WATCH_SNAPSHOT", total: 3, instruments: 2, waiting: 1, triggered: 1, dustPending: 1 });
});

test("P3 releases a breach latch when the critical queue rejects the event", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "queue-full", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "WAITING", version: 1, protection_price: "90" };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, state: {} });
  const { BoundedPriorityQueue, TradingEngine } = await import("../src/application/trading-engine.js");
  sell.rebuild([fill]); const engine = new TradingEngine({ projection: market, clock: now, sellService: sell, queue: new BoundedPriorityQueue({ capacity: 0 }) });
  engine.receiveTicker({ instId: "BTC-USDT", ts: 2, last: "89", bidPx: "89" });
  assert.equal(sell.latches.has(sell.key(fill)), false);
  assert.equal(sell.observeTicker("BTC-USDT").length, 1, "the next observation can arm the breach again");
});

test("P3 retries DB failures and CAS loss without leaking the breach latch", async () => {
  const now = { value: 1_000, nowMs() { return this.value; } }; const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "89", bidPx: "89" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "retry", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "WAITING", version: 1, protection_price: "90" };
  let loads = 0; let marks = 0; const intents = [];
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: (intent) => Boolean(intents.push(intent)) }, loadFill: async () => { if (loads++ === 0) throw new Error("db down"); return fill; }, state: { markSellTriggered: async () => marks++ === 0 ? { rowCount: 0 } : { rowCount: 1, rows: [{ ...fill, sell_state: "SELL_TRIGGERED", version: 2 }] } } });
  sell.rebuild([fill]); const engine = new (await import("../src/application/trading-engine.js")).TradingEngine({ projection: market, clock: now, sellService: sell });
  engine.enqueueSellEvents(sell.observeTicker("BTC-USDT"));
  await assert.rejects(engine.consumeOne(), /db down/);
  now.value += 100; assert.equal((await engine.consumeOne()).reason, "CAS_LOST");
  now.value += 200; assert.equal((await engine.consumeOne()).reason, "SELL_TRIGGERED");
  assert.equal(intents.length, 1); assert.equal(sell.latches.has(sell.key(fill)), true);
});

test("P3 resumes durable SELL_TRIGGERED exits without another price breach", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const intents = []; let marks = 0;
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "100", bidPx: "100" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "durable", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "SELL_TRIGGERED", version: 2, protection_price: "90" };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: (intent) => Boolean(intents.push(intent)) }, loadFill: async () => fill, state: { markSellTriggered: async () => { marks += 1; } } });
  sell.rebuild([fill]); const events = sell.resumeTriggered();
  assert.equal(events.length, 1); assert.equal(events[0].resumed, true);
  assert.equal((await sell.consume(events[0])).reason, "SELL_TRIGGERED_RESUMED");
  assert.equal(marks, 0); assert.equal(intents.length, 1);
});

test("P3 retries Coordinator rejection after persisting SELL_TRIGGERED", async () => {
  const now = { value: 1_000, nowMs() { return this.value; } }; const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" }); market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "89", bidPx: "89" });
  const waiting = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "coordinator", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "WAITING", version: 1, protection_price: "90" };
  const triggered = { ...waiting, sell_state: "SELL_TRIGGERED", version: 2 }; let durable = waiting; let marks = 0; let accepts = false;
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => accepts }, loadFill: async () => durable, state: { markSellTriggered: async () => { marks += 1; durable = triggered; return { rowCount: 1, rows: [triggered] }; } } });
  sell.rebuild([waiting]); const engine = new (await import("../src/application/trading-engine.js")).TradingEngine({ projection: market, clock: now, sellService: sell }); engine.enqueueSellEvents(sell.observeTicker("BTC-USDT"));
  assert.equal((await engine.consumeOne()).reason, "COORDINATOR_REJECTED"); accepts = true; now.value += 100;
  assert.equal((await engine.consumeOne()).reason, "SELL_TRIGGERED"); assert.equal(marks, 1, "retry does not rewrite durable trigger state");
});

test("P3 recovery retains PREPARED and UNKNOWN after every consistency source misses, and rebuilds durable watches", async () => {
  const gateValue = gate(); const recovery = [];
  const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: gateValue, safetyWaitMs: 0,
    sleep: async () => {}, transaction: async (fn) => fn({}), onRecovery: async (snapshot) => recovery.push(snapshot),
    state: { listProtection: async () => [{ state: "EXITING" }], listDaily: async () => [], listManagedFills: async () => [{ sell_state: "DUST_PENDING" }] },
    orders: { listNonTerminal: async () => [{ state: "PREPARED", inst_id: "BTC-USDT", cl_ord_id: "prepared" }, { state: "UNKNOWN", inst_id: "BTC-USDT", cl_ord_id: "unknown" }], listTodayBuys: async () => [], listWatermarks: async () => [], upsertWatermark: async () => {} },
    transport: { order: async () => ({ state: "NOT_FOUND" }), ordersPending: async () => [], ordersHistory: async () => [], ordersHistoryArchive: async () => [], fills: async () => [], fillsHistory: async () => [] },
  });
  const result = await service.recover({ accountId: "p3" });
  assert.equal(result.recovered.every((row) => row.outcome === "RETAIN_UNKNOWN"), true);
  assert.equal(recovery.length, 1); assert.equal(recovery[0].ledger[0].sell_state, "DUST_PENDING");
  assert.equal(gateValue.ready, false, "baseline completion, never a lookup, restores READY");
});

test("P3 announcement receipt is atomic per page, uses exact symbol boundaries, and telemetry cannot block", async () => {
  const committed = new Set(); const exits = []; const events = [];
  const protection = new InstrumentProtectionService({ nowMs: () => 100_000, telemetry: () => { throw new Error("slow telemetry"); }, onExit: (row) => exits.push(row), transaction: async (fn) => fn({}), state: {
    claimAnnouncement: async (_tx, item) => { const key = `${item.title}:${item.pTime}`; if (committed.has(key)) return { rowCount: 0 }; committed.add(key); return { rowCount: 1 }; },
    upsertProtection: async (_tx, row) => events.push(row),
  } });
  const page = async (number) => number === 1 ? { data: [{ details: [{ title: "Spot delisting ABC and ABCD", pTime: 99_999 }] }] } : { data: [{ details: [] }] };
  assert.deepEqual(await protection.scanAnnouncements(page, [{ instId: "ABC-USDT", base: "ABC" }, { instId: "AB-USDT", base: "AB" }, { instId: "ABCD-USDT", base: "ABCD" }]), { crossedWindow: false, pages: 2 });
  assert.deepEqual(events.map((row) => row.instId).sort(), ["ABC-USDT", "ABCD-USDT"]);
  assert.equal(exits.length, 2);
  await protection.scanAnnouncements(page, [{ instId: "ABC-USDT", base: "ABC" }]);
  assert.equal(events.length, 2, "receipt replay is idempotent");
});

test("P3 dust recovery immediately requeues SELL and async/throwing telemetry never blocks mutation guards", async () => {
  const now = { nowMs: () => 100 }; const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" }); market.updateTicker({ instId: "BTC-USDT", ts: 99, last: "10", bidPx: "10" });
  const queued = []; let triggered = 0;
  const row = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "dust", side: "BUY", fill_size: "0.1", disposed_size: "0", sell_time: 1, sell_state: "DUST_PENDING", version: 1, protection_price: "11", availableBase: "0.1" };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: (entry) => queued.push(entry) }, telemetry: () => Promise.reject(new Error("telemetry unavailable")), loadFill: async () => row, state: {
    markSellTriggered: async () => { triggered += 1; return { rowCount: 1, rows: [{ ...row, sell_state: "SELL_TRIGGERED", version: 2 }] }; }, raiseProtection: async () => ({ rowCount: 1 }),
  } });
  sell.rebuild([row]); await sell.reviewDust();
  assert.equal(triggered, 1); assert.equal(queued.length, 1); assert.equal(queued[0].remainingSize, "0.1");
});

test("P3 slow or rejected telemetry cannot delay Coordinator persistence or reconciliation READY loss", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "10", adjEq: "10" });
  market.updateInstrument({ instId: "SLOW-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "SLOW" });
  const attempts = new Map(); const events = []; let telemetryCalls = 0;
  const telemetry = (event) => { events.push(event); telemetryCalls += 1; return telemetryCalls % 2 ? new Promise(() => {}) : Promise.reject(new Error("telemetry rejected")); };
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { markDust: async () => ({ rowCount: 1 }) }, market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "OFF", clock: now, config, telemetry,
    orders: { reserveExit: async (_tx, row) => { attempts.set(row.clOrdId, { state: "PREPARED" }); return { authorized: true }; }, markSubmitted: async () => {}, markNotCreated: async () => {}, markUnknown: async (_tx, id) => { attempts.get(id).state = "UNKNOWN"; } },
    transport: { maxAvailSize: async () => [{ instId: "SLOW-USDT", availSell: "1" }], submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "UNKNOWN", reason: "timeout" })) },
  });
  coordinator.enqueue({ intent: "SELL", instId: "SLOW-USDT", baseCcy: "SLOW", sourceBuyTradeId: "slow-buy", remainingSize: "1", availableBase: "1", bidPx: "10", fillVersion: 1, sellTime: 1 });
  const result = await coordinator.drainOnce(); assert.equal(result.submitted, true); assert.equal([...attempts.values()][0].state, "UNKNOWN");
  assert.equal(events.some((event) => event.reason === "EXIT_UNKNOWN"), true);
  assert.equal(events.some((event) => event.type === "exit_batch" && event.reason === "ORDER_UNCONFIRMED"), true);

  const ready = gate(); let lost;
  const owner = { isHeld: () => true, onLost: (handler) => { lost = handler; } };
  const recovery = new ReconciliationService({ ownerGuard: owner, readyGate: ready, safetyWaitMs: 0, telemetry, transaction: async (fn) => fn({}), state: { listProtection: async () => [], listDaily: async () => [], listManagedFills: async () => [] }, orders: { listNonTerminal: async () => [], listTodayBuys: async () => [], listWatermarks: async () => [] }, transport: {} });
  lost(); assert.equal(ready.ready, false);
  assert.equal((await recovery.recover({ accountId: "slow" })).reason, "BASELINES_REQUIRED");
});
test("P3 scheduled close latches in the callback, sells regardless of price, and persists only from its critical consumer", async () => {
  const now = { value: 1_000, nowMs() { return this.value; } }; const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const row = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "t1", side: "BUY", fill_size: "1", disposed_size: "0", fill_price: "100", sell_time: 2_000, sell_state: "WAITING", version: 1, availableBase: "1" };
  let writes = 0; const queued = []; const marks = [];
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: (intent) => queued.push(intent) }, state: {
    markSellTriggered: async (_tx, args) => { writes += 1; marks.push(args); return { rowCount: 1, rows: [{ ...row, sell_state: "SELL_TRIGGERED", sell_trigger_reason: args.sellTriggerReason, version: 2 }] }; },
  }, loadFill: async () => row });
  sell.rebuild([row]); const engine = new (await import("../src/application/trading-engine.js")).TradingEngine({ projection: market, clock: now, sellService: sell });
  market.updateTicker({ instId: "BTC-USDT", ts: 1_000, last: "150", bidPx: "150" });
  assert.deepEqual(sell.observeTicker("BTC-USDT"), [], "no take-profit: a large gain before sell_time never sells");
  market.updateTicker({ instId: "BTC-USDT", ts: 1_001, last: "30", bidPx: "30" });
  assert.deepEqual(sell.observeTicker("BTC-USDT"), [], "no stop loss: a deep drawdown before sell_time never sells");
  assert.deepEqual(sell.protectionHealth(), { sell_overdue_current: 0, anchor_due_unprotected_current: 0 });
  now.value = 2_000;
  const events = sell.observeTicker("BTC-USDT");
  assert.deepEqual(events.map((event) => [event.type, event.reason, event.sellTime]), [["SELL_BREACH", "SCHEDULED_CLOSE", 2_000]]);
  assert.equal(writes, 0, "WS-side observation does no DB work");
  assert.deepEqual(sell.reviewDueWatches(), [], "the latch dedupes the periodic review");
  engine.queue.enqueue(events[0]); await engine.consumeOne();
  assert.equal(writes, 1); assert.equal(marks[0].sellTriggerReason, "SCHEDULED_CLOSE"); assert.equal(marks[0].protectionPrice, null);
  assert.deepEqual(queued.map((intent) => [intent.intent, intent.reason, intent.remainingSize]), [["SELL", "SCHEDULED_CLOSE", "1"]]);
  now.value = 70_000;
  assert.equal(sell.protectionHealth().sell_overdue_current, 1, "a triggered close that has not sold within a minute is reported for alerting");
});

test("P3 scheduled close is found by the periodic review even without ticks and routes delisting symbols to DELIST", async () => {
  const now = { nowMs: () => 5_000 }; const market = new MarketProjection({ clock: now }); const queued = [];
  const rows = [
    { account_id: "a", inst_id: "QUIET-USDT", base_ccy: "QUIET", trade_id: "q", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 4_000, sell_state: "WAITING", version: 1 },
    { account_id: "a", inst_id: "LATER-USDT", base_ccy: "LATER", trade_id: "l", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 6_000, sell_state: "WAITING", version: 1 },
    { account_id: "a", inst_id: "DUST-USDT", base_ccy: "DUST", trade_id: "d", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "DUST_PENDING", version: 1 },
  ];
  const sell = new SellService({ market, clock: now, isDelisting: (instId) => instId === "QUIET-USDT", coordinator: { enqueue: (intent) => Boolean(queued.push(intent)) }, loadFill: async (_tx, key) => rows.find((row) => key.endsWith(`:${row.trade_id}`)), state: { markSellTriggered: async (_tx, args) => ({ rowCount: 1, rows: [{ ...rows[0], sell_state: "SELL_TRIGGERED", sell_trigger_reason: args.sellTriggerReason, version: 2 }] }) } });
  sell.rebuild(rows);
  const events = sell.reviewDueWatches();
  assert.deepEqual(events.map((event) => event.instId), ["QUIET-USDT"], "only due WAITING fills; dust is owned by reviewDust");
  await sell.consume(events[0]);
  assert.deepEqual(queued.map((intent) => [intent.intent, intent.instId]), [["DELIST", "QUIET-USDT"]]);
});

test("P3 an exhausted exit is re-driven after the stall window instead of waiting for reconciliation", () => {
  const now = { value: 1_000, nowMs() { return this.value; } }; const telemetry = [];
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "stalled", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "SELL_TRIGGERED", sell_trigger_reason: "SCHEDULED_CLOSE", version: 3 };
  const sell = new SellService({ market: new MarketProjection({ clock: now }), clock: now, coordinator: { enqueue: () => true }, telemetry: (event) => telemetry.push(event) });
  sell.rebuild([fill]);
  assert.equal(sell.hasTriggered(), true);
  assert.equal(sell.resumeTriggered().length, 1, "restart resume latches the exit");
  assert.deepEqual(sell.resumeStalled({ nowMs: 10_000 }), [], "a freshly latched exit is left alone");
  assert.deepEqual(sell.resumeStalled({ nowMs: 40_000, activeSourceTradeIds: new Set(["stalled"]) }), [], "an active attempt owns it");
  assert.deepEqual(sell.resumeStalled({ nowMs: 40_000, pendingSourceTradeIds: new Set(["stalled"]) }), [], "a pending Coordinator intent owns it");
  const resumed = sell.resumeStalled({ nowMs: 40_000 });
  assert.deepEqual(resumed.map((event) => [event.type, event.reason, event.resumed]), [["SELL_BREACH", "SCHEDULED_CLOSE", true]]);
  assert.ok(telemetry.some((event) => event.reason === "SELL_EXIT_STALL_RECOVERED"));
  assert.deepEqual(sell.resumeStalled({ nowMs: 50_000 }), [], "and it is re-latched");
});

test("P3 settleExit partial-fill continuations keep the scheduled-close reason and no take-profit reference", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const attempt = { intent: "SELL", account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", source_buy_trade_id: "partial", generation: 0, cl_ord_id: "partial-1" };
  const source = { fill_size: "2", disposed_size: "1", version: 5, sell_trigger_reason: "SCHEDULED_CLOSE", fill_price: "100", protection_price: null };
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { recordSystemSell: async () => ({ source }) }, orders: { markSettled: async () => ({ rowCount: 1 }) }, market, account: new AccountCapitalSnapshot({ clock: now }), readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "OFF", clock: now, config });
  assert.deepEqual(await coordinator.settleExit({ attempt, fills: [{ tradeId: "t1", fillSz: "1", fillTime: "1" }], exchangeState: "canceled", accFillSz: "1" }), { settled: true, remaining: "1" });
  const queued = [...coordinator.pending.SELL.values()][0];
  assert.deepEqual([queued.reason, queued.referencePrice, queued.generation, queued.remainingSize], ["SCHEDULED_CLOSE", undefined, 1, "1"]);
  assert.deepEqual([...coordinator.pendingExitSources()], ["partial"]);
});
