import assert from "node:assert/strict";
import test from "node:test";
import { AccountCapitalSnapshot, MarketProjection, ReadyGate } from "../src/application/trading-engine.js";
import { OrderCoordinator } from "../src/application/order-coordinator.js";
import { SellService } from "../src/application/sell-service.js";
import { InstrumentProtectionService } from "../src/application/instrument-protection-service.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";

const config = { accountId: "p3", strategyTag: "P3", orderVersion: "v1", orderExpiryMs: 1_000, accountFreshMs: 10_000, quoteFreshMs: 10_000 };
const clock = () => ({ nowMs: () => 1_000 });
function gate() { const value = new ReadyGate(); for (const key of value.required) value.set(key, true); return value; }

test("P3 exits submit immediate five-base batches with DELIST priority and no shared-account excess", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  const attempts = new Map(); const payloads = []; let mode = "EXIT_ONLY";
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { markDust: async () => ({ rowCount: 1 }) }, market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => mode, clock: now, config,
    orders: {
      reserveExit: async (_tx, row) => { attempts.set(row.clOrdId, { ...row, state: "PREPARED" }); return { authorized: true }; },
      markSubmitted: async (_tx, id) => { attempts.get(id).state = "SUBMITTED"; }, markUnknown: async (_tx, id) => { attempts.get(id).state = "UNKNOWN"; }, markNotCreated: async (_tx, id) => { attempts.get(id).state = "NOT_CREATED"; },
    },
    transport: {
      maxAvailSize: async (ids, options) => { assert.equal(options.tdMode, "cross"); return ids.split(",").map((instId) => ({ instId, availSell: "2" })); },
      submitBatchOrders: async (rows) => { payloads.push(rows); return rows.map((row, index) => ({ clOrdId: row.clOrdId, status: index === 0 ? "UNKNOWN" : "SUBMITTED", ordId: String(index) })); },
    },
  });
  for (let index = 0; index < 20; index += 1) {
    const base = `C${String(index).padStart(2, "0")}`; const instId = `${base}-USDT`;
    market.updateInstrument({ instId, ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base });
    coordinator.enqueue({ intent: "SELL", instId, baseCcy: base, sourceBuyTradeId: `buy-${base}`, remainingSize: "1", availableBase: "100", bidPx: "10", fillVersion: 1, sellTime: 1, ...(index === 0 ? { executionRoute: "spot" } : {}) });
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
  assert.equal((await coordinator.drainOnce()).reason, "NO_ELIGIBLE");
});

test("P3 engine latches breach in the callback and persists only from its critical consumer", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const row = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "t1", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "WAITING", version: 1, protection_price: "90", availableBase: "1" };
  let writes = 0; const queued = [];
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: (intent) => queued.push(intent) }, state: {
    markSellTriggered: async () => { writes += 1; return { rowCount: 1, rows: [{ ...row, sell_state: "SELL_TRIGGERED", version: 2 }] }; }, raiseProtection: async () => ({ rowCount: 1 }),
  }, loadFill: async () => row });
  sell.rebuild([row]); const engine = new (await import("../src/application/trading-engine.js")).TradingEngine({ projection: market, clock: now, sellService: sell });
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "89", bidPx: "89" });
  const events = sell.observeTicker("BTC-USDT"); assert.equal(events.length, 1); assert.equal(writes, 0, "WS-side observation does no DB work");
  engine.queue.enqueue(events[0]); await engine.consumeOne(); assert.equal(writes, 1); assert.equal(queued.length, 1);
  assert.equal(sell.observeTicker("BTC-USDT").length, 0, "latch survives a price bounce and duplicate tick");
  market.updateCandle({ instId: "BTC-USDT", ts: 10, low: "95", confirm: true });
  assert.equal(sell.observeCandle("BTC-USDT").find((event) => event.type === "SELL_PROTECTION").protection, "95");
  market.updateCandle({ instId: "BTC-USDT", ts: 10, low: "80", confirm: true });
  assert.equal(sell.observeCandle("BTC-USDT").some((event) => event.type === "SELL_PROTECTION"), false, "same-ts correction never lowers protection");
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
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { markDust: async () => ({ rowCount: 1 }) }, market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "EXIT_ONLY", clock: now, config, telemetry,
    orders: { reserveExit: async (_tx, row) => { attempts.set(row.clOrdId, { state: "PREPARED" }); return { authorized: true }; }, markSubmitted: async () => {}, markNotCreated: async () => {}, markUnknown: async (_tx, id) => { attempts.get(id).state = "UNKNOWN"; } },
    transport: { maxAvailSize: async () => [{ instId: "SLOW-USDT", availSell: "1" }], submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "UNKNOWN", reason: "timeout" })) },
  });
  coordinator.enqueue({ intent: "SELL", instId: "SLOW-USDT", baseCcy: "SLOW", sourceBuyTradeId: "slow-buy", remainingSize: "1", availableBase: "1", bidPx: "10", fillVersion: 1, sellTime: 1 });
  const result = await coordinator.drainOnce(); assert.equal(result.submitted, true); assert.equal([...attempts.values()][0].state, "UNKNOWN");
  assert.equal(events.some((event) => event.reason === "EXIT_UNKNOWN"), true);

  const ready = gate(); let lost;
  const owner = { isHeld: () => true, onLost: (handler) => { lost = handler; } };
  const recovery = new ReconciliationService({ ownerGuard: owner, readyGate: ready, safetyWaitMs: 0, telemetry, transaction: async (fn) => fn({}), state: { listProtection: async () => [], listDaily: async () => [], listManagedFills: async () => [] }, orders: { listNonTerminal: async () => [], listTodayBuys: async () => [], listWatermarks: async () => [] }, transport: {} });
  lost(); assert.equal(ready.ready, false);
  assert.equal((await recovery.recover({ accountId: "slow" })).reason, "BASELINES_REQUIRED");
});
