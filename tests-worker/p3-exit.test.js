import assert from "node:assert/strict";
import test from "node:test";
import { AccountCapitalSnapshot, MarketProjection, ReadyGate } from "../src/application/trading-engine.js";
import { OrderCoordinator } from "../src/application/order-coordinator.js";
import { SellService } from "../src/application/sell-service.js";
import { InstrumentProtectionService } from "../src/application/instrument-protection-service.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";
import { ExitSubmissionReconciler } from "../src/application/exit-submission-reconciler.js";
import { expectedClosedCandleTs } from "../src/domain/rules.js";

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
      maxAvailSize: async (ids, options) => { assert.equal(options.tdMode, "cross"); return ids.split(",").map((instId) => ({ instId, availSell: "2" })); },
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

test("P3 exit availability failures defer retries instead of retrying on every work loop", async () => {
  let current = 1_000; const now = { nowMs: () => current }; const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const events = []; let availabilityCalls = 0;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "FULL", clock: now, config, telemetry: (event) => events.push(event),
    transport: { maxAvailSize: async () => { availabilityCalls += 1; throw new Error("temporary unavailable"); } },
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
  market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), low: "95", confirm: true });
  assert.equal(sell.observeCandle("BTC-USDT").find((event) => event.type === "SELL_PROTECTION"), undefined, "a triggered exit must not receive a later protection update");
  market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), low: "80", confirm: true });
  assert.equal(sell.observeCandle("BTC-USDT").find((event) => event.type === "SELL_PROTECTION"), undefined, "a corrected lower low never loosens protection");
});

test("P3 SELL uses a strict 3m breakdown: equality does not trigger", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "strict", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 0, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, state: { raiseProtection: async () => ({ rowCount: 1, rows: [{ ...fill, protection_price: "99.7", version: 2 }] }) } });
  sell.rebuild([fill]); market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), low: "100", confirm: true });
  await sell.consume(sell.observeCandle("BTC-USDT").find((event) => event.type === "SELL_PROTECTION"));
  market.updateTicker({ instId: "BTC-USDT", ts: 11, last: "99.7", bidPx: "99.7" });
  assert.equal(sell.observeTicker("BTC-USDT").length, 0);
  market.updateTicker({ instId: "BTC-USDT", ts: 12, last: "99.699", bidPx: "99.699" });
  assert.equal(sell.observeTicker("BTC-USDT").length, 1);
});

test("P3 take-profit fires immediately from bidPx, independent of sell_time, without touching protection_price", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "120", bidPx: "120" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "tp-fast", side: "BUY", fill_size: "1", disposed_size: "0", fill_price: "100", sell_time: 999_999_999_999, sell_state: "WAITING", version: 1 };
  let markCall;
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, loadFill: async () => fill, state: { markSellTriggered: async (_tx, row) => { markCall = row; return { rowCount: 1, rows: [{ ...fill, sell_state: "SELL_TRIGGERED", version: 2 }] }; } } });
  sell.rebuild([fill]);
  const events = sell.observeTicker("BTC-USDT");
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "TAKE_PROFIT");
  assert.equal(events[0].referencePrice, "120");
  assert.equal(events[0].protection, undefined, "no downside floor was ever armed for this fill");
  await sell.consume(events[0]);
  assert.equal(markCall.protectionPrice, undefined, "take-profit must not write a fabricated floor into protection_price");
  assert.equal(markCall.sellTriggerReason, "TAKE_PROFIT");
});

test("P3 take-profit boundary is inclusive and judged by bidPx, not last", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "tp-boundary", side: "BUY", fill_size: "1", disposed_size: "0", fill_price: "100", sell_time: 1, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, state: {} });
  sell.rebuild([fill]);
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "120", bidPx: "119.99" });
  assert.equal(sell.observeTicker("BTC-USDT").length, 0, "just under the 1.20x line does not trigger");
  market.updateTicker({ instId: "BTC-USDT", ts: 3, last: "120", bidPx: "120" });
  assert.equal(sell.observeTicker("BTC-USDT").length, 1, "exactly at the 1.20x line triggers (>=)");
  sell.latches.clear();
  market.updateTicker({ instId: "BTC-USDT", ts: 4, last: "125", bidPx: "115" });
  assert.equal(sell.observeTicker("BTC-USDT").length, 0, "last looks up 25% but bidPx is still under the line — must not trigger on last");
});

test("P3 take-profit ignores non-WAITING fills and requires a complete quote", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "120", bidPx: "120" });
  const base = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", side: "BUY", fill_size: "1", disposed_size: "0", fill_price: "100", sell_time: 1, version: 1 };
  const sold = { ...base, trade_id: "tp-sold", sell_state: "SOLD" };
  const dust = { ...base, trade_id: "tp-dust", sell_state: "DUST_PENDING" };
  const triggered = { ...base, trade_id: "tp-triggered", sell_state: "SELL_TRIGGERED", sell_trigger_reason: "MAX_HOLD_EXPIRED" };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, state: {} });
  sell.rebuild([sold, dust, triggered]);
  assert.equal(sell.observeTicker("BTC-USDT").length, 0, "SOLD/DUST_PENDING/SELL_TRIGGERED must never be relabeled TAKE_PROFIT by this scan");
  const waiting = { ...base, trade_id: "tp-waiting", sell_state: "WAITING" };
  sell.rebuild([waiting]);
  market.updateTicker({ instId: "BTC-USDT", ts: 3, last: "120" });
  assert.equal(sell.observeTicker("BTC-USDT").length, 0, "missing bidPx must wait for a complete quote, not fall back to last");
  market.updateTicker({ instId: "BTC-USDT", ts: 4, last: "120", bidPx: "120" });
  assert.equal(sell.observeTicker("BTC-USDT").length, 1);
});

test("P3 take-profit outranks force hold with a fresh quote, but force hold still fires without one", () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "tp-vs-hold", side: "BUY", fill_size: "1", disposed_size: "0", fill_price: "100", sell_time: 1, force_sell_time: 1_000, sell_state: "WAITING", version: 1 };
  const sellWithQuote = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, state: {} });
  sellWithQuote.rebuild([fill]);
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "120", bidPx: "120" });
  const events = sellWithQuote.observeTicker("BTC-USDT");
  assert.equal(events.length, 1, "force hold must not also fire once take-profit has already latched this fill");
  assert.equal(events[0].reason, "TAKE_PROFIT");
  const sellNoQuote = new SellService({ market: { freshQuote: () => undefined }, clock: now, coordinator: { enqueue: () => true }, state: {} });
  sellNoQuote.rebuild([fill]);
  const withoutQuote = sellNoQuote.observeTicker("BTC-USDT");
  assert.equal(withoutQuote.length, 1, "force hold must still fire independently when no fresh quote exists");
  assert.equal(withoutQuote[0].reason, "MAX_HOLD_EXPIRED");
});

test("P3 take-profit decision reason and reference price persist through submitExits", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  let attempt;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: {}, market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "OFF", clock: now, config,
    orders: { reserveExit: async (_tx, row) => { attempt = row; return { authorized: true }; }, markSubmitted: async () => {} },
    transport: { maxAvailSize: async () => [{ instId: "BTC-USDT", availSell: "1" }], submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "SUBMITTED", ordId: "tp" })) },
  });
  coordinator.enqueue({ intent: "SELL", instId: "BTC-USDT", baseCcy: "BTC", sourceBuyTradeId: "tp-1", remainingSize: "1", fillVersion: 1, sellTime: 0, availableBase: "1", bidPx: "120", referencePrice: "120", reason: "TAKE_PROFIT" });
  await coordinator.drainOnce();
  assert.equal(attempt.decisionReason, "SELL_TAKE_PROFIT_CONFIRMED");
  assert.equal(attempt.decisionReferencePrice, "120");
});

test("P3 breakdown-triggered exits still record SELL_BREAKDOWN_CONFIRMED (regression)", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); account.update({ ts: 1, totalEq: "100", adjEq: "100" });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  let attempt;
  const coordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: {}, market, account, readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "OFF", clock: now, config,
    orders: { reserveExit: async (_tx, row) => { attempt = row; return { authorized: true }; }, markSubmitted: async () => {} },
    transport: { maxAvailSize: async () => [{ instId: "BTC-USDT", availSell: "1" }], submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "SUBMITTED", ordId: "bd" })) },
  });
  coordinator.enqueue({ intent: "SELL", instId: "BTC-USDT", baseCcy: "BTC", sourceBuyTradeId: "bd-1", remainingSize: "1", fillVersion: 1, sellTime: 0, availableBase: "1", bidPx: "90", protection: "90", reason: "PRICE_BREAKDOWN" });
  await coordinator.drainOnce();
  assert.equal(attempt.decisionReason, "SELL_BREAKDOWN_CONFIRMED");
  assert.equal(attempt.decisionReferencePrice, "90");
});

test("P3 settleExit partial-fill continuations preserve the original trigger reason", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const takeProfitAttempt = { intent: "SELL", account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", source_buy_trade_id: "tp-partial", generation: 0, cl_ord_id: "tp-partial-1" };
  const takeProfitSource = { fill_size: "2", disposed_size: "1", version: 5, sell_trigger_reason: "TAKE_PROFIT", fill_price: "100", protection_price: null };
  const tpCoordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { recordSystemSell: async () => ({ source: takeProfitSource }) }, orders: { markSettled: async () => ({ rowCount: 1 }) }, market, account: new AccountCapitalSnapshot({ clock: now }), readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "OFF", clock: now, config });
  const tpResult = await tpCoordinator.settleExit({ attempt: takeProfitAttempt, fills: [{ tradeId: "t1", fillSz: "1", fillTime: "1" }], exchangeState: "canceled", accFillSz: "1" });
  assert.deepEqual(tpResult, { settled: true, remaining: "1" });
  const tpQueued = [...tpCoordinator.pending.SELL.values()][0];
  assert.equal(tpQueued.reason, "TAKE_PROFIT");
  assert.equal(tpQueued.referencePrice, "120");
  assert.equal(tpQueued.protection == null, true, "no downside floor was ever armed — must stay null/undefined, never the take-profit target");

  const breakdownAttempt = { intent: "SELL", account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", source_buy_trade_id: "bd-partial", generation: 0, cl_ord_id: "bd-partial-1" };
  const breakdownSource = { fill_size: "2", disposed_size: "1", version: 5, sell_trigger_reason: "PRICE_BREAKDOWN", fill_price: "100", protection_price: "95" };
  const bdCoordinator = new OrderCoordinator({ transaction: async (fn) => fn({}), state: { recordSystemSell: async () => ({ source: breakdownSource }) }, orders: { markSettled: async () => ({ rowCount: 1 }) }, market, account: new AccountCapitalSnapshot({ clock: now }), readyGate: gate(), ownerGuard: { isHeld: () => true }, mode: () => "OFF", clock: now, config });
  await bdCoordinator.settleExit({ attempt: breakdownAttempt, fills: [{ tradeId: "t2", fillSz: "1", fillTime: "1" }], exchangeState: "canceled", accFillSz: "1" });
  const bdQueued = [...bdCoordinator.pending.SELL.values()][0];
  assert.equal(bdQueued.reason, "PRICE_BREAKDOWN");
  assert.equal(bdQueued.referencePrice, undefined);
  assert.equal(bdQueued.protection, "95");
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

test("P3 force hold fires at its boundary without a candle, fresh quote, or clock sync", () => {
  const now = { value: 100, nowMs() { return this.value; } }; const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "force", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, force_sell_time: 100, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, clockFresh: () => false, coordinator: { enqueue: () => true }, state: {} });
  sell.rebuild([fill]); assert.equal(sell.reviewForceHold().length, 1);
  assert.equal(sell.reviewForceHold().length, 0, "latch deduplicates recurring scans");
});

test("P3 force hold resumes after restart and persists its explicit reason", async () => {
  const now = { nowMs: () => 100 }; const market = new MarketProjection({ clock: now }); const writes = [];
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "force-resume", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, force_sell_time: 100, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, loadFill: async () => fill, state: { markSellTriggered: async (_tx, row) => { writes.push(row); return { rowCount: 1, rows: [{ ...fill, sell_state: "SELL_TRIGGERED", version: 2 }] }; } } });
  sell.rebuild([fill]); const [event] = sell.resumeForceHold();
  assert.equal(event.reason, "MAX_HOLD_EXPIRED"); await sell.consume(event);
  assert.equal(writes[0].sellTriggerReason, "MAX_HOLD_EXPIRED");
});

test("P3 protection only changes in memory after durable ratchet success", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "ratchet", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 0, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, loadFill: async () => fill, state: { raiseProtection: async () => ({ rowCount: 1, rows: [{ ...fill, protection_price: "94.715", version: 2 }] }) } });
  sell.rebuild([fill]); market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), low: "95", confirm: true });
  const event = sell.observeCandle("BTC-USDT").find((row) => row.type === "SELL_PROTECTION");
  assert.equal(sell.fills.get(sell.key(fill)).protection_price, undefined); await sell.consume(event);
  market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), low: "80", confirm: true });
  assert.equal(sell.observeCandle("BTC-USDT").some((row) => row.type === "SELL_PROTECTION"), false);
});

test("P3 stale clock freezes protection updates but leaves armed breakdown detection live", () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const telemetry = []; let syncs = 0;
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "89", bidPx: "89" }); market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), low: "95", confirm: true });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "stale-clock", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "WAITING", version: 1, protection_price: "90" };
  const sell = new SellService({ market, clock: now, clockFresh: () => false, triggerClockSync: () => { syncs += 1; }, coordinator: { enqueue: () => true }, telemetry: (row) => telemetry.push(row), state: {} });
  sell.rebuild([fill]); assert.equal(sell.observeCandle("BTC-USDT").filter((row) => row.type === "SELL_BREACH").length, 1);
  sell.rebuild([fill]); sell.observeCandle("BTC-USDT"); assert.equal(syncs, 1); assert.equal(telemetry.filter((row) => row.reason === "SELL_CLOCK_SYNC_STALE").length, 1);
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

test("P3 resume recovers TAKE_PROFIT attribution and recomputed referencePrice from durable state", async () => {
  const now = clock(); const market = new MarketProjection({ clock: now }); const intents = []; let marks = 0;
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateTicker({ instId: "BTC-USDT", ts: 2, last: "120", bidPx: "120" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "tp-durable", side: "BUY", fill_size: "1", disposed_size: "0", fill_price: "100", sell_time: 1, sell_state: "SELL_TRIGGERED", sell_trigger_reason: "TAKE_PROFIT", version: 2, protection_price: null };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: (intent) => Boolean(intents.push(intent)) }, loadFill: async () => fill, state: { markSellTriggered: async () => { marks += 1; } } });
  sell.rebuild([fill]); const [event] = sell.resumeTriggered();
  assert.equal(event.reason, "TAKE_PROFIT");
  assert.equal(event.referencePrice, "120");
  assert.equal(event.protection, null, "protection_price is carried through untouched, never overwritten with the take-profit target");
  assert.equal((await sell.consume(event)).reason, "SELL_TRIGGERED_RESUMED");
  assert.equal(marks, 0, "an already-triggered fill is never re-written on resume");
  assert.equal(intents[0].reason, "TAKE_PROFIT");
  assert.equal(intents[0].referencePrice, "120");
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

test("P3 stale candle preserves protection, warns when unarmed, and REST refresh re-enters candle evaluation", async () => {
  const now = { value: 720_000, nowMs() { return this.value; } }; const market = new MarketProjection({ clock: now }); const events = []; let refreshes = 0;
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateCandle({ instId: "BTC-USDT", ts: 180_000, low: "80", confirm: true });
  const protectedFill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "protected", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "WAITING", version: 1, protection_price: "90" };
  const unarmedFill = { ...protectedFill, trade_id: "unarmed", protection_price: null };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, telemetry: (event) => events.push(event), refreshCandle: async () => { refreshes += 1; market.updateCandle({ instId: "BTC-USDT", ts: 540_000, low: "95", confirm: true }); } });
  sell.rebuild([protectedFill, unarmedFill]);
  assert.deepEqual(sell.observeCandle("BTC-USDT"), []); sell.reviewCandleFreshness(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sell.fills.get(sell.key(protectedFill)).protection_price, "90"); assert.equal(refreshes, 1);
  assert.ok(events.some((event) => event.reason === "SELL_CANDLE_STALE")); assert.ok(events.some((event) => event.reason === "SELL_PROTECTION_UNARMED"));
  assert.equal(sell.observeCandle("BTC-USDT").filter((event) => event.type === "SELL_PROTECTION").length, 1, "a refreshed candle only ratchets an already protected fill; first protection requires its exact anchor");
  now.value = 1_080_000; sell.reviewCandleFreshness(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 2, "periodic review detects a feed that stopped producing candle events");
});

test("P3 first-arm waits for a 3m candle that closed at or after sellTime", () => {
  const now = clock(); const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), low: "100", confirm: true });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "pre-close", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true } });
  sell.rebuild([fill]);
  assert.equal(sell.observeCandle("BTC-USDT").some((row) => row.type === "SELL_PROTECTION"), false);
  assert.equal(sell.reviewDueWatches().some((row) => row.type === "SELL_PROTECTION"), false);
});

test("P3 ticker arms an unarmed fill after sellTime without waiting for another candle event", () => {
  const now = { nowMs: () => 181_000 }; const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateCandle({ instId: "BTC-USDT", ts: expectedClosedCandleTs(now.nowMs()), low: "100", confirm: true });
  market.updateTicker({ instId: "BTC-USDT", ts: 181_000, last: "100", bidPx: "100" });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "arm-on-tick", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1_000, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true } });
  sell.rebuild([fill]);
  const events = sell.observeTicker("BTC-USDT").filter((row) => row.type === "SELL_PROTECTION");
  assert.equal(events.length, 1);
  assert.equal(events[0].protection, "99.7");
});

test("P3 first protection uses only the exact anchor candle and breaches in the same evaluation", async () => {
  const now = { nowMs: () => 541_000 }; const market = new MarketProjection({ clock: now }); let recoveries = 0;
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateTicker({ instId: "BTC-USDT", ts: 541_000, last: "98", bidPx: "98" });
  // This is fresh, but it is the 18:30-18:33-equivalent bar, not the exact 18:27-18:30 anchor.
  market.updateCandle({ instId: "BTC-USDT", ts: 360_000, low: "80", confirm: true });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "exact-anchor", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 180_001, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true }, recoverAnchorCandle: async (_instId, anchorTs) => { recoveries += 1; assert.equal(anchorTs, 180_000); return { instId: "BTC-USDT", ts: 180_000, low: "100", confirm: true }; } });
  sell.rebuild([fill]);
  assert.equal(sell.observeTicker("BTC-USDT").length, 0, "a newer candle must never substitute for the anchor");
  assert.equal(recoveries, 0, "WS observation never performs REST I/O");
  const events = await sell.recoverDueAnchors();
  assert.equal(recoveries, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "SELL_BREACH");
  assert.equal(events[0].protection, "99.7");
});

test("P3 deduplicates an unpersisted protection checkpoint per fill and floor", () => {
  const now = { nowMs: () => 181_000 }; const market = new MarketProjection({ clock: now });
  market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" });
  market.updateTicker({ instId: "BTC-USDT", ts: 181_000, last: "100", bidPx: "100" });
  market.updateCandle({ instId: "BTC-USDT", ts: 0, low: "95", confirm: true });
  const fill = { account_id: "a", inst_id: "BTC-USDT", base_ccy: "BTC", trade_id: "dedupe-protection", side: "BUY", fill_size: "1", disposed_size: "0", sell_time: 1_000, sell_state: "WAITING", version: 1 };
  const sell = new SellService({ market, clock: now, coordinator: { enqueue: () => true } });
  sell.rebuild([fill]);
  assert.equal(sell.observeTicker("BTC-USDT").filter((event) => event.type === "SELL_PROTECTION").length, 1);
  assert.equal(sell.observeTicker("BTC-USDT").filter((event) => event.type === "SELL_PROTECTION").length, 0, "ticker bursts do not queue duplicate floor writes");
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

  const ready = gate(); let lost;
  const owner = { isHeld: () => true, onLost: (handler) => { lost = handler; } };
  const recovery = new ReconciliationService({ ownerGuard: owner, readyGate: ready, safetyWaitMs: 0, telemetry, transaction: async (fn) => fn({}), state: { listProtection: async () => [], listDaily: async () => [], listManagedFills: async () => [] }, orders: { listNonTerminal: async () => [], listTodayBuys: async () => [], listWatermarks: async () => [] }, transport: {} });
  lost(); assert.equal(ready.ready, false);
  assert.equal((await recovery.recover({ accountId: "slow" })).reason, "BASELINES_REQUIRED");
});
