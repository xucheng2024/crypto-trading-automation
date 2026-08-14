import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { P4SystemHarness } from "../src/application/p4-replay-harness.js";
import { OrderRepository } from "../src/infrastructure/postgres/repositories.js";
import { PostgresOwnerGuard } from "../src/infrastructure/postgres/owner-guard.js";
import { composeProductionRuntime } from "../src/application/production-composition.js";
import { expectedClosedCandleTs } from "../src/domain/rules.js";

const run = promisify(execFile);
async function port() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const value = s.address().port; s.close((error) => error ? reject(error) : resolve(value)); }); }); }
async function transaction(client, fn) { await client.query("BEGIN"); try { const value = await fn(client); await client.query("COMMIT"); return value; } catch (error) { await client.query("ROLLBACK"); throw error; } }
function buy(id) { return { accountId: "p4", intent: "BUY", instId: "BTC-USDT", baseCcy: "BTC", clOrdId: id, payloadHash: `hash-${id}`, strategyDay: "2026-08-14", generation: 0, plannedSize: "0.1", reservedExposureUsd: "10", frozenTargetUsd: "100", decisionQuoteTs: 1, decisionQuoteHash: "quote", decisionCandleTs: 1, decisionCandleHash: "candle", decisionMarketKey: "market", executionLimitPrice: "100", instrumentVersion: "v1", holdHours: "24", strategyConfigHash: "cfg", admissionEquity: "100", admissionExposure: "0", accountSnapshotVersion: "v1" }; }

test("P4 system harness persists a real PostgreSQL lifecycle across restart", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "crypto-p4-system-")); const pgPort = await port(); const log = join(dir, "postgres.log"); let client; let running = false;
  const connect = async () => { client = new Client({ host: "127.0.0.1", port: pgPort, user: process.env.USER, database: "postgres" }); await client.connect(); };
  const start = async () => { await run("pg_ctl", ["-D", dir, "-l", log, "-o", `-p ${pgPort} -h 127.0.0.1`, "-w", "start"]); running = true; await connect(); };
  const stop = async () => { await client?.end(); client = null; if (running) { await run("pg_ctl", ["-D", dir, "-m", "immediate", "-w", "stop"]); running = false; } };
  try {
    await run("initdb", ["-D", dir, "--no-locale", "-E", "UTF8", "-A", "trust"]); await start();
    for (const name of ["0001_p1_core.sql", "0002_p3_exit.sql", "0003_p4_import.sql", "0004_hybrid_execution.sql", "0005_execution_route.sql", "0006_decision_observability.sql", "0007_sell_force_hold.sql"]) await client.query(await readFile(new URL(`../migrations/postgres/${name}`, import.meta.url), "utf8"));
    const harness = new P4SystemHarness({ postgres: { stop, start } });
    await client.query("INSERT INTO daily_limit_cache(inst_id,strategy_day,status,input_hash) VALUES('P4-USDT','2026-01-01','READY','p4')");
    const orders = new OrderRepository(); await transaction(client, (tx) => orders.reserveBuy(tx, buy("p4-restart-attempt"), { managedExposure: "0", maxExposure: "100" }));
    await harness.stopPostgres(); await harness.startPostgres();
    await harness.run({ id: "P4_REAL_PG_RESTART", assertionId: "PG_RESTART_DURABLE", execute: async (h) => { const row = await client.query("SELECT status,input_hash FROM daily_limit_cache WHERE inst_id='P4-USDT'"); const attempt = await orders.findByClOrdId(client, "p4-restart-attempt"); h.assert("PG_RESTART_DURABLE", row.rows.length === 1 && row.rows[0].input_hash === "p4" && attempt.state === "PREPARED" && attempt.reservation_state === "ACTIVE"); } });
    const events = []; const owner = new PostgresOwnerGuard(client, "p4-composition-owner");
    const composed = await composeProductionRuntime({ TRADING_MODE: "EXIT_ONLY", KEY_VAULT_URI: "https://vault.example", POSTGRES_URL: "postgresql://local/postgres" }, { keyVault: { readOkxCredentials: async () => ({ apiKey: "a", secretKey: "b", passphrase: "c" }) }, pool: { query: (...args) => client.query(...args), transaction: (fn) => transaction(client, fn), end: async () => events.push("pool-end") }, ownerClient: client, ownerGuard: owner, reconciliation: { recover: async () => events.push("recovery") }, baseline: async () => events.push("baseline"), ws: { public: { connect: () => events.push("ws"), stop: () => events.push("ws-stop") } }, engine: { startWatchdog: () => events.push("timer"), stopWatchdog: () => events.push("timer-stop") } });
    await composed.start(); assert.deepEqual(events, ["recovery", "baseline", "ws", "timer"]); assert.equal(owner.isHeld(), true);
    await composed.stopTimers(); await composed.closeWebSockets(); await composed.releaseOwner(); assert.equal(owner.isHeld(), false);
  } finally { try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); } }
});

test("P4 full runtime uses one PostgreSQL, fake OKX WS/REST, five-order Coordinator batch, SLO, coalescing and exit preemption", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "crypto-p4-runtime-")); const pgPort = await port(); const log = join(dir, "postgres.log"); let client; let running = false;
  const connect = async () => { client = new Client({ host: "127.0.0.1", port: pgPort, user: process.env.USER, database: "postgres" }); await client.connect(); };
  const start = async () => { await run("pg_ctl", ["-D", dir, "-l", log, "-o", `-p ${pgPort} -h 127.0.0.1`, "-w", "start"]); running = true; await connect(); };
  const stop = async () => { await client?.end(); client = null; if (running) { await run("pg_ctl", ["-D", dir, "-m", "immediate", "-w", "stop"]); running = false; } };
  const sockets = []; const socketFactory = () => {
    const listeners = new Map(); const socket = { addEventListener(name, fn) { listeners.set(name, fn); }, send() {}, close() { listeners.get("close")?.(); }, emit(name, value) { listeners.get(name)?.(name === "message" ? { data: JSON.stringify(value) } : {}); } };
    sockets.push(socket); return socket;
  };
  try {
    await run("initdb", ["-D", dir, "--no-locale", "-E", "UTF8", "-A", "trust"]); await start();
    for (const name of ["0001_p1_core.sql", "0002_p3_exit.sql", "0003_p4_import.sql", "0004_hybrid_execution.sql", "0005_execution_route.sql", "0006_decision_observability.sql", "0007_sell_force_hold.sql"]) await client.query(await readFile(new URL(`../migrations/postgres/${name}`, import.meta.url), "utf8"));
    const ids = Array.from({ length: 50 }, (_, index) => `Q${index}-USDT`); const owner = new PostgresOwnerGuard(client, "p4-real-runtime");
    const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); const dayStart = Date.parse(`${day}T00:00:00+08:00`); const priorStart = dayStart - 86_400_000; const closedTs = expectedClosedCandleTs(Date.now());
    let submitted = []; const rest = {
      clockSkewMs: 0, clockFresh: () => true, syncServerTime: async () => 1, systemStatus: async () => [],
      publicInstruments: async () => ids.map((instId) => ({ instId, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", baseCcy: instId.split("-")[0], quoteCcy: "USDT", uTime: "1" })),
      tickers: async () => ids.map((instId) => ({ instId, ts: "1", last: "100", askPx: "101", bidPx: "99" })),
      accountConfig: async () => [{ acctLv: "3", autoLoan: "true" }],
      accountInstruments: async (type) => ids.map((instId) => ({ instId, state: "live", tradeQuoteCcyList: type === "MARGIN" ? "USDT" : "" })),
      leverageInfo: async () => ids.map((instId) => ({ instId, lever: "3" })), balance: async () => [{ totalEq: "100", adjEq: "100", uTime: "1" }],
      maxAvailSize: async (joined) => joined.split(",").map((instId) => ({ instId, availBuy: "10", availSell: "100" })),
      candles: async (_instId, options) => options.bar === "1D" ? [[String(dayStart), "100", "101", "90", "95", "1", "1", "1", "0"], [String(priorStart), "100", "101", "90", "100", "1", "1", "1", "1"]] : [[String(closedTs), "94", "94.5", "93", "94.4", "1", "1", "1", "1"]],
      submitBatchOrders: async (payloads) => { submitted.push(...payloads); return payloads.map((payload, index) => ({ clOrdId: payload.clOrdId, status: "SUBMITTED", ordId: `p4-${index}` })); },
    };
    const composed = await composeProductionRuntime({ TRADING_MODE: "FULL", OKX_INSTRUMENTS: ids.join(","), STRATEGY_CONFIG_JSON: JSON.stringify({ content_hash: "a".repeat(64), config: ids.map((inst_id) => ({ inst_id, best_limit: "95", hold_hours: "24" })) }), KEY_VAULT_URI: "https://vault.example", POSTGRES_URL: "postgresql://local/postgres" }, {
      socketFactory, ownerGuard: owner, ownerClient: client,
      keyVault: { readOkxCredentials: async () => ({ apiKey: "a", secretKey: "b", passphrase: "c" }) },
      pool: { query: (...args) => client.query(...args), transaction: (fn) => transaction(client, fn), end: async () => {} },
      rest, workLoop: { start() {}, stop() {} }, orderConfig: { accountId: "default", strategyTag: "azure", orderVersion: "v1", accountFreshMs: 5000, quoteFreshMs: 1500, orderExpiryMs: 3000 },
    });
    try {
      await composed.start(); sockets.forEach((socket) => socket.emit("open")); await new Promise((resolve) => setImmediate(resolve));
      for (const arg of [...ids.map((instId) => ({ channel: "tickers", instId })), { channel: "instruments", instType: "SPOT" }, { channel: "status" }]) sockets[0].emit("message", { event: "subscribe", code: "0", arg });
      sockets[1].emit("message", { event: "login", code: "0" }); for (const arg of [{ channel: "account" }, { channel: "balance_and_position" }, { channel: "orders", instType: "ANY" }]) sockets[1].emit("message", { event: "subscribe", code: "0", arg });
      for (const arg of ids.map((instId) => ({ channel: "candle3m", instId }))) sockets[2].emit("message", { event: "subscribe", code: "0", arg });
      sockets[1].emit("message", { arg: { channel: "account" }, data: [{ totalEq: "100", adjEq: "100", uTime: "1" }] });
      for (const [index, instId] of ids.entries()) {
        sockets[0].emit("message", { arg: { channel: "instruments", instType: "SPOT" }, data: [{ instId, uTime: "1", state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001" }] });
        sockets[0].emit("message", { arg: { channel: "tickers", instId }, data: [{ instId, ts: "1", last: index < 5 ? "94.9" : "100", askPx: index < 5 ? "94.9" : "101", bidPx: index < 5 ? "94.8" : "99" }] });
        if (index < 5) sockets[2].emit("message", { arg: { channel: "candle3m", instId }, data: [[String(closedTs), "94", "94.5", "93", "94.4", "1", "1", "1", "1"]] });
        assert.equal(composed.market.ticker(instId).instId, instId, `ticker ${index}`);
      }
      composed.engine.queue.enqueue({ type: "SELL_BREACH", priority: "critical", instId: ids[0] });
      const first = composed.engine.queue.take();
      assert.equal(first.type, "SELL_BREACH"); assert.equal(composed.engine.queue.size, 55); assert.equal(composed.readyGate.ready, true, JSON.stringify(composed.readyGate.snapshot()));
      assert.equal(composed.slo.samples.get("event_enqueue").length, 50);
      while (composed.engine.queue.size) await composed.engine.consumeOne();
      assert.equal(composed.coordinator.pending.BUY.size, 5, "production market events create five BUY intents without test injection");
      const batch = await composed.coordinator.drainOnce(); assert.equal(batch.count, 5); assert.equal(submitted.length, 5); assert.ok(submitted.every((row) => row.side === "buy" && row.tdMode === "cross"));
      assert.equal((await client.query("SELECT count(*)::int AS count FROM order_attempts WHERE account_id='default' AND intent='BUY' AND state='SUBMITTED'")).rows[0].count, 5);
      assert.deepEqual(composed.slo.assertInvariants(), { maxBatchSize: 5, maxMutationConcurrency: 1, unknownCount: 0 });
    } finally { await composed.stopTimers(); await composed.closeWebSockets(); await composed.releaseOwner(); await composed.closeDatabase(); }
  } finally { try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); } }
});
