import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadAzureRuntimeConfig } from "../src/azure/config.js";
import { runReadOnlyPreflight, assertReadOnlyRequest } from "../src/entrypoints/azure/read-only-preflight.js";
import { runMaintenance } from "../src/entrypoints/azure/maintenance-job.js";
import { createHealthServer } from "../src/entrypoints/azure/trading-engine.js";
import { runMaintenanceCycle } from "../src/application/maintenance-composition.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { AzureKeyVaultSecretPort } from "../src/infrastructure/azure/keyvault-port.js";
import { composeProductionRuntime, refreshExecutionRoutes, runRestBaseline } from "../src/application/production-composition.js";
import { EntraPostgresPool, AZURE_POSTGRES_SCOPE } from "../src/infrastructure/postgres/entra-pool.js";
import { createApplicationInsightsTelemetry, isImportantTelemetry } from "../src/infrastructure/azure/application-insights-telemetry.js";
import { EngineRecurringWork } from "../src/application/engine-recurring-work.js";
import { EngineWorkLoop } from "../src/application/engine-work-loop.js";
import { ReadyGate } from "../src/application/trading-engine.js";

test("P4 runtime validates safety timing and defaults OFF", () => {
  const config = loadAzureRuntimeConfig({});
  assert.equal(config.tradingMode, "OFF");
  assert.equal(config.quote_max_age_ms, 1500);
  assert.throws(() => loadAzureRuntimeConfig({ OWNER_SAFETY_WAIT_MS: "5999" }), /OWNER_SAFETY_WAIT_MS/);
  assert.deepEqual(loadAzureRuntimeConfig({ OKX_INSTRUMENTS: 'BTC-USDT,ETH-USDT,BTC-USDT' }).instrumentIds, ['BTC-USDT', 'ETH-USDT']);
  assert.throws(() => loadAzureRuntimeConfig({ OKX_INSTRUMENTS: 'btc/usdt' }), /Invalid OKX_INSTRUMENTS/);
  assert.throws(() => loadAzureRuntimeConfig({ OKX_API_KEY: 'inline' }), /forbidden/);
  assert.throws(() => loadAzureRuntimeConfig({ OKX_ENTITY_PROFILE: 'unknown' }), /Unsupported/);
  const strategy = loadAzureRuntimeConfig({ STRATEGY_CONFIG_JSON: JSON.stringify({ content_hash: 'a'.repeat(64), config: [{ inst_id: 'BTC-USDT', best_limit: '95', hold_hours: '24' }] }), MANAGED_FILL_START_MS: '1' });
  assert.equal(strategy.strategyConfig.rows['BTC-USDT'].holdHours, '24'); assert.equal(strategy.managedFillStartMs, 1);
});

test("P4 REST baseline validates server, account, leverage and configured instruments", async () => {
  const ready = new Map(); const instruments = new Map(); let capital;
  const rows = ["BTC-USDT", "SPOT-USDT"].map((instId) => ({ instId, state: "live", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", baseCcy: instId.split("-")[0], quoteCcy: "USDT", uTime: "1" }));
  const rest = { syncServerTime: async () => {}, systemStatus: async () => [], publicInstruments: async () => rows, tickers: async () => rows.map((row) => ({ instId: row.instId, ts: "2", last: "100", askPx: "101", bidPx: "99" })), accountConfig: async () => [{ acctLv: "3", autoLoan: "true" }], accountInstruments: async (type) => type === "MARGIN" ? [{ instId: "BTC-USDT", state: "live", tradeQuoteCcyList: "USDT" }] : rows, leverageInfo: async () => [{ instId: "BTC-USDT", lever: "3" }], balance: async () => [{ totalEq: "100", adjEq: "99", uTime: "2" }] };
  const result = await runRestBaseline({ rest, instIds: ["BTC-USDT", "SPOT-USDT"], market: { updateInstrument: (row) => instruments.set(row.instId, row), updateTicker: () => {} }, account: { update: (row) => Boolean(capital = row) }, readyGate: { set: (name, value) => ready.set(name, value) }, clock: { nowMs: () => 3 } });
  assert.equal(result.quoteCurrency.get("BTC-USDT"), "USDT"); assert.equal(result.executionRoutes.get("BTC-USDT"), "margin"); assert.equal(result.executionRoutes.get("SPOT-USDT"), "spot"); assert.equal(instruments.get("BTC-USDT").base, "BTC"); assert.equal(capital.totalEq, "100"); assert.equal(ready.get("account"), true); assert.equal(ready.get("instruments"), true);
  await assert.rejects(runRestBaseline({ rest: { ...rest, systemStatus: async () => [{ state: "ongoing" }] }, instIds: ["BTC-USDT"], market: {}, account: {}, readyGate: {}, clock: { nowMs: () => 3 } }), /OKX_SERVICE_UNAVAILABLE/);
});

test("P5 route refresh atomically changes only future routing and removes unavailable instruments", async () => {
  const executionRoutes = new Map([["OLD-USDT", "margin"]]); const quoteCurrencies = new Map([["OLD-USDT", "USDT"]]);
  const rest = { accountConfig: async () => [{ acctLv: "3", autoLoan: true }], accountInstruments: async (type) => type === "SPOT" ? [{ instId: "BTC-USDT", state: "live" }] : [] };
  const counts = await refreshExecutionRoutes({ rest, instIds: ["BTC-USDT", "GONE-USDT"], executionRoutes, quoteCurrencies });
  assert.deepEqual(counts, { margin: 0, spot: 1, unavailable: 1 }); assert.deepEqual([...executionRoutes], [["BTC-USDT", "spot"]]); assert.equal(quoteCurrencies.has("OLD-USDT"), false);
});

test("P4 preflight requires authorization, supplies required GET params and rejects mutations", async () => {
  const result = await runReadOnlyPreflight({ mode: "offline", fixture: { acctLv: "3" } });
  assert.equal(result.ok, true);
  assert.throws(() => assertReadOnlyRequest("POST", "/api/v5/trade/batch-orders"));
  await assert.rejects(runReadOnlyPreflight({ mode: "real" }), /authorization/);
  const calls = [];
  const real = await runReadOnlyPreflight({
    mode: "real",
    realAuthorized: true,
    instId: "BTC-USDT",
    client: { read: async (...args) => { calls.push(args); return []; } },
  });
  assert.equal(real.ok, true);
  assert.deepEqual(calls, [
    ["/api/v5/public/time", {}, false],
    ["/api/v5/account/config", {}, true],
    ["/api/v5/account/instruments", { instType: "SPOT" }, true],
    ["/api/v5/account/instruments", { instType: "MARGIN" }, true],
    ["/api/v5/account/leverage-info", { instId: "BTC-USDT", mgnMode: "cross" }, true],
    ["/api/v5/system/status", {}, false],
  ]);
});

test("P4 maintenance has no mutation port and remains idempotent", async () => {
  const tx = { query: async () => ({ rowCount: 0 }) };
  const one = await runMaintenance({ tx, before: new Date(0), checks: { budget: async () => ({ ok: true }) } });
  assert.equal(one.retentionCount, 0); assert.equal(one.health.budget.ok, true);
});

test("P4 production roots and container have no legacy D1 runtime", async () => {
  const files = await Promise.all(["src/entrypoints/azure/trading-engine.js", "src/entrypoints/azure/maintenance-job.js", "Dockerfile"].map((file) => readFile(file, "utf8")));
  assert.doesNotMatch(files.join("\n"), /src\/db\.js|from ["'].*\/db\.js|D1Database/);
  assert.match(files[2], /TRADING_MODE=OFF/);
});

test("P4 health endpoints distinguish liveness from global readiness", async () => {
  const server = createHealthServer({ liveness: () => true, readiness: () => false, readinessDetails: () => ({ ready: false, dependencies: { private: false } }) }, { port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ready: false, dependencies: { private: false } });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("P4 production health server is closed by graceful shutdown", async () => {
  const engine = await (await import("../src/entrypoints/azure/trading-engine.js")).startTradingEngine({}, { lifecycle: {}, health: { enabled: true, port: 0 } });
  await engine.shutdown();
});

test("P4 OFF remains operational for the explicitly known account-profile prerequisite", async () => {
  const telemetry = [];
  const { startTradingEngine } = await import("../src/entrypoints/azure/trading-engine.js");
  const lifecycle = { start: async () => { throw new Error("OKX_BASELINE_ACCOUNT_PROFILE"); } };
  const engine = await startTradingEngine({ TRADING_MODE: "OFF" }, { lifecycle, telemetry: (event) => telemetry.push(event) });
  assert.equal(engine.startupDegraded, "OKX_BASELINE_ACCOUNT_PROFILE");
  assert.equal(engine.liveness(), true); assert.equal(engine.readiness(), true);
  assert.deepEqual(telemetry, [{ event: "OFF_SAFE_DEGRADED", reason: "OKX_BASELINE_ACCOUNT_PROFILE" }]);
  await assert.rejects(startTradingEngine({ TRADING_MODE: "FULL" }, { lifecycle }), /OKX_BASELINE_ACCOUNT_PROFILE/);
});

test("P5 telemetry sends only important structured traces and strips secrets", async () => {
  const traces = []; const metrics = []; let flushed = 0; let stopped = 0;
  const client = { config: {}, commonProperties: {}, trackTrace: (trace) => traces.push(trace), trackMetric: (metric) => metrics.push(metric), flush: async () => { flushed += 1; }, shutdown: async () => { stopped += 1; } };
  const telemetry = createApplicationInsightsTelemetry({ client, serviceName: "engine", tradingMode: "OFF" });
  telemetry({ type: "ticker", instId: "BTC-USDT" });
  telemetry({ type: "reconcile_attempt", reason: "UNKNOWN_ORDER", instId: "BTC-USDT", apiKey: "forbidden", token: "forbidden" });
  telemetry({ type: "trading_decision", reason: "BREAKOUT_NOT_CONFIRMED", instId: "ETH-USDT", last: "1" });
  telemetry({ type: "metric_snapshot", reason: "RUNTIME_METRICS", queue_wait_p99_ms: 4, ready: 1 });
  assert.equal(isImportantTelemetry({ type: "ticker" }), false); assert.equal(traces.length, 3);
  assert.match(traces[0].message, /UNKNOWN_ORDER/); assert.equal(traces[0].properties.instId, "BTC-USDT");
  assert.equal(traces[0].properties.apiKey, undefined); assert.equal(traces[0].properties.token, undefined);
  assert.match(traces[1].message, /BREAKOUT_NOT_CONFIRMED/); assert.deepEqual(metrics, [{ name: "queue_wait_p99_ms", value: 4 }, { name: "ready", value: 1 }]);
  assert.deepEqual(client.commonProperties, { service: "engine", environment: "p5", tradingMode: "OFF" });
  await telemetry.flush(); await telemetry.shutdown(); assert.equal(flushed, 1); assert.equal(stopped, 1);
});

test("P4 maintenance composition replays safely with fake management ports", async () => {
  const calls = []; const tx = { query: async () => ({ rowCount: 0 }) };
  const result = await runMaintenanceCycle({ tx, announcements: async () => ({ ok: true }), reconcile: async () => ({ ok: true }), management: { postgresCapacity: async () => ({ ok: true }), natIp: async () => ({ ok: true }) }, retentionBefore: new Date(0), telemetry: (x) => calls.push(x) });
  assert.equal(result.retention, 0); assert.deepEqual(calls, []);
});

test("P4 graceful shutdown stops intake before transports and owner release", async () => {
  const events = []; const { startTradingEngine } = await import("../src/entrypoints/azure/trading-engine.js");
  const engine = await startTradingEngine({}, { lifecycle: Object.fromEntries(['stopIntake','stopTimers','stopNewMutations','closeWebSockets','finishInFlight','releaseOwner','closeDatabase','closeHealthServer'].map((name) => [name, async () => events.push(name)])) });
  await engine.shutdown(); assert.deepEqual(events, ['stopIntake','stopTimers','stopNewMutations','closeWebSockets','finishInFlight','releaseOwner','closeDatabase','closeHealthServer']);
});

test("P4 maintenance CLI fails closed without an injected credential-free adapter", async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ["scripts/run-maintenance.mjs"], { cwd: process.cwd() }), /MAINTENANCE_ADAPTER_MODULE/);
});

test("P4 maintenance CLI executes only a credential-free injected adapter", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/run-maintenance.mjs"], { cwd: process.cwd(), env: { ...process.env, MAINTENANCE_ADAPTER_MODULE: pathToFileURL(resolve("fixtures/p4/maintenance-adapter.mjs")).href } });
  assert.equal(JSON.parse(stdout).retentionCount, 0);
});

test("P4 maintenance composition handles interruption and telemetry failure without mutation", async () => {
  let queried = 0; const telemetry = () => { throw new Error("telemetry down"); };
  const interrupted = await runMaintenanceCycle({ tx: { query: async () => { queried += 1; return { rowCount: 0 }; } }, announcements: async () => ({ ok: true }), reconcile: async () => ({ ok: true }), interrupted: () => true, telemetry });
  assert.deepEqual(interrupted, { interrupted: true }); assert.equal(queried, 0);
  const replay = await runMaintenanceCycle({ tx: { query: async () => ({ rowCount: 0 }) }, management: { postgresCapacity: async () => { throw new Error("management fail"); } }, telemetry, retentionBefore: new Date(0) });
  assert.equal(replay.retention, 0); assert.deepEqual(replay.postgres, { ok: false });
});

test("P4 Key Vault adapter has no env fallback and redacts unavailable values", async () => {
  const events = []; class FakeSecretClient { constructor() {} async getSecret(name) { if (name === "denied") throw new Error("403 api-key-secret"); return { value: name === "empty" ? "" : `${name}-v2` }; } }
  const port = new AzureKeyVaultSecretPort({ vaultUrl: "https://vault.example", credential: {}, SecretClient: FakeSecretClient, logger: (event) => events.push(event) });
  const credentials = await port.readOkxCredentials({ apiKey: "api", secretKey: "secret", passphrase: "pass" });
  assert.deepEqual(credentials, { apiKey: "api-v2", secretKey: "secret-v2", passphrase: "pass-v2" });
  await assert.rejects(port.getSecret("empty"), /KEY_VAULT_SECRET_UNAVAILABLE:empty/); await assert.rejects(port.getSecret("denied"), /KEY_VAULT_SECRET_UNAVAILABLE:denied/);
  assert.deepEqual(events, [{ reason: "KEY_VAULT_SECRET_UNAVAILABLE", secretName: "empty" }, { reason: "KEY_VAULT_SECRET_UNAVAILABLE", secretName: "denied" }]);
});

test("P4 Key Vault adapter reads a new secret version without persisting it", async () => {
  let version = 0; class RotatingClient { async getSecret() { version += 1; return { value: `v${version}` }; } }
  const port = new AzureKeyVaultSecretPort({ vaultUrl: 'https://vault.example', credential: {}, SecretClient: RotatingClient });
  assert.equal(await port.getSecret('api'), 'v1'); assert.equal(await port.getSecret('api'), 'v2');
});

test("P4 production composition executes migration-owner-recovery order and releases owner before pool", async () => {
  const events = [];
  const pool = { query: async () => ({ rows: [{ attempts: 'order_attempts', fills: 'filled_orders', watermarks: 'sync_watermarks' }] }), transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }), end: async () => events.push('pool') };
  const ownerGuard = { isHeld: () => false, onLost: () => () => {}, acquire: async () => { events.push('owner-acquire'); return true; }, release: async () => events.push('owner-release') };
  const runtime = await composeProductionRuntime({ TRADING_MODE: 'EXIT_ONLY', KEY_VAULT_URI: 'https://vault.example', POSTGRES_URL: 'postgresql://host/db' }, {
    keyVault: { readOkxCredentials: async () => ({ apiKey: 'a', secretKey: 'b', passphrase: 'c' }) }, pool, ownerClient: { release: () => events.push('owner-client') }, ownerGuard,
    migrationCheck: async () => events.push('migration'), reconciliation: { recover: async () => events.push('recovery') }, baseline: async () => events.push('baseline'), ws: { public: { connect: () => events.push('ws-public'), stop: () => events.push('ws-stop') } }, engine: { startWatchdog: () => events.push('timers'), stopWatchdog: () => events.push('timers-stop') },
  });
  await runtime.start(); assert.deepEqual(events, ['migration', 'owner-acquire', 'recovery', 'baseline', 'ws-public', 'timers']);
  await runtime.stopIntake(); await runtime.stopTimers(); await runtime.stopNewMutations(); await runtime.closeWebSockets(); await runtime.finishInFlight(); await runtime.releaseOwner(); await runtime.closeDatabase();
  assert.deepEqual(events.slice(-5), ['timers-stop', 'ws-stop', 'owner-release', 'owner-client', 'pool']);
});

test("P4 Entra PostgreSQL pool uses official scope, TLS verification and fails readiness closed", async () => {
  const events = []; let options; class FakePool { constructor(value) { options = value; } on() {} async connect() { throw new Error('pool exhausted'); } async end() {} }
  const credential = { getToken: async (scope) => { assert.equal(scope, AZURE_POSTGRES_SCOPE); return { token: 'short-token', expiresOnTimestamp: Date.now() + 10_000 }; } };
  assert.throws(() => new EntraPostgresPool({ connectionString: 'postgresql://user:secret@host/db', credential, Pool: FakePool }), /must not contain a password/);
  const adapter = new EntraPostgresPool({ connectionString: 'postgresql://user@host/db', credential, Pool: FakePool, logger: (event) => events.push(event), onUnavailable: (reason) => events.push({ reason }) });
  assert.equal(options.connectionString, undefined); assert.equal(options.host, 'host'); assert.equal(options.port, 5432); assert.equal(options.user, 'user'); assert.equal(options.database, 'db');
  assert.equal(options.ssl.rejectUnauthorized, true); assert.equal(await options.password(), 'short-token'); await assert.rejects(adapter.connect(), /pool exhausted/);
  assert.deepEqual(events, [{ reason: 'POSTGRES_POOL_UNAVAILABLE' }, { reason: 'POSTGRES_POOL_UNAVAILABLE' }]);
});

test("P4 composition fails closed before owner or WS when migration gate fails", async () => {
  const events = []; const readyGate = { ready: false, set: (name, value) => events.push(`${name}:${value}`) };
  const composed = await composeProductionRuntime({ TRADING_MODE: 'EXIT_ONLY', KEY_VAULT_URI: 'https://vault.example', POSTGRES_URL: 'postgresql://host/db' }, {
    keyVault: { readOkxCredentials: async () => ({ apiKey: 'a', secretKey: 'b', passphrase: 'c' }) }, readyGate,
    pool: { transaction: async (fn) => fn({}), end: async () => {} }, ownerClient: {}, ownerGuard: { onLost: () => () => {}, acquire: async () => { events.push('owner'); return true; }, isHeld: () => false, release: async () => {} },
    migrationCheck: async () => { throw new Error('POSTGRES_MIGRATIONS_MISSING'); }, reconciliation: { recover: async () => events.push('recovery') }, ws: { public: { connect: () => events.push('ws') } }, engine: { startWatchdog: () => events.push('timer') },
  });
  await assert.rejects(composed.start(), /POSTGRES_MIGRATIONS_MISSING/); assert.deepEqual(events, ['database:false']);
});

test("P4 baseline failure releases the owner and never starts WS", async () => {
  const events = []; const gate = { set: (name, value) => events.push(`${name}:${value}`) };
  const composed = await composeProductionRuntime({ TRADING_MODE: "OFF", KEY_VAULT_URI: "https://vault.example", POSTGRES_URL: "postgresql://host/db" }, { keyVault: { readOkxCredentials: async () => ({ apiKey: "a", secretKey: "b", passphrase: "c" }) }, readyGate: gate, pool: { transaction: async (fn) => fn({}), end: async () => {} }, ownerClient: {}, ownerGuard: { onLost: () => () => {}, isHeld: () => true, acquire: async () => true, release: async () => events.push("released") }, migrationCheck: async () => {}, reconciliation: { recover: async () => {} }, baseline: async () => { throw new Error("bad baseline"); }, ws: { public: { connect: () => events.push("ws"), stop: () => events.push("ws-stop") } }, engine: { stopWatchdog: () => {} } });
  await assert.rejects(composed.start(), /bad baseline/); assert.equal(events.includes("ws"), false); assert.equal(events.at(-1), "released");
});

test("P4 production composition routes fake WS baselines into projections and keeps account fail-closed", async () => {
  const readyGate = new ReadyGate();
  const marketEvents = []; const buyPlanner = { protected: new Set(), restore: () => {}, prime: async () => readyGate.set('strategy', true), observe: async (event) => marketEvents.push(event) };
  const sockets = []; const socketFactory = () => {
    const listeners = new Map(); const socket = { sent: [], addEventListener(name, fn) { listeners.set(name, fn); }, send(value) { this.sent.push(JSON.parse(value)); }, close() { listeners.get('close')?.(); }, emit(name, data) { listeners.get(name)?.(name === 'message' ? { data: JSON.stringify(data) } : {}); } };
    sockets.push(socket); return socket;
  };
  const ownerGuard = { held: false, isHeld() { return this.held; }, onLost: () => () => {}, acquire: async () => (ownerGuard.held = true), release: async () => { ownerGuard.held = false; } };
  const composed = await composeProductionRuntime({ TRADING_MODE: 'EXIT_ONLY', OKX_INSTRUMENTS: 'BTC-USDT', KEY_VAULT_URI: 'https://vault.example', POSTGRES_URL: 'postgresql://host/db' }, {
    socketFactory, ownerGuard, ownerClient: {}, readyGate, buyPlanner, keyVault: { readOkxCredentials: async () => ({ apiKey: 'a', secretKey: 'b', passphrase: 'c' }) },
    pool: { query: async () => ({ rows: [{ attempts: 'order_attempts', fills: 'filled_orders', watermarks: 'sync_watermarks' }] }), transaction: async (fn) => fn({}), end: async () => {} },
    reconciliation: { recover: async () => ({ ready: false }) }, baseline: async () => readyGate.set('instruments', true), orderConfig: { strategyTag: 'azure', orderVersion: 'v1' },
  });
  try {
    await composed.start(); sockets.forEach((socket) => socket.emit('open'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(composed.readyGate.snapshot().dependencies.instruments, true);
    // public ACKs: ticker, instruments and status; business has one candle ACK.
    for (const arg of [{ channel: 'tickers', instId: 'BTC-USDT' }, { channel: 'instruments', instType: 'SPOT' }, { channel: 'status' }]) sockets[0].emit('message', { event: 'subscribe', code: '0', arg });
    sockets[1].emit('message', { event: 'login', code: '0' });
    for (const arg of [{ channel: 'account' }, { channel: 'balance_and_position' }, { channel: 'orders', instType: 'ANY' }]) sockets[1].emit('message', { event: 'subscribe', code: '0', arg });
    sockets[2].emit('message', { event: 'subscribe', code: '0', arg: { channel: 'candle3m', instId: 'BTC-USDT' } });
    sockets[0].emit('message', { arg: { channel: 'tickers', instId: 'BTC-USDT' }, data: [{ instId: 'BTC-USDT', ts: '1', last: '100', askPx: '101', bidPx: '99' }] });
    sockets[0].emit('message', { arg: { channel: 'instruments', instType: 'SPOT' }, data: [{ instId: 'BTC-USDT', uTime: '1', state: 'live', tickSz: '0.1', lotSz: '0.001', minSz: '0.001' }] });
    sockets[2].emit('message', { arg: { channel: 'candle3m', instId: 'BTC-USDT' }, data: [['1', '100', '101', '99', '100', '1', '1', '1', '1']] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(composed.market.ticker('BTC-USDT').last, '100'); assert.equal(composed.market.instrument('BTC-USDT').state, 'live'); assert.equal(composed.market.candle('BTC-USDT').open, '100');
    assert.ok(marketEvents.some((event) => event.type === 'ticker')); assert.ok(marketEvents.some((event) => event.type === 'market-recheck'));
    assert.equal(composed.readyGate.snapshot().dependencies.account, false);
    sockets[1].emit('message', { arg: { channel: 'account' }, data: [{ totalEq: '10', adjEq: '9', uTime: '2' }] });
    assert.equal(composed.readyGate.snapshot().dependencies.account, true); assert.equal(composed.slo.samples.get('event_enqueue').length, 1);
  } finally { await composed.closeWebSockets(); await composed.stopTimers(); await composed.releaseOwner(); }
});

test("P4 default WS composition refuses an empty instrument baseline", async () => {
  await assert.rejects(composeProductionRuntime({ TRADING_MODE: 'EXIT_ONLY', KEY_VAULT_URI: 'https://vault.example', POSTGRES_URL: 'postgresql://host/db' }, {
    keyVault: { readOkxCredentials: async () => ({ apiKey: 'a', secretKey: 'b', passphrase: 'c' }) }, pool: { transaction: async (fn) => fn({}), end: async () => {} }, ownerClient: {}, ownerGuard: { onLost: () => () => {} },
  }), /OKX_INSTRUMENTS_REQUIRED/);
});

test("P4 Engine recurring work serializes remote timers but never phase-starves metrics", async () => {
  const intervals = new Map(); let next = 0; const timers = { setInterval(fn, delay) { const id = ++next; intervals.set(id, { fn, delay }); return id; }, clearInterval(id) { intervals.delete(id); } };
  const events = []; let release; const blocked = new Promise((resolve) => { release = resolve; });
  let metricReports = 0; let clockSyncs = 0; let candleReviews = 0; const work = new EngineRecurringWork({ timers, telemetry: (event) => events.push(event), announcementMs: 11, reconcileMs: 13, routeMs: 15, weeklyMs: 17, clockSyncMs: 19, candleReviewMs: 21, announcements: async () => blocked, reportMetrics: async () => { metricReports += 1; }, clockSync: async () => { clockSyncs += 1; }, reviewCandles: async () => { candleReviews += 1; } });
  work.start(); assert.deepEqual([...intervals.values()].map((row) => row.delay).sort((a, b) => a - b), [11, 13, 15, 17, 19, 21, 60_000]);
  const first = work.run('ANNOUNCEMENT', work.announcements); assert.deepEqual(await work.run('RECONCILE', async () => { throw new Error('must not run'); }), { skipped: true, reason: 'RECURRING_WORK_BUSY' });
  const metricTimer = [...intervals.values()].find((row) => row.delay === 60_000); assert.deepEqual(await metricTimer.fn(), { ok: true }); assert.equal(metricReports, 1);
  assert.deepEqual(await [...intervals.values()].find((row) => row.delay === 19).fn(), { ok: true }); assert.deepEqual(await [...intervals.values()].find((row) => row.delay === 21).fn(), { ok: true }); assert.equal(clockSyncs, 1); assert.equal(candleReviews, 1);
  release(); assert.deepEqual(await first, { ok: true }); assert.deepEqual(await work.run('WEEKLY_RECONCILE', async () => { throw new Error('offline'); }), { ok: false });
  assert.equal(events[0].reason, 'WEEKLY_RECONCILE_FAILED'); work.stop(); assert.equal(intervals.size, 0);
});

test("P4 Engine work loop drains critical events and Coordinator batches without reentry", async () => {
  const events = [{ type: "SELL_BREACH" }, null]; const results = [{ submitted: true }, { submitted: false, reason: "EMPTY" }]; let consumed = 0; let drained = 0;
  const loop = new EngineWorkLoop({ engine: { consumeOne: async () => { consumed += 1; return events.shift(); } }, coordinator: { drainOnce: async () => { drained += 1; return results.shift(); } }, timers: { setInterval: () => 1, clearInterval: () => {} } });
  assert.deepEqual(await loop.run(), { events: 1, batches: 1 }); assert.equal(consumed, 2); assert.equal(drained, 2);
});
