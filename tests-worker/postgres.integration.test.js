import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { PostgresOwnerGuard } from "../src/infrastructure/postgres/owner-guard.js";
import { OrderRepository, TradingStateRepository } from "../src/infrastructure/postgres/repositories.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";
import { AccountCapitalSnapshot, MarketProjection, ReadyGate } from "../src/application/trading-engine.js";
import { OrderCoordinator } from "../src/application/order-coordinator.js";

const run = promisify(execFile);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startPostgres() {
  const dir = await mkdtemp(join(tmpdir(), "crypto-p1-pg-"));
  const logPath = join(dir, "postgres.log");
  const port = await freePort();
  const clients = new Set();
  let started = false;

  async function connect() {
    const client = new Client({ host: "127.0.0.1", port, user: process.env.USER, database: "postgres" });
    await client.connect();
    clients.add(client);
    return client;
  }

  async function close(client) {
    if (client && clients.delete(client)) await client.end();
  }

  async function stop() {
    for (const client of [...clients]) {
      try { await close(client); } catch { /* continue cluster cleanup */ }
    }
    if (started) {
      try {
        await run("pg_ctl", ["-D", dir, "-m", "immediate", "-w", "stop"]);
      } finally {
        started = false;
      }
    }
    await rm(dir, { recursive: true, force: true });
  }

  try {
    await run("initdb", ["-D", dir, "--no-locale", "-E", "UTF8", "-A", "trust"]);
    await run("pg_ctl", ["-D", dir, "-l", logPath, "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"]);
    started = true;
    let admin = await connect();
    const sql = await readFile(new URL("../migrations/postgres/0001_p1_core.sql", import.meta.url), "utf8");
    await admin.query(sql);
    await admin.query(sql);
    async function restart() {
      for (const client of [...clients]) {
        try { await close(client); } catch { /* cluster is intentionally stopping */ }
      }
      await run("pg_ctl", ["-D", dir, "-m", "immediate", "-w", "stop"]);
      started = false;
      await run("pg_ctl", ["-D", dir, "-l", logPath, "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"]);
      started = true;
      admin = await connect();
    }
    return { get admin() { return admin; }, close, connect, dir, logPath, port, restart, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function tx(client, fn) {
  await client.query("BEGIN");
  try {
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function buy(id, { accountId = "a", instId = "BTC-USDT", baseCcy = "BTC", generation = 0, exposure = "10" } = {}) {
  return {
    accountId, intent: "BUY", instId, baseCcy, clOrdId: id, payloadHash: `hash-${id}`,
    strategyDay: "2026-08-14", generation, plannedSize: "0.1", reservedExposureUsd: exposure,
    frozenTargetUsd: "100", decisionQuoteTs: 1, decisionQuoteHash: "quote-hash",
    decisionCandleTs: 1, decisionCandleHash: "candle-hash", decisionMarketKey: `market-${id}`,
    executionLimitPrice: "100", instrumentVersion: "instrument-v1", holdHours: "24",
    strategyConfigHash: "config-v1", admissionEquity: "100", admissionExposure: "0",
    accountSnapshotVersion: "account-v1",
  };
}

function exitAttempt(id, { accountId = "a", intent = "SELL", instId = "BTC-USDT", baseCcy = "BTC", source = "trade1", generation = 0 } = {}) {
  return {
    accountId, intent, instId, baseCcy, clOrdId: id, payloadHash: `hash-${id}`,
    sourceBuyTradeId: source, generation, plannedSize: "1", reservedBaseSize: "1",
  };
}

const admission = (maxExposure, managedExposure = "0") => ({ managedExposure, maxExposure });

test("temporary PostgreSQL enforces P1-B invariants", { timeout: 60_000 }, async (t) => {
  const db = await startPostgres();
  const orders = new OrderRepository();
  const state = new TradingStateRepository();
  try {
    await t.test("migration is repeatable and forbidden tables/columns are absent", async () => {
      const tables = await db.admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
      const names = new Set(tables.rows.map((row) => row.table_name));
      for (const required of ["daily_limit_cache", "filled_orders", "instrument_protection", "order_attempts", "sync_watermarks"]) assert.equal(names.has(required), true);
      for (const forbidden of ["system_control", "crypto_limits", "buy_cycles", "managed_positions", "sell_groups", "sell_items"]) assert.equal(names.has(forbidden), false);
      const columns = await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('filled_orders','order_attempts')");
      const columnNames = new Set(columns.rows.map((row) => row.column_name));
      for (const forbidden of ["active_attempt_id", "remaining_size", "sell_generation", "breach_latched", "exit_mode", "confirmed_sold_size", "external_disposed_size", "fee", "fee_ccy", "interest", "debt"]) assert.equal(columnNames.has(forbidden), false);
      for (const required of ["reservation_state", "decision_market_key", "failure_fingerprint", "account_snapshot_version"]) assert.equal(columnNames.has(required), true);
    });

    await t.test("two real transactions cannot reuse account exposure", async () => {
      const left = await db.connect();
      const right = await db.connect();
      try {
        const results = await Promise.all([
          tx(left, (client) => orders.reserveBuy(client, buy("concurrent-left", { accountId: "concurrent", instId: "BTC-USDT", baseCcy: "BTC" }), admission("15"))),
          tx(right, (client) => orders.reserveBuy(client, buy("concurrent-right", { accountId: "concurrent", instId: "ETH-USDT", baseCcy: "ETH" }), admission("15"))),
        ]);
        assert.deepEqual(results.map((result) => result.authorized).sort(), [false, true]);
        assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM order_attempts WHERE account_id='concurrent'")).rows[0].count, 1);
      } finally {
        await db.close(left);
        await db.close(right);
      }
    });

    await t.test("numeric admission never converts through JavaScript Number", async () => {
      assert.deepEqual(await tx(db.admin, (client) => orders.reserveBuy(client, buy("precise-one", { accountId: "precise", exposure: "9007199254740993.00000000" }), admission("9007199254740993.00000001"))), { authorized: true });
      assert.deepEqual(await tx(db.admin, (client) => orders.reserveBuy(client, buy("precise-two", { accountId: "precise", instId: "ETH-USDT", baseCcy: "ETH", exposure: "0.00000002" }), admission("9007199254740993.00000001"))), { authorized: false, reason: "EXPOSURE_LIMIT" });
      assert.deepEqual(await tx(db.admin, (client) => orders.reserveBuy(client, buy("managed-exposure", { accountId: "managed", exposure: "10" }), admission("15", "6"))), { authorized: false, reason: "EXPOSURE_LIMIT" });
      assert.deepEqual(await tx(db.admin, (client) => orders.reserveBuy(client, buy("negative-exposure", { accountId: "negative" }), admission("15", "-1"))), { authorized: false, reason: "EXPOSURE_LIMIT" });
    });

    await t.test("attempt, fill, generation and active-exit constraints are durable", async () => {
      await tx(db.admin, (client) => orders.reserveBuy(client, buy("active-buy", { accountId: "unique" }), admission("100")));
      await assert.rejects(tx(db.admin, (client) => orders.reserveBuy(client, buy("active-buy-2", { accountId: "unique", generation: 1 }), admission("100"))), (error) => error.code === "23505");
      await db.admin.query("UPDATE order_attempts SET state='SETTLED',reservation_state='RELEASED' WHERE cl_ord_id='active-buy'");
      await assert.rejects(tx(db.admin, (client) => orders.reserveBuy(client, buy("same-generation", { accountId: "unique" }), admission("100"))), (error) => error.code === "23505");

      await tx(db.admin, (client) => orders.reserveExit(client, exitAttempt("sell-one", { accountId: "exit" })));
      await assert.rejects(tx(db.admin, (client) => orders.reserveExit(client, exitAttempt("delist-overlap", { accountId: "exit", intent: "DELIST", source: "trade2" }))), (error) => error.code === "23505");

      const fill = { accountId: "a", instId: "BTC-USDT", baseCcy: "BTC", tradeId: "t1", source: "SYSTEM", side: "BUY", fillSize: "2", fillTime: 1, holdHours: "24", strategyConfigHash: "cfg", sellTime: 2, sellState: "WAITING" };
      assert.equal((await tx(db.admin, (client) => state.insertFill(client, fill))).rowCount, 1);
      assert.equal((await tx(db.admin, (client) => state.insertFill(client, fill))).rowCount, 0);
      const row = (await db.admin.query("SELECT id,version FROM filled_orders WHERE trade_id='t1'")).rows[0];
      assert.equal((await tx(db.admin, (client) => state.compareAndSetFill(client, row.id, row.version, "1"))).rowCount, 1);
      assert.equal((await tx(db.admin, (client) => state.compareAndSetFill(client, row.id, row.version, "1.5"))).rowCount, 0);
      const currentVersion = (BigInt(row.version) + 1n).toString();
      await assert.rejects(tx(db.admin, (client) => state.compareAndSetFill(client, row.id, currentVersion, "3")), (error) => error.code === "23514");
    });

    await t.test("attempt and reservation roll back together", async () => {
      await assert.rejects(tx(db.admin, async (client) => {
        await orders.reserveBuy(client, buy("rollback-buy", { accountId: "rollback" }), admission("100"));
        throw new Error("force rollback");
      }), /force rollback/);
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM order_attempts WHERE cl_ord_id='rollback-buy'")).rows[0].count, 0);
    });

    await t.test("owner acquire is idempotent and connection loss releases the lock", async () => {
      const firstClient = await db.connect();
      const secondClient = await db.connect();
      const first = new PostgresOwnerGuard(firstClient, "p1-owner-test");
      const second = new PostgresOwnerGuard(secondClient, "p1-owner-test");
      try {
        assert.equal(await first.acquire(), true);
        assert.equal(await first.acquire(), true);
        assert.equal(await second.acquire(), false);
        await first.release();
        assert.equal(await second.acquire(), true, "one release must clear an idempotent acquire");
        await db.close(secondClient);
        assert.equal(second.isHeld(), false);
        const thirdClient = await db.connect();
        const third = new PostgresOwnerGuard(thirdClient, "p1-owner-test");
        try {
          assert.equal(await third.acquire(), true, "connection termination must release the session lock");
          await third.release();
        } finally {
          await db.close(thirdClient);
        }
      } finally {
        await first.release();
        await db.close(firstClient);
        await db.close(secondClient);
      }
    });

    await t.test("database unavailability rejects reservation before authorization", async () => {
      const dead = await db.connect();
      await db.close(dead);
      await assert.rejects(tx(dead, (client) => orders.reserveBuy(client, buy("dead-db", { accountId: "dead" }), admission("100"))));
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM order_attempts WHERE cl_ord_id='dead-db'")).rows[0].count, 0);
    });

    await t.test("P2 coordinator transitions preserve reservation semantics in a real transaction", async () => {
      await tx(db.admin, async (client) => {
        await orders.reserveBuy(client, buy("p2-submit", { accountId: "p2", exposure: "10" }), admission("100"));
        await orders.markSubmitted(client, "p2-submit", "okx-1");
        await state.insertFill(client, { accountId: "p2", instId: "BTC-USDT", baseCcy: "BTC", tradeId: "p2-fill", source: "SYSTEM", side: "BUY", fillSize: "0.1", fillTime: 10, holdHours: "24", strategyConfigHash: "cfg", sellTime: 11, sellState: "WAITING" });
        await orders.markSettled(client, "p2-submit", "filled", "CONVERTED");
      });
      const settled = (await db.admin.query("SELECT state,reservation_state,ord_id FROM order_attempts WHERE cl_ord_id='p2-submit'")).rows[0];
      assert.deepEqual(settled, { state: "SETTLED", reservation_state: "CONVERTED", ord_id: "okx-1" });
      await tx(db.admin, async (client) => {
        await orders.reserveBuy(client, buy("p2-not-created", { accountId: "p2", instId: "ETH-USDT", baseCcy: "ETH", generation: 0 }), admission("100"));
        await orders.markNotCreated(client, "p2-not-created", "OWNER_NOT_HELD");
      });
      const released = (await db.admin.query("SELECT state,reservation_state FROM order_attempts WHERE cl_ord_id='p2-not-created'")).rows[0];
      assert.deepEqual(released, { state: "NOT_CREATED", reservation_state: "RELEASED" });
    });

    await t.test("P2 real PostgreSQL survives commit-ack-loss and SETTLED replay without duplicate exposure", async () => {
      await tx(db.admin, (client) => orders.reserveBuy(client, buy("ack-prepared", { accountId: "ack", exposure: "10" }), admission("100")));
      // The first caller has no COMMIT acknowledgement. A retry sees the durable business key,
      // rather than manufacturing another attempt/generation.
      await assert.rejects(tx(db.admin, (client) => orders.reserveBuy(client, buy("ack-prepared", { accountId: "ack", exposure: "10" }), admission("100"))), (error) => error.code === "23505");
      const prepared = await tx(db.admin, (client) => orders.findByClOrdId(client, "ack-prepared"));
      assert.equal(prepared.state, "PREPARED"); assert.equal(prepared.generation, 0);
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM order_attempts WHERE account_id='ack'")).rows[0].count, 1);

      await tx(db.admin, async (client) => {
        await orders.markSubmitted(client, "ack-prepared", "ord-ack");
        await state.insertFill(client, { accountId: "ack", instId: "BTC-USDT", baseCcy: "BTC", tradeId: "ack-trade", source: "SYSTEM", side: "BUY", fillSize: "0.1", fillTime: 1, holdHours: "24", strategyConfigHash: "cfg", sellTime: 2, sellState: "WAITING" });
        await orders.markSettled(client, "ack-prepared", "filled", "CONVERTED");
      });
      // A lost acknowledgement of the complete settlement transaction may be replayed safely.
      await tx(db.admin, async (client) => {
        await state.insertFill(client, { accountId: "ack", instId: "BTC-USDT", baseCcy: "BTC", tradeId: "ack-trade", source: "SYSTEM", side: "BUY", fillSize: "0.1", fillTime: 1, holdHours: "24", strategyConfigHash: "cfg", sellTime: 2, sellState: "WAITING" });
        await orders.markSettled(client, "ack-prepared", "filled", "CONVERTED");
      });
      assert.deepEqual((await db.admin.query("SELECT state,reservation_state FROM order_attempts WHERE cl_ord_id='ack-prepared'")).rows[0], { state: "SETTLED", reservation_state: "CONVERTED" });
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM filled_orders WHERE account_id='ack' AND trade_id='ack-trade'")).rows[0].count, 1);
    });

    await t.test("P2 fifty concurrent reservations use the real account transaction advisory lock and stay within 2.95", async () => {
      const clients = await Promise.all(Array.from({ length: 50 }, () => db.connect()));
      try {
        const results = await Promise.all(clients.map((client, index) => tx(client, (txClient) => orders.reserveBuy(txClient, buy(`fifty-${index}`, {
          accountId: "fifty", instId: `C${String(index).padStart(2, "0")}-USDT`, baseCcy: `C${index}`, exposure: "15",
        }), admission("442.5")))));
        const authorized = results.filter((result) => result.authorized).length;
        assert.equal(authorized, 29, "each ACTIVE reservation includes its fee-inflated exposure and must stop before 2.95x");
        const active = (await db.admin.query("SELECT COALESCE(sum(reserved_exposure_usd),0)::text AS exposure FROM order_attempts WHERE account_id='fifty' AND reservation_state='ACTIVE'" )).rows[0].exposure;
        assert.equal(active, "435"); assert.ok(Number(active) <= 442.5);
      } finally {
        await Promise.all(clients.map((client) => db.close(client)));
      }
    });

    await t.test("P2 database restart drops READY, then a new session reacquires before recovery safety wait", async () => {
      const ownerClient = await db.connect(); const owner = new PostgresOwnerGuard(ownerClient, "p2-restart-owner");
      const gate = new ReadyGate(); for (const key of gate.required) gate.set(key, true);
      let waited = 0;
      const recovery = new ReconciliationService({ ownerGuard: owner, readyGate: gate, safetyWaitMs: 7, sleep: async (ms) => { waited += ms; }, state: {}, orders: {}, transport: {} });
      assert.equal(await owner.acquire(), true); assert.equal(gate.ready, true);
      await db.restart();
      assert.equal(owner.isHeld(), false); assert.equal(gate.ready, false, "lost session advisory lock fails READY closed immediately");
      const replacementClient = await db.connect(); const replacement = new PostgresOwnerGuard(replacementClient, "p2-restart-owner");
      const replacementGate = new ReadyGate();
      const replacementRecovery = new ReconciliationService({ ownerGuard: replacement, readyGate: replacementGate, safetyWaitMs: 7, sleep: async (ms) => { waited += ms; }, state: { listProtection: async () => [], listDaily: async () => [], listManagedFills: async () => [] }, orders: { listNonTerminal: async () => [], listTodayBuys: async () => [], listWatermarks: async () => [] }, transport: {} });
      assert.equal(await replacement.acquire(), true);
      assert.equal((await replacementRecovery.recover({ accountId: "restart" })).reason, "BASELINES_REQUIRED");
      assert.equal(waited, 7); assert.equal(replacementGate.ready, false, "old READY is never reused after restart");
      await replacement.release(); await db.close(replacementClient);
    });

    await t.test("P2 real repository pagination commits fills and watermarks only after every SPOT/MARGIN page succeeds", async () => {
      await tx(db.admin, async (client) => {
        await orders.reserveBuy(client, buy("page-unknown", { accountId: "pages", exposure: "10" }), admission("100"));
        await orders.markUnknown(client, "page-unknown", "timeout");
      });
      let fail = true;
      const pages = (name) => async (instType, params = {}) => {
        if (fail && name === "history" && instType === "MARGIN") throw new Error("injected page failure");
        if (params.after) return { data: [] };
        return { data: [
          { instType, instId: "BTC-USDT", side: "buy", tradeId: `${instType}-${name}-2`, ordId: "manual", fillTime: "20", billId: "2", fillSz: "1" },
          { instType, instId: "BTC-USDT", side: "buy", tradeId: `${instType}-${name}-1`, ordId: "manual", fillTime: "10", billId: "1", fillSz: "1" },
        ], next: "next" };
      };
      const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0,
        ownership: { accountId: "pages", managedAfter: 0, enabledInstIds: ["BTC-USDT"], holdHoursByInst: { "BTC-USDT": "24" }, configHash: "page-cfg" },
        transaction: (fn) => tx(db.admin, fn), state, orders,
        transport: { fills: pages("fills"), fillsHistory: pages("history"), order: async () => ({ tdMode: "cross", clOrdId: "manual", tag: "external" }), ordersPending: async () => [], ordersHistory: async () => [], ordersHistoryArchive: async () => [] },
      });
      await assert.rejects(service.recoverFills({ accountId: "pages", overlapBegin: 5 }), /injected page failure/);
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM sync_watermarks WHERE account_id='pages'")).rows[0].count, 0);
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM filled_orders WHERE account_id='pages'")).rows[0].count, 0);
      fail = false;
      const retained = await service.reconcileAttempt({ state: "UNKNOWN", inst_id: "BTC-USDT", cl_ord_id: "page-unknown", ord_id: null });
      assert.equal(retained.outcome, "RETAIN_UNKNOWN");
      assert.deepEqual((await db.admin.query("SELECT state,reservation_state FROM order_attempts WHERE cl_ord_id='page-unknown'")).rows[0], { state: "UNKNOWN", reservation_state: "ACTIVE" });
      await service.recoverFills({ accountId: "pages", overlapBegin: 5 });
      await service.recoverFills({ accountId: "pages", overlapBegin: 5 });
      const stored = (await db.admin.query("SELECT trade_id,fill_time FROM filled_orders WHERE account_id='pages' ORDER BY fill_time,trade_id")).rows;
      assert.equal(stored.length, 8, "replay de-duplicates every (instId, tradeId)");
      assert.deepEqual(stored.slice(0, 2).map((row) => row.fill_time), ["10", "10"]);
      const watermark = (await db.admin.query("SELECT inst_type,watermark,healthy FROM sync_watermarks WHERE account_id='pages' ORDER BY inst_type")).rows;
      assert.deepEqual(watermark, [{ inst_type: "MARGIN", watermark: "20", healthy: true }, { inst_type: "SPOT", watermark: "20", healthy: true }]);
    });

    await t.test("P2 real coordinator drains fifty candidates in immediate five-order batches with fee-inclusive aggregate reservations", async () => {
      const now = { nowMs: () => 10 }; const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now });
      account.update({ ts: 1, totalEq: "150", adjEq: "150", mgnRatio: "2" });
      const gate = new ReadyGate(); for (const key of gate.required) gate.set(key, true);
      for (let index = 1; index <= 50; index += 1) {
        const instId = `C${String(index).padStart(2, "0")}-USDT`; const base = `C${String(index).padStart(2, "0")}`;
        market.updateInstrument({ instId, ts: 1, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", base, version: 1 });
        market.updateTicker({ instId, ts: 2, last: "95", askPx: "95", bidPx: "94" }); market.updateCandle({ instId, ts: 1, open: "90", low: "89", confirm: true });
      }
      const batches = []; let batchNo = 0;
      const coordinator = new OrderCoordinator({ transaction: (fn) => tx(db.admin, fn), orders, state, market, account, readyGate: gate, ownerGuard: { isHeld: () => true }, mode: () => "FULL", clock: now,
        config: { accountId: "coord50", orderVersion: "P2", strategyTag: "STRAT", orderExpiryMs: 1_000, quoteFreshMs: 100, accountFreshMs: 100 },
        transport: {
          maxAvailSize: async (ids) => ids.split(",").map((instId) => ({ instId, availBuy: "5" })),
          submitBatchOrders: async (payload) => { batches.push(payload); batchNo += 1; return payload.map((item, index) => batchNo === 1 && index === 0 ? { clOrdId: item.clOrdId, status: "UNKNOWN", reason: "timeout" } : batchNo === 2 && index === 0 ? { clOrdId: item.clOrdId, status: "NOT_CREATED", reason: "rejected" } : { clOrdId: item.clOrdId, status: "SUBMITTED", ordId: `o-${item.clOrdId}` }); },
        },
      });
      for (let index = 1; index <= 50; index += 1) coordinator.enqueue({ intent: "BUY", instId: `C${String(index).padStart(2, "0")}-USDT`, generation: 0, eligibleSince: index, strategyDay: "2026-08-14", dailyLimitPrice: "100", holdHours: "24", configHash: "cfg", managedExposure: "0" });
      for (let batch = 0; batch < 10; batch += 1) assert.equal((await coordinator.drainOnce()).count, 5);
      assert.equal(batches.length, 10); assert.deepEqual(batches[0].map((row) => row.instId), ["C01-USDT", "C02-USDT", "C03-USDT", "C04-USDT", "C05-USDT"]);
      assert.ok(batches.every((batch) => batch.length >= 1 && batch.length <= 5));
      const states = await db.admin.query("SELECT state,reservation_state,count(*)::int AS count FROM order_attempts WHERE account_id='coord50' GROUP BY state,reservation_state ORDER BY state");
      assert.deepEqual(states.rows, [{ state: "NOT_CREATED", reservation_state: "RELEASED", count: 1 }, { state: "SUBMITTED", reservation_state: "ACTIVE", count: 48 }, { state: "UNKNOWN", reservation_state: "ACTIVE", count: 1 }]);
      const total = (await db.admin.query("SELECT sum(reserved_exposure_usd)::text AS exposure FROM order_attempts WHERE account_id='coord50' AND reservation_state='ACTIVE'")).rows[0].exposure;
      assert.ok(Number(total) <= 442.5, `fee-inclusive ACTIVE reservation ${total} must remain under 2.95x`);
      const unknown = (await db.admin.query("SELECT * FROM order_attempts WHERE account_id='coord50' AND state='UNKNOWN'")).rows[0];
      await coordinator.settleBuy({ attempt: unknown, fills: [{ tradeId: "coord50-partial", fillSz: "0.01", fillTime: "30" }], exchangeState: "canceled", accFillSz: "0.01" });
      assert.deepEqual((await db.admin.query("SELECT state,reservation_state FROM order_attempts WHERE id=$1", [unknown.id])).rows[0], { state: "SETTLED", reservation_state: "CONVERTED" });
    });
  } finally {
    await db.stop();
  }
});
