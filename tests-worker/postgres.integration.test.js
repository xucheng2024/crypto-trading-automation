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
import { DelistOrchestrator } from "../src/application/delist-orchestrator.js";
import { InstrumentProtectionService } from "../src/application/instrument-protection-service.js";
import { P3_DELETE_TERMINAL_ATTEMPTS_SQL, P3_RETENTION_VERSION, retainTerminalAttempts, retainTerminalAttemptsAsMaintenance } from "../src/infrastructure/postgres/retention.js";
import { importOfflineProtection } from "../src/infrastructure/postgres/offline-import.js";
import { convertD1Export } from "../tools/convert-d1-export.mjs";

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
    const migrations = ["0001_p1_core.sql", "0002_p3_exit.sql", "0003_p4_import.sql", "0004_hybrid_execution.sql"];
    for (const migration of migrations) {
      const sql = await readFile(new URL(`../migrations/postgres/${migration}`, import.meta.url), "utf8");
      await admin.query(sql); await admin.query(sql);
    }
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

function buy(id, { accountId = "a", instId = "BTC-USDT", baseCcy = "BTC", generation = 0, exposure = "10", executionMode = "cross" } = {}) {
  return {
    accountId, intent: "BUY", instId, baseCcy, clOrdId: id, payloadHash: `hash-${id}`,
    strategyDay: "2026-08-14", generation, plannedSize: "0.1", reservedExposureUsd: exposure,
    frozenTargetUsd: "100", decisionQuoteTs: 1, decisionQuoteHash: "quote-hash",
    decisionCandleTs: 1, decisionCandleHash: "candle-hash", decisionMarketKey: `market-${id}`,
    executionLimitPrice: "100", instrumentVersion: "instrument-v1", holdHours: "24",
    strategyConfigHash: "config-v1", admissionEquity: "100", admissionExposure: "0",
    accountSnapshotVersion: "account-v1", executionMode,
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
      assert.equal(tables.rows.some((row) => row.table_name === "deployment_config"), false);
      const names = new Set(tables.rows.map((row) => row.table_name));
      for (const required of ["daily_limit_cache", "filled_orders", "instrument_protection", "order_attempts", "sync_watermarks"]) assert.equal(names.has(required), true);
      for (const forbidden of ["system_control", "crypto_limits", "buy_cycles", "managed_positions", "sell_groups", "sell_items"]) assert.equal(names.has(forbidden), false);
      const columns = await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('filled_orders','order_attempts')");
      const columnNames = new Set(columns.rows.map((row) => row.column_name));
      for (const forbidden of ["active_attempt_id", "remaining_size", "sell_generation", "breach_latched", "exit_mode", "confirmed_sold_size", "external_disposed_size", "fee", "fee_ccy", "interest", "debt"]) assert.equal(columnNames.has(forbidden), false);
      for (const required of ["reservation_state", "decision_market_key", "failure_fingerprint", "account_snapshot_version", "execution_mode"]) assert.equal(columnNames.has(required), true);
      await tx(db.admin, (client) => orders.reserveBuy(client, buy("cash-mode", { accountId: "mode", executionMode: "cash" }), admission("100")));
      await tx(db.admin, (client) => state.insertFill(client, { accountId: "mode", instId: "BTC-USDT", baseCcy: "BTC", tradeId: "cash-fill", source: "SYSTEM", side: "BUY", fillSize: "1", fillTime: 1, holdHours: "24", strategyConfigHash: "cfg", sellTime: 2, sellState: "WAITING", executionMode: "cash" }));
      assert.equal((await db.admin.query("SELECT execution_mode FROM order_attempts WHERE cl_ord_id='cash-mode'")).rows[0].execution_mode, "cash");
      assert.equal((await db.admin.query("SELECT execution_mode FROM filled_orders WHERE trade_id='cash-fill'")).rows[0].execution_mode, "cash");
      await assert.rejects(db.admin.query("UPDATE filled_orders SET execution_mode='isolated' WHERE trade_id='cash-fill'"), (error) => error.code === "23514");
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

    await t.test("cash then margin and margin then cash share the same 2.95 exposure ceiling", async () => {
      const cases = [
        { accountId: "cash-first", first: "cash", second: "cross" },
        { accountId: "cross-first", first: "cross", second: "cash" },
      ];
      for (const row of cases) {
        assert.equal((await tx(db.admin, (client) => orders.reserveBuy(client, buy(`${row.accountId}-one`, { accountId: row.accountId, instId: "BTC-USDT", baseCcy: "BTC", exposure: "100", executionMode: row.first }), admission("295")))).authorized, true);
        assert.equal((await tx(db.admin, (client) => orders.reserveBuy(client, buy(`${row.accountId}-two`, { accountId: row.accountId, instId: "ETH-USDT", baseCcy: "ETH", exposure: "195", executionMode: row.second }), admission("295")))).authorized, true);
        assert.deepEqual(await tx(db.admin, (client) => orders.reserveBuy(client, buy(`${row.accountId}-three`, { accountId: row.accountId, instId: "SOL-USDT", baseCcy: "SOL", exposure: "0.01", executionMode: "cash" }), admission("295"))), { authorized: false, reason: "EXPOSURE_LIMIT" });
        const modes = (await db.admin.query("SELECT execution_mode FROM order_attempts WHERE account_id=$1 ORDER BY id", [row.accountId])).rows.map((item) => item.execution_mode);
        assert.deepEqual(modes, [row.first, row.second]);
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

      await tx(db.admin, (client) => state.insertFill(client, { accountId: "exit", instId: "BTC-USDT", baseCcy: "BTC", tradeId: "trade1", source: "SYSTEM", side: "BUY", fillSize: "2", fillTime: 1, holdHours: "24", strategyConfigHash: "cfg", sellTime: 2, sellState: "WAITING" }));
      await tx(db.admin, (client) => orders.reserveExit(client, exitAttempt("sell-one", { accountId: "exit" })));
      await assert.rejects(tx(db.admin, (client) => orders.reserveExit(client, exitAttempt("delist-overlap", { accountId: "exit", intent: "DELIST", source: "trade1" }))), (error) => error.code === "23505");

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

    await t.test("P3 account SELL allocation uses bigint bill keys and SYSTEM SELL replay is idempotent", async () => {
      const accountId = "p3-ledger"; const baseCcy = "BTC"; const instId = "BTC-USDT";
      const buy = (tradeId, billId, size) => state.insertFill(db.admin, { accountId, instId, baseCcy, tradeId, billId, source: "ACCOUNT", side: "BUY", fillSize: size, fillTime: 100, holdHours: "24", strategyConfigHash: "cfg", sellTime: 101, sellState: "WAITING" });
      await buy("p3-buy-1", "9223372036854775807123", "1"); await buy("p3-buy-2", "9223372036854775807124", "1");
      await state.insertFill(db.admin, { accountId, instId, baseCcy, tradeId: "p3-sell-1", billId: "9223372036854775807125", source: "ACCOUNT", side: "SELL", fillSize: "1.5", fillTime: 100, allocationState: "PENDING" });
      const allocation = await tx(db.admin, (client) => state.allocatePendingAccountSells(client, { accountId, baseCcy, watermark: 100 }));
      assert.deepEqual(allocation, { allocated: 1 });
      assert.deepEqual((await db.admin.query("SELECT trade_id,disposed_size,sell_state FROM filled_orders WHERE account_id=$1 AND side='BUY' ORDER BY bill_id::numeric", [accountId])).rows, [{ trade_id: "p3-buy-1", disposed_size: "1", sell_state: "SOLD" }, { trade_id: "p3-buy-2", disposed_size: "0.5", sell_state: "SELL_TRIGGERED" }]);
      await state.insertFill(db.admin, { accountId, instId, baseCcy, tradeId: "p3-invalid", source: "ACCOUNT", side: "SELL", fillSize: "0.1", fillTime: 101, allocationState: "PENDING" });
      assert.deepEqual(await tx(db.admin, (client) => state.allocatePendingAccountSells(client, { accountId, baseCcy, watermark: 101 })), { allocated: 0, reason: "INVALID_BILL_ID" });
      assert.equal((await db.admin.query("SELECT allocation_state FROM filled_orders WHERE trade_id='p3-invalid'")).rows[0].allocation_state, "PENDING");
      await tx(db.admin, (client) => state.recordSystemSell(client, { accountId, instId, baseCcy, sourceBuyTradeId: "p3-buy-2", tradeId: "p3-system-sell", fillSize: "0.25", fillTime: 102 }));
      assert.deepEqual(await tx(db.admin, (client) => state.recordSystemSell(client, { accountId, instId, baseCcy, sourceBuyTradeId: "p3-buy-2", tradeId: "p3-system-sell", fillSize: "0.25", fillTime: 102 })), { applied: false, reason: "DUPLICATE_TRADE" });
      assert.equal((await db.admin.query("SELECT disposed_size FROM filled_orders WHERE trade_id='p3-buy-2'")).rows[0].disposed_size, "0.75");
    });

    await t.test("P3 fixed retention only removes aged terminal attempts and preserves live ledger evidence", async () => {
      assert.equal(P3_RETENTION_VERSION, "p3-retention-v1"); assert.match(P3_DELETE_TERMINAL_ATTEMPTS_SQL, /state IN \('NOT_CREATED','SETTLED'\)/);
      await tx(db.admin, async (client) => {
        await orders.reserveBuy(client, buy("retain-terminal", { accountId: "retention" }), admission("100"));
        await orders.markSubmitted(client, "retain-terminal", "retained-order"); await orders.markSettled(client, "retain-terminal", "filled", "CONVERTED");
        await orders.reserveBuy(client, buy("retain-active", { accountId: "retention", instId: "ETH-USDT", baseCcy: "ETH" }), admission("100"));
        await state.insertFill(client, { accountId: "retention", instId: "BTC-USDT", baseCcy: "BTC", tradeId: "retain-account-sell", billId: "9", source: "ACCOUNT", side: "SELL", fillSize: "1", fillTime: 1, allocationState: "PENDING" });
        await state.claimAnnouncement(client, { title: "Spot delisting BTC", pTime: 1 });
        await orders.upsertWatermark(client, { accountId: "retention", instType: "SPOT", endpoint: "fills", watermark: 1, overlapBegin: 0, healthy: true });
      });
      await db.admin.query("UPDATE order_attempts SET updated_at='2000-01-01' WHERE cl_ord_id='retain-terminal'");
      await tx(db.admin, (client) => retainTerminalAttempts(client, { before: new Date("2020-01-01T00:00:00Z"), limit: 10 }));
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM order_attempts WHERE cl_ord_id='retain-terminal'")).rows[0].count, 0);
      assert.equal((await db.admin.query("SELECT state FROM order_attempts WHERE cl_ord_id='retain-active'")).rows[0].state, "PREPARED");
      assert.equal((await db.admin.query("SELECT allocation_state FROM filled_orders WHERE trade_id='retain-account-sell'")).rows[0].allocation_state, "PENDING");
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM announcement_receipts WHERE title='Spot delisting BTC'")).rows[0].count, 1);
      assert.equal((await db.admin.query("SELECT watermark FROM sync_watermarks WHERE account_id='retention'")).rows[0].watermark, "1");
    });
    await t.test("P4 maintenance role can execute only the bounded SECURITY DEFINER retention port", async () => {
      await db.admin.query("CREATE ROLE p4_maintenance_test NOLOGIN");
      await db.admin.query("GRANT USAGE ON SCHEMA public TO p4_maintenance_test");
      await db.admin.query("GRANT EXECUTE ON FUNCTION p4_retain_terminal_attempts(timestamptz, integer) TO p4_maintenance_test");
      await orders.reserveBuy(db.admin, buy("p4-maintenance-terminal", { accountId: "p4-maintenance" }), admission("100"));
      await orders.markNotCreated(db.admin, "p4-maintenance-terminal", "fixture");
      await db.admin.query("UPDATE order_attempts SET updated_at='2019-01-01' WHERE cl_ord_id='p4-maintenance-terminal'");
      await db.admin.query("SET ROLE p4_maintenance_test");
      try {
        const removed = await retainTerminalAttemptsAsMaintenance(db.admin, { before: new Date("2020-01-01T00:00:00Z"), limit: 10 });
        assert.equal(removed.rowCount, 1);
        await assert.rejects(db.admin.query("INSERT INTO order_attempts(account_id,intent,inst_id,cl_ord_id,payload_hash,state,reservation_state) VALUES('x','BUY','X-USDT','forbidden','hash','PREPARED','ACTIVE')"), /permission denied/);
      } finally { await db.admin.query("RESET ROLE"); }
    });

    await t.test("P3 partial exit settles once then creates exactly one next generation from durable remaining", async () => {
      const accountId = "p3-partial";
      await tx(db.admin, async (client) => {
        await state.insertFill(client, { accountId, instId: "BTC-USDT", baseCcy: "BTC", tradeId: "p3-partial-buy", billId: "1", source: "SYSTEM", side: "BUY", fillSize: "2", fillTime: 1, holdHours: "24", strategyConfigHash: "cfg", sellTime: 2, sellState: "SELL_TRIGGERED" });
        await orders.reserveExit(client, exitAttempt("p3-partial-exit", { accountId, source: "p3-partial-buy" })); await orders.markSubmitted(client, "p3-partial-exit", "order-1");
      });
      const attempt = await tx(db.admin, (client) => orders.findByClOrdId(client, "p3-partial-exit"));
      const coordinator = new OrderCoordinator({ transaction: (fn) => tx(db.admin, fn), orders, state, market: { ticker: () => ({ last: "10" }) }, account: {}, readyGate: {}, ownerGuard: {}, config: {}, transport: {} });
      const result = await coordinator.settleExit({ attempt, fills: [{ tradeId: "p3-partial-sell", fillSz: "1", fillTime: "3" }], exchangeState: "canceled", accFillSz: "1" });
      assert.deepEqual(result, { settled: true, remaining: "1" });
      assert.equal(coordinator.pending.SELL.size, 1);
      assert.equal([...coordinator.pending.SELL.values()][0].generation, 1);
      await coordinator.settleExit({ attempt, fills: [{ tradeId: "p3-partial-sell", fillSz: "1", fillTime: "3" }], exchangeState: "canceled", accFillSz: "1" });
      assert.equal(coordinator.pending.SELL.size, 1, "lost settlement acknowledgement cannot enqueue another replacement");
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM filled_orders WHERE trade_id='p3-partial-sell'")).rows[0].count, 1);
      assert.deepEqual((await db.admin.query("SELECT disposed_size,sell_state FROM filled_orders WHERE trade_id='p3-partial-buy'")).rows[0], { disposed_size: "1", sell_state: "SELL_TRIGGERED" });
      assert.deepEqual((await db.admin.query("SELECT state,reservation_state FROM order_attempts WHERE cl_ord_id='p3-partial-exit'")).rows[0], { state: "SETTLED", reservation_state: "RELEASED" });
    });

    await t.test("P3 account SELL releases only PREPARED exits and waits for the smaller SPOT/MARGIN fence", async () => {
      const accountId = "p3-manual"; const telemetry = [];
      await tx(db.admin, async (client) => {
        await state.insertFill(client, { accountId, instId: "BTC-USDT", baseCcy: "BTC", tradeId: "p3-manual-buy", billId: "1", source: "SYSTEM", side: "BUY", fillSize: "1", fillTime: 70, holdHours: "24", strategyConfigHash: "cfg", sellTime: 71, sellState: "SELL_TRIGGERED" });
        await orders.reserveExit(client, exitAttempt("p3-manual-prepared", { accountId, source: "p3-manual-buy" }));
        await orders.upsertWatermark(client, { accountId, instType: "SPOT", endpoint: "fills", watermark: 50, overlapBegin: 0, healthy: true });
        await orders.upsertWatermark(client, { accountId, instType: "MARGIN", endpoint: "fills", watermark: 100, overlapBegin: 0, healthy: true });
      });
      const service = new ReconciliationService({ ownerGuard: { isHeld: () => true }, readyGate: new ReadyGate(), safetyWaitMs: 0, transaction: (fn) => tx(db.admin, fn), state, orders, telemetry: (event) => telemetry.push(event),
        ownership: { accountId, managedAfter: 0, enabledInstIds: ["BTC-USDT"] }, transport: {} });
      await tx(db.admin, (client) => service.ingestFill(client, { instType: "SPOT", instId: "BTC-USDT", side: "sell", tradeId: "p3-manual-sell", billId: "2", fillTime: 80, fillSz: "1" }, { tdMode: "cross", clOrdId: "manual" }));
      assert.deepEqual((await db.admin.query("SELECT state,reservation_state FROM order_attempts WHERE cl_ord_id='p3-manual-prepared'")).rows[0], { state: "NOT_CREATED", reservation_state: "RELEASED" });
      assert.deepEqual(await service.allocateSafeAccountSells({ accountId, baseCcy: "BTC" }), { allocated: 0 });
      assert.equal((await db.admin.query("SELECT allocation_state FROM filled_orders WHERE trade_id='p3-manual-sell'")).rows[0].allocation_state, "PENDING");
      await tx(db.admin, (client) => orders.upsertWatermark(client, { accountId, instType: "SPOT", endpoint: "fills", watermark: 90, overlapBegin: 0, healthy: true }));
      assert.deepEqual(await service.allocateSafeAccountSells({ accountId, baseCcy: "BTC" }), { allocated: 1 });
      assert.equal((await db.admin.query("SELECT disposed_size FROM filled_orders WHERE trade_id='p3-manual-buy'")).rows[0].disposed_size, "1");
      assert.equal(telemetry.some((event) => event.reason === "PREPARED_EXIT_NOT_CREATED"), true);
    });

    await t.test("P3 unified PG protection orchestrator queues one durable fill-level DELIST without shared-base excess", async () => {
      const accountId = "p3-orchestrator"; const now = { nowMs: () => 100 }; const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now }); const ready = new ReadyGate();
      for (const key of ready.required) ready.set(key, true); account.update({ ts: 100, totalEq: "10", adjEq: "10" });
      market.updateInstrument({ instId: "BTC-USDT", ts: 1, state: "live", tickSz: "0.1", lotSz: "0.1", minSz: "0.1", base: "BTC" }); market.updateTicker({ instId: "BTC-USDT", ts: 100, last: "10", bidPx: "10" });
      await tx(db.admin, async (client) => {
        await state.upsertProtection(client, { instId: "BTC-USDT", baseCcy: "BTC", state: "EXITING", reason: "test" });
        for (const [tradeId, fillTime] of [["orch-first", 1], ["orch-second", 2]]) await state.insertFill(client, { accountId, instId: "BTC-USDT", baseCcy: "BTC", tradeId, billId: String(fillTime), source: "SYSTEM", side: "BUY", fillSize: "1", fillTime, holdHours: "24", strategyConfigHash: "cfg", sellTime: 0, sellState: "WAITING" });
      });
      const coordinator = new OrderCoordinator({ transaction: (fn) => tx(db.admin, fn), orders, state, market, account, readyGate: ready, ownerGuard: { isHeld: () => true }, mode: () => "EXIT_ONLY", config: { accountId, orderVersion: "p3", strategyTag: "P3", orderExpiryMs: 1000, accountFreshMs: 1000, quoteFreshMs: 1000 }, clock: now, transport: { maxAvailSize: async () => [{ instId: "BTC-USDT", availSell: "1" }], submitBatchOrders: async (rows) => rows.map((row) => ({ clOrdId: row.clOrdId, status: "SUBMITTED", ordId: "o" })) } });
      const orchestrator = new DelistOrchestrator({ transaction: (fn) => tx(db.admin, fn), state, orders, coordinator, accountId, market, availableBase: (row) => row.remaining_size });
      assert.equal(await orchestrator.drive("BTC-USDT"), "EXITING"); assert.equal((await coordinator.drainOnce()).count, 1);
      const attempts = (await db.admin.query("SELECT source_buy_trade_id,intent,state,reserved_base_size FROM order_attempts WHERE account_id=$1", [accountId])).rows;
      assert.deepEqual(attempts, [{ source_buy_trade_id: "orch-first", intent: "DELIST", state: "SUBMITTED", reserved_base_size: "1" }]);
    });

    await t.test("P3 unified fake OKX and one PostgreSQL ledger survive DELIST partial UNKNOWN restart and converge", async () => {
      const accountId = "p3-unified"; const instId = "UNI-USDT"; const baseCcy = "UNI";
      const now = { nowMs: () => 1_000 }; const market = new MarketProjection({ clock: now }); const account = new AccountCapitalSnapshot({ clock: now });
      market.updateInstrument({ instId, ts: 1, state: "live", tickSz: "0.01", lotSz: "0.01", minSz: "0.1", base: baseCcy });
      market.updateTicker({ instId, ts: 2, last: "10", bidPx: "10", askPx: "10" }); account.update({ ts: 2, totalEq: "100", adjEq: "100" });
      await tx(db.admin, async (client) => {
        for (const row of [
          ["unified-full", "1", "1", "WAITING"], ["unified-partial", "2", "2", "SELL_TRIGGERED"],
          ["unified-unknown", "1", "3", "SELL_TRIGGERED"], ["unified-dust", "0.05", "4", "DUST_PENDING"],
        ]) await state.insertFill(client, { accountId, instId, baseCcy, tradeId: row[0], billId: row[2], source: "SYSTEM", side: "BUY", fillSize: row[1], fillTime: Number(row[2]), holdHours: "24", strategyConfigHash: "cfg", sellTime: 0, sellState: row[3] });
      });
      const submissions = []; let sendNo = 0;
      const fakeOkx = {
        maxAvailSize: async () => [{ instId, availSell: "10" }],
        submitBatchOrders: async (payload) => { submissions.push(payload); sendNo += 1; return payload.map((row) => sendNo >= 3 ? { clOrdId: row.clOrdId, status: "UNKNOWN", reason: "scripted-timeout" } : { clOrdId: row.clOrdId, status: "SUBMITTED", ordId: `ord-${sendNo}` }); },
        order: async () => ({ state: "NOT_FOUND" }), ordersPending: async () => [], ordersHistory: async () => [], ordersHistoryArchive: async () => [], fills: async () => [], fillsHistory: async () => [],
      };
      const makeRuntime = () => {
        const ready = new ReadyGate(); for (const key of ready.required) ready.set(key, true);
        const telemetry = [];
        const coordinator = new OrderCoordinator({ transaction: (fn) => tx(db.admin, fn), orders, state, market, account, readyGate: ready, ownerGuard: { isHeld: () => true }, mode: () => "EXIT_ONLY", clock: now,
          config: { accountId, orderVersion: "p3", strategyTag: "P3", orderExpiryMs: 1_000, accountFreshMs: 10_000, quoteFreshMs: 10_000 }, transport: fakeOkx, telemetry: (event) => telemetry.push(event) });
        const orchestrator = new DelistOrchestrator({ transaction: (fn) => tx(db.admin, fn), state, orders, coordinator, accountId, market, availableBase: (row) => row.remaining_size, telemetry: (event) => telemetry.push(event) }).bind();
        return { ready, telemetry, coordinator, orchestrator };
      };
      let runtime = makeRuntime();
      const protection = new InstrumentProtectionService({ state, transaction: (fn) => tx(db.admin, fn), onExit: ({ instId: protectedInstId }) => runtime.orchestrator.drive(protectedInstId) });
      await protection.confirm({ instId, baseCcy, reason: "unified-test" }); assert.equal((await runtime.coordinator.drainOnce()).count, 1);
      let attempt = (await db.admin.query("SELECT * FROM order_attempts WHERE account_id=$1 AND source_buy_trade_id='unified-full'", [accountId])).rows[0];
      assert.deepEqual(await runtime.coordinator.settleExit({ attempt, fills: [{ tradeId: "exit-full", fillSz: "1", fillTime: "10" }], exchangeState: "filled", accFillSz: "1" }), { settled: true, remaining: "0" });
      assert.equal((await runtime.coordinator.drainOnce()).count, 1, "next durable fill is selected only after the first settles");
      attempt = (await db.admin.query("SELECT * FROM order_attempts WHERE account_id=$1 AND source_buy_trade_id='unified-partial' AND generation=0", [accountId])).rows[0];
      assert.deepEqual(await runtime.coordinator.settleExit({ attempt, fills: [{ tradeId: "exit-partial-1", fillSz: "1", fillTime: "11" }], exchangeState: "canceled", accFillSz: "1" }), { settled: true, remaining: "1" });
      assert.equal((await runtime.coordinator.drainOnce()).count, 1);
      let unknown = (await db.admin.query("SELECT * FROM order_attempts WHERE account_id=$1 AND source_buy_trade_id='unified-partial' AND generation=1", [accountId])).rows[0];
      assert.equal(unknown.state, "UNKNOWN"); assert.equal(unknown.reservation_state, "ACTIVE");

      runtime = makeRuntime();
      const recovery = new ReconciliationService({ transaction: (fn) => tx(db.admin, fn), state, orders, transport: fakeOkx, ownerGuard: { isHeld: () => true }, readyGate: runtime.ready, safetyWaitMs: 0,
        onRecovery: ({ protection }) => runtime.orchestrator.recover(protection), ownership: { accountId, managedAfter: 0, enabledInstIds: [instId] } });
      const recovered = await recovery.recover({ accountId });
      assert.equal(recovered.recovered.some((row) => row.clOrdId === unknown.cl_ord_id && row.outcome === "RETAIN_UNKNOWN"), true);
      assert.equal(runtime.coordinator.pending.DELIST.size, 0, "UNKNOWN blocks a replacement after process reconstruction");
      for (const scope of ["public", "private", "business"]) recovery.completeBaseline(scope);
      assert.deepEqual(await runtime.coordinator.settleExit({ attempt: unknown, fills: [{ tradeId: "exit-partial-2", fillSz: "1", fillTime: "12" }], exchangeState: "filled", accFillSz: "1" }), { settled: true, remaining: "0" });
      assert.equal((await runtime.coordinator.drainOnce()).count, 1);
      unknown = (await db.admin.query("SELECT * FROM order_attempts WHERE account_id=$1 AND source_buy_trade_id='unified-unknown'", [accountId])).rows[0];
      assert.equal(unknown.state, "UNKNOWN");
      await runtime.coordinator.settleExit({ attempt: unknown, fills: [{ tradeId: "exit-unknown", fillSz: "1", fillTime: "13" }], exchangeState: "filled", accFillSz: "1" });
      assert.equal((await db.admin.query("SELECT state FROM instrument_protection WHERE inst_id=$1", [instId])).rows[0].state, "DELIST_DUST");
      assert.deepEqual(submissions.map((batch) => batch.length), [1, 1, 1, 1]);
      assert.ok(submissions.flat().every((row) => row.side === "sell" && row.tdMode === "cross" && row.reduceOnly === true && row.ordType === "market"));

      await tx(db.admin, async (client) => {
        await state.insertFill(client, { accountId, instId, baseCcy, tradeId: "manual-dust", billId: "5", source: "ACCOUNT", side: "SELL", fillSize: "0.05", fillTime: 5, allocationState: "PENDING" });
        await orders.upsertWatermark(client, { accountId, instType: "SPOT", endpoint: "fills", watermark: 5, overlapBegin: 0, healthy: true });
        await orders.upsertWatermark(client, { accountId, instType: "MARGIN", endpoint: "fills", watermark: 5, overlapBegin: 0, healthy: true });
      });
      assert.deepEqual(await recovery.allocateSafeAccountSells({ accountId, baseCcy }), { allocated: 1 });
      assert.equal(await runtime.orchestrator.drive(instId), "EXITED");
      const final = await db.admin.query("SELECT trade_id,disposed_size,sell_state FROM filled_orders WHERE account_id=$1 AND side='BUY' ORDER BY fill_time", [accountId]);
      assert.equal(final.rows.every((row) => row.disposed_size !== "0" && row.sell_state === "SOLD"), true);
      assert.equal((await db.admin.query("SELECT state FROM instrument_protection WHERE inst_id=$1", [instId])).rows[0].state, "EXITED");
    });

    await t.test("P3 concurrent ACCOUNT SELL allocation serializes with active exits and isolates post-HTTP contradictions", async () => {
      const accountId = "p3-account-race"; const instId = "RACE-USDT"; const baseCcy = "RACE"; const telemetry = [];
      await tx(db.admin, async (client) => {
        await state.insertFill(client, { accountId, instId, baseCcy, tradeId: "race-buy", billId: "1", source: "SYSTEM", side: "BUY", fillSize: "1", fillTime: 1, holdHours: "24", strategyConfigHash: "cfg", sellTime: 2, sellState: "SELL_TRIGGERED" });
        await orders.reserveExit(client, exitAttempt("race-active", { accountId, instId, baseCcy, source: "race-buy" })); await orders.markSubmitted(client, "race-active", "race-order");
        await state.insertFill(client, { accountId, instId, baseCcy, tradeId: "race-sell-a", billId: "2", source: "ACCOUNT", side: "SELL", fillSize: "0.5", fillTime: 2, allocationState: "PENDING" });
        await state.insertFill(client, { accountId, instId, baseCcy, tradeId: "race-sell-b", billId: "3", source: "ACCOUNT", side: "SELL", fillSize: "0.5", fillTime: 3, allocationState: "PENDING" });
      });
      assert.deepEqual(await tx(db.admin, (client) => state.allocatePendingAccountSells(client, { accountId, baseCcy, watermark: 3 })), { allocated: 0, reason: "ACTIVE_SYSTEM_EXIT" });
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM filled_orders WHERE account_id=$1 AND allocation_state='PENDING'", [accountId])).rows[0].count, 2);
      await tx(db.admin, (client) => orders.markSettled(client, "race-active", "canceled", "RELEASED"));
      const left = await db.connect(); const right = await db.connect();
      try {
        await Promise.all([
          tx(left, (client) => state.allocatePendingAccountSells(client, { accountId, baseCcy, watermark: 3 })),
          tx(right, (client) => state.allocatePendingAccountSells(client, { accountId, baseCcy, watermark: 3 })),
        ]);
      } finally { await db.close(left); await db.close(right); }
      assert.deepEqual((await db.admin.query("SELECT trade_id,allocation_state,allocated_size FROM filled_orders WHERE account_id=$1 AND side='SELL' ORDER BY trade_id", [accountId])).rows,
        [{ trade_id: "race-sell-a", allocation_state: "APPLIED", allocated_size: "0.5" }, { trade_id: "race-sell-b", allocation_state: "APPLIED", allocated_size: "0.5" }]);
      assert.deepEqual(await tx(db.admin, (client) => state.allocatePendingAccountSells(client, { accountId, baseCcy, watermark: 3 })), { allocated: 0 }, "restart/duplicate replay is idempotent");

      const contradictionAccount = "p3-contradiction";
      await tx(db.admin, async (client) => {
        await state.insertFill(client, { accountId: contradictionAccount, instId, baseCcy, tradeId: "contradiction-buy", billId: "10", source: "SYSTEM", side: "BUY", fillSize: "1", fillTime: 10, holdHours: "24", strategyConfigHash: "cfg", sellTime: 11, sellState: "SELL_TRIGGERED" });
        await orders.reserveExit(client, exitAttempt("contradiction-exit", { accountId: contradictionAccount, instId, baseCcy, source: "contradiction-buy" })); await orders.markSubmitted(client, "contradiction-exit", "already-sent");
        await state.applySystemSell(client, { accountId: contradictionAccount, sourceBuyTradeId: "contradiction-buy", fillSize: "1" });
      });
      const attempt = await tx(db.admin, (client) => orders.findByClOrdId(client, "contradiction-exit"));
      const coordinator = new OrderCoordinator({ transaction: (fn) => tx(db.admin, fn), orders, state, market: { ticker: () => ({ last: "1" }) }, account: {}, readyGate: {}, ownerGuard: {}, config: {}, transport: {}, telemetry: (event) => telemetry.push(event) });
      assert.deepEqual(await coordinator.settleExit({ attempt, fills: [{ tradeId: "late-system-sell", fillSz: "0.5", fillTime: "12" }], exchangeState: "filled", accFillSz: "0.5" }), { settled: false, reason: "DISPOSAL_CONTRADICTION" });
      assert.equal(coordinator.isolatedBases.has(baseCcy), true); assert.equal(telemetry.some((event) => event.reason === "SYSTEM_ACCOUNT_SELL_CONTRADICTION"), true);
      assert.equal((await db.admin.query("SELECT state FROM order_attempts WHERE cl_ord_id='contradiction-exit'")).rows[0].state, "SUBMITTED");
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM filled_orders WHERE trade_id='late-system-sell'")).rows[0].count, 0, "contradictory fill transaction rolls back");
    });

    await t.test("P3 announcement paging rolls back a failed page and persists idempotent receipts in PostgreSQL", async () => {
      const nowMs = 200_000_000; const instruments = [{ instId: "ANN-USDT", base: "ANN" }, { instId: "FAIL-USDT", base: "FAIL" }];
      const exits = []; const telemetry = [];
      const service = new InstrumentProtectionService({ state, transaction: (fn) => tx(db.admin, fn), nowMs: () => nowMs, onExit: (row) => exits.push(row), telemetry: (event) => telemetry.push(event) });
      const pages = async (page) => page === 1 ? { data: [{ details: [{ title: "Spot delisting ANN", pTime: nowMs - 1 }] }] } : page === 2 ? { data: [{ details: [{ title: "Spot delisting old ANN", pTime: nowMs - 86_400_001 }] }] } : { data: [{ details: [] }] };
      assert.deepEqual(await service.scanAnnouncements(pages, instruments), { crossedWindow: true, pages: 2 });
      await service.scanAnnouncements(pages, instruments); assert.equal(exits.length, 1, "durable title+pTime receipt suppresses replay");
      const limit = await service.scanAnnouncements(async () => ({ data: [{ details: [{ title: "unrelated notice", pTime: nowMs }] }] }), instruments);
      assert.deepEqual(limit, { retry: true, pages: 20 }); assert.equal(telemetry.some((event) => event.reason === "ANNOUNCEMENT_PAGE_LIMIT"), true);

      const failingState = { ...state,
        claimAnnouncement: (...args) => state.claimAnnouncement(...args),
        upsertProtection: async (client, row) => { await state.upsertProtection(client, row); if (row.instId === "FAIL-USDT") throw new Error("page write failed"); },
      };
      const failing = new InstrumentProtectionService({ state: failingState, transaction: (fn) => tx(db.admin, fn), nowMs: () => nowMs, telemetry: (event) => telemetry.push(event) });
      const failed = await failing.scanAnnouncements(async () => ({ data: [{ details: [{ title: "Spot delisting ANN and FAIL", pTime: nowMs }] }] }), instruments);
      assert.deepEqual(failed, { retry: true, pages: 1 });
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM announcement_receipts WHERE title='Spot delisting ANN and FAIL'")).rows[0].count, 0);
      assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM instrument_protection WHERE inst_id='FAIL-USDT'")).rows[0].count, 0);
      assert.equal(telemetry.some((event) => event.reason === "ANNOUNCEMENT_PAGE_TRANSACTION_FAILED"), true);
    });

    await t.test("P4 offline protection import is parameterized, transactional and replayable", async () => {
      const artifact = convertD1Export({ legacyDurationUnit: "H", blacklist: [{ crypto_symbol: "P4IMP", reason: "fixture" }], limits: [{ inst_id: "P4IMP-USDT", best_limit: "1", best_duration: "24" }] });
      const first = await importOfflineProtection(db.admin, artifact);
      const second = await importOfflineProtection(db.admin, artifact);
      assert.deepEqual(first, { input_hash: artifact.content_hash, schema_version: 1, inserted: 1, unchanged: 0, conflict: 0, config_artifact_hash: artifact.content_hash });
      assert.equal(second.unchanged, 1);
      await assert.rejects(importOfflineProtection(db.admin, { ...artifact, content_hash: "bad" }), /INVALID_IMPORT_ARTIFACT/);
      await assert.rejects(importOfflineProtection(db.admin, convertD1Export({ legacyDurationUnit: "H", blacklist: [{ crypto_symbol: "P4ROLL" }], limits: [] }), { injectFailure: true }), /INJECTED_IMPORT_FAILURE/);
      assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM instrument_protection WHERE inst_id='P4ROLL-USDT'")).rows[0].n, 0);
      await db.restart();
      assert.equal((await importOfflineProtection(db.admin, artifact)).unchanged, 1, "safe after cluster restart");
    });
  } finally {
    await db.stop();
  }
});
