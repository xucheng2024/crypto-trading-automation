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
import { postgresMigrations } from "../scripts/postgres-migration-manifest.mjs";
import { PANIC_STRATEGY_HASH, strategyDay, strategyDayStartMs } from "../src/domain/rules.js";

const run = promisify(execFile);
async function port() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const value = s.address().port; s.close((error) => error ? reject(error) : resolve(value)); }); }); }
async function transaction(client, fn) { await client.query("BEGIN"); try { const value = await fn(client); await client.query("COMMIT"); return value; } catch (error) { await client.query("ROLLBACK"); throw error; } }
function buy(id) { return { accountId: "p4", intent: "BUY", instId: "BTC-USDT", baseCcy: "BTC", clOrdId: id, payloadHash: `hash-${id}`, strategyDay: "2026-08-14", generation: 0, plannedSize: "0.1", reservedExposureUsd: "10", decisionQuoteTs: 1, decisionQuoteHash: "quote", decisionCandleTs: 1, decisionCandleHash: "candle", decisionMarketKey: "market", executionLimitPrice: "100", instrumentVersion: "v1", holdHours: "24", strategyConfigHash: "cfg", accountSnapshotVersion: "v1" }; }

test("P4 system harness persists a real PostgreSQL lifecycle across restart", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "crypto-p4-system-")); const pgPort = await port(); const log = join(dir, "postgres.log"); let client; let running = false;
  const connect = async () => { client = new Client({ host: "127.0.0.1", port: pgPort, user: process.env.USER, database: "postgres" }); await client.connect(); };
  const start = async () => { await run("pg_ctl", ["-D", dir, "-l", log, "-o", `-p ${pgPort} -h 127.0.0.1`, "-w", "start"]); running = true; await connect(); };
  const stop = async () => { await client?.end(); client = null; if (running) { await run("pg_ctl", ["-D", dir, "-m", "immediate", "-w", "stop"]); running = false; } };
  try {
    await run("initdb", ["-D", dir, "--no-locale", "-E", "UTF8", "-A", "trust"]); await start();
    for (const name of postgresMigrations) await client.query(await readFile(new URL(`../migrations/postgres/${name}`, import.meta.url), "utf8"));
    const harness = new P4SystemHarness({ postgres: { stop, start } });
    await client.query("INSERT INTO daily_limit_cache(inst_id,strategy_day,status,input_hash) VALUES('P4-USDT','2026-01-01','READY','p4')");
    const orders = new OrderRepository(); await transaction(client, (tx) => orders.reserveBuy(tx, buy("p4-restart-attempt")));
    await harness.stopPostgres(); await harness.startPostgres();
    await harness.run({ id: "P4_REAL_PG_RESTART", assertionId: "PG_RESTART_DURABLE", execute: async (h) => { const row = await client.query("SELECT status,input_hash FROM daily_limit_cache WHERE inst_id='P4-USDT'"); const attempt = await orders.findByClOrdId(client, "p4-restart-attempt"); h.assert("PG_RESTART_DURABLE", row.rows.length === 1 && row.rows[0].input_hash === "p4" && attempt.state === "PREPARED" && attempt.reservation_state === "ACTIVE"); } });
    const events = []; const owner = new PostgresOwnerGuard(client, "p4-composition-owner");
    const composed = await composeProductionRuntime({ TRADING_MODE: "OFF", KEY_VAULT_URI: "https://vault.example", POSTGRES_URL: "postgresql://local/postgres" }, { keyVault: { readOkxCredentials: async () => ({ apiKey: "a", secretKey: "b", passphrase: "c" }) }, pool: { query: (...args) => client.query(...args), transaction: (fn) => transaction(client, fn), end: async () => events.push("pool-end") }, ownerClient: client, ownerGuard: owner, reconciliation: { recover: async () => events.push("recovery") }, baseline: async () => events.push("baseline"), ws: { public: { connect: () => events.push("ws"), stop: () => events.push("ws-stop") } }, engine: { startWatchdog: () => events.push("timer"), stopWatchdog: () => events.push("timer-stop") } });
    await composed.start(); assert.deepEqual(events, ["recovery", "baseline", "ws", "timer"]); assert.equal(owner.isHeld(), true);
    await composed.stopTimers(); await composed.closeWebSockets(); await composed.releaseOwner(); assert.equal(owner.isHeld(), false);
  } finally { try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); } }
});

test("P4 full runtime ranks 82% touches in PostgreSQL and submits one owned-USDT IOC per drain", { timeout: 60_000 }, async () => {
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
    for (const name of postgresMigrations) await client.query(await readFile(new URL(`../migrations/postgres/${name}`, import.meta.url), "utf8"));
    const ids = Array.from({ length: 50 }, (_, index) => `Q${index}-USDT`); const owner = new PostgresOwnerGuard(client, "p4-real-runtime");
    const day = strategyDay(Date.now()); const dayStart = strategyDayStartMs(day); const baselineTs = Math.max(dayStart, Date.now() - 5_000);
    let owned = "1000"; const submitted = []; const rest = {
      clockSkewMs: 0, clockFresh: () => true, syncServerTime: async () => 1, systemStatus: async () => [],
      publicInstruments: async () => [...ids, "Q0-BTC", "UNLISTED-USDT"].map((instId) => ({ instId, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", baseCcy: instId.split("-")[0], quoteCcy: instId.split("-")[1], uTime: "1" })),
      tickers: async () => ids.map((instId) => ({ instId, ts: String(baselineTs), last: "100", askPx: "101", bidPx: "99", sodUtc8: "100", low24h: "99" })),
      accountConfig: async () => [{ acctLv: "3", autoLoan: "true" }],
      accountInstruments: async (type) => ids.map((instId) => ({ instId, state: "live", tradeQuoteCcyList: type === "MARGIN" ? "USDT" : "" })),
      leverageInfo: async () => ids.map((instId) => ({ instId, lever: "3" })),
      balance: async (ccy) => ccy ? [{ details: [{ ccy, availBal: owned, cashBal: owned }] }] : [{ totalEq: "1000", adjEq: "1000", uTime: "1" }],
      maxAvailSize: async (joined) => joined.split(",").map((instId) => ({ instId, availBuy: "5000", availSell: "100" })),
      candles: async () => [],
      submitBatchOrders: async (payloads) => { submitted.push(...payloads); owned = "5"; return payloads.map((payload, index) => ({ clOrdId: payload.clOrdId, status: "SUBMITTED", ordId: `p4-${index}` })); },
    };
    const composed = await composeProductionRuntime({ TRADING_MODE: "FULL", OKX_INSTRUMENTS: [...ids, "GONE-USDT"].join(","), KEY_VAULT_URI: "https://vault.example", POSTGRES_URL: "postgresql://local/postgres" }, {
      socketFactory, ownerGuard: owner, ownerClient: client,
      keyVault: { readOkxCredentials: async () => ({ apiKey: "a", secretKey: "b", passphrase: "c" }) },
      pool: { query: (...args) => client.query(...args), transaction: (fn) => transaction(client, fn), end: async () => {} },
      rest, workLoop: { start() {}, stop() {} }, recurring: { start() {}, stop() {} }, orderConfig: { accountId: "default", strategyTag: "azure", orderVersion: "v1", accountFreshMs: 5000, quoteFreshMs: 1500, orderExpiryMs: 3000 },
    });
    try {
      await composed.start(); sockets.forEach((socket) => socket.emit("open")); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sockets.length, 2, "public and private only; no candle socket");
      assert.deepEqual(composed.buyPlanner.instIds, [...ids].sort(), "the universe is OKX_INSTRUMENTS narrowed to live USDT spot pairs; unlisted pairs are ignored");
      for (const arg of [...ids.map((instId) => ({ channel: "tickers", instId })), { channel: "instruments", instType: "SPOT" }, { channel: "status" }]) sockets[0].emit("message", { event: "subscribe", code: "0", arg });
      sockets[1].emit("message", { event: "login", code: "0" }); for (const arg of [{ channel: "account" }, { channel: "balance_and_position" }, { channel: "orders", instType: "ANY" }]) sockets[1].emit("message", { event: "subscribe", code: "0", arg });
      sockets[1].emit("message", { arg: { channel: "account" }, data: [{ totalEq: "1000", adjEq: "1000", uTime: "1" }] });
      const base = Date.now() - 200;
      for (const [index, instId] of ids.entries()) {
        // Q0 and Q1 are the first two 82% touches; Q2..Q6 then gap below 72%.
        const last = index < 2 ? "81" : index < 7 ? "71" : "100";
        sockets[0].emit("message", { arg: { channel: "tickers", instId }, data: [{ instId, ts: String(base + index), last, askPx: last, bidPx: last }] });
      }
      assert.equal(composed.readyGate.ready, true, JSON.stringify(composed.readyGate.snapshot()));
      while (composed.engine.queue.size) await composed.engine.consumeOne();
      const hits = (await client.query("SELECT inst_id, count_hit_source FROM panic_daily_instruments WHERE strategy_day=$1 AND count_hit_at IS NOT NULL ORDER BY count_hit_at, inst_id", [day])).rows;
      assert.deepEqual(hits.map((row) => row.inst_id), ids.slice(0, 7)); assert.ok(hits.every((row) => row.count_hit_source === "LIVE"));
      assert.deepEqual([...composed.coordinator.pending.BUY.keys()].sort(), ids.slice(2, 7).sort(), "every candidate from the 3rd touch on is queued; the first two never are");
      const first = await composed.coordinator.drainOnce();
      assert.equal(first.count, 1); assert.equal(submitted.length, 1);
      assert.deepEqual([submitted[0].instId, submitted[0].side, submitted[0].ordType, submitted[0].tdMode, submitted[0].px, submitted[0].sz], ["Q2-USDT", "buy", "ioc", "cross", "72", "13.881"], "the earliest trigger buys at the 72% limit with owned USDT (1000), not borrowable capacity (5000)");
      assert.equal((await composed.coordinator.drainOnce()).reason, "CAPITAL_EXHAUSTED", "once owned USDT is spent the queue stops without borrowing");
      assert.equal(submitted.length, 1);
      const attempt = (await client.query("SELECT state, decision_reason, strategy_config_hash, hold_hours::text, execution_limit_price::text, decision_candle_ts FROM order_attempts WHERE account_id='default' AND intent='BUY'")).rows;
      assert.deepEqual(attempt, [{ state: "SUBMITTED", decision_reason: "PANIC_BUY_72", strategy_config_hash: PANIC_STRATEGY_HASH, hold_hours: "3", execution_limit_price: "72", decision_candle_ts: String(dayStart) }]);
      assert.deepEqual(composed.slo.assertInvariants(), { maxBatchSize: 1, maxMutationConcurrency: 1, unknownCount: 0 });
    } finally { await composed.stopTimers(); await composed.closeWebSockets(); await composed.releaseOwner(); await composed.closeDatabase(); }
  } finally { try { await stop(); } finally { await rm(dir, { recursive: true, force: true }); } }
});
