import { createAzureRuntime } from "../azure/runtime.js";
import { createManagedIdentityKeyVaultPort } from "../infrastructure/azure/keyvault-port.js";
import { EntraPostgresPool } from "../infrastructure/postgres/entra-pool.js";
import { PostgresOwnerGuard } from "../infrastructure/postgres/owner-guard.js";
import { OrderRepository, TradingStateRepository } from "../infrastructure/postgres/repositories.js";
import { MarketProjection, AccountCapitalSnapshot, ReadyGate, TradingEngine } from "./trading-engine.js";
import { OrderCoordinator } from "./order-coordinator.js";
import { ReconciliationService } from "./reconciliation-service.js";
import { SellService } from "./sell-service.js";
import { InstrumentProtectionService } from "./instrument-protection-service.js";
import { DelistOrchestrator } from "./delist-orchestrator.js";
import { OkxRestClient, OKX_PROFILES, validateAccountProfile } from "../infrastructure/okx/rest-client.js";
import { OkxPublicWsClient, OkxPrivateWsClient, OkxBusinessWsClient } from "../infrastructure/okx/ws-client.js";
import { VirtualSloMetrics } from "./slo-metrics.js";
import { EngineRecurringWork } from "./engine-recurring-work.js";
import { EngineWorkLoop } from "./engine-work-loop.js";
import { ManagedIdentityCredential } from "@azure/identity";

const noop = () => {};
const asTransaction = (pool) => pool.transaction.bind(pool);

function serviceAvailable(rows, nowMs) {
  return !(rows ?? []).some((row) => String(row.state ?? "").toLowerCase() === "ongoing" || (Number(row.begin) <= nowMs && nowMs <= Number(row.end)));
}

function replaceMap(target, source) { target.clear(); for (const [key, value] of source) target.set(key, value); }

export async function refreshExecutionRoutes({ rest, instIds, executionRoutes, quoteCurrencies }) {
  const [accountConfig, spotRows, marginRows] = await Promise.all([rest.accountConfig(), rest.accountInstruments("SPOT"), rest.accountInstruments("MARGIN")]);
  const profile = validateAccountProfile({ config: accountConfig, spotInstruments: spotRows, marginInstruments: marginRows, enabledInstIds: instIds, allowUnavailable: true });
  if (!profile.ready) throw new Error(`OKX_ROUTE_${profile.reason}${profile.instId ? `:${profile.instId}` : ""}`);
  replaceMap(executionRoutes, profile.executionRoutes); replaceMap(quoteCurrencies, profile.quoteCurrency);
  return { margin: [...executionRoutes.values()].filter((route) => route === "margin").length, spot: [...executionRoutes.values()].filter((route) => route === "spot").length, unavailable: profile.unavailable.length };
}

export async function runRestBaseline({ rest, instIds, market, account, readyGate, clock, executionRoutes = new Map(), quoteCurrencies = new Map() }) {
  await rest.syncServerTime();
  const status = await rest.systemStatus();
  if (!serviceAvailable(status, clock.nowMs())) throw new Error("OKX_SERVICE_UNAVAILABLE");
  const [publicRows, tickers, accountConfig, spotRows, marginRows, balances] = await Promise.all([
    rest.publicInstruments("SPOT"), rest.tickers("SPOT"), rest.accountConfig(), rest.accountInstruments("SPOT"), rest.accountInstruments("MARGIN"), rest.balance(),
  ]);
  const profile = validateAccountProfile({ config: accountConfig, spotInstruments: spotRows, marginInstruments: marginRows, enabledInstIds: instIds });
  if (!profile.ready) throw new Error(`OKX_BASELINE_${profile.reason}${profile.instId ? `:${profile.instId}` : ""}`);
  replaceMap(executionRoutes, profile.executionRoutes); replaceMap(quoteCurrencies, profile.quoteCurrency);
  const firstMargin = instIds.find((instId) => executionRoutes.get(instId) === "margin");
  const leverage = firstMargin ? await rest.leverageInfo(firstMargin) : [];
  const byId = new Map(publicRows.map((row) => [row.instId, row]));
  for (const instId of instIds) {
    const row = byId.get(instId);
    if (!row || (row.state && row.state !== "live")) throw new Error(`OKX_BASELINE_INSTRUMENT:${instId}`);
    market.updateInstrument({ instId, ts: Number(row.uTime ?? row.listTime ?? 0), state: row.state ?? "live", tickSz: row.tickSz, lotSz: row.lotSz, minSz: row.minSz, expTime: row.expTime, base: row.baseCcy ?? instId.split("-")[0], quote: row.quoteCcy ?? instId.split("-")[1], version: row.uTime ?? row.listTime ?? "1" });
  }
  for (const row of tickers) if (instIds.includes(row.instId)) market.updateTicker({ instId: row.instId, ts: Number(row.ts), last: row.last, askPx: row.askPx, bidPx: row.bidPx });
  if (firstMargin && !Array.isArray(leverage)) throw new Error("OKX_BASELINE_LEVERAGE");
  if (!account.update(balances[0] ?? {})) throw new Error("OKX_BASELINE_ACCOUNT");
  readyGate.set("account", true); readyGate.set("instruments", true);
  return { quoteCurrency: profile.quoteCurrency, executionRoutes: profile.executionRoutes, status, leverage };
}

// Sole production composition root.  Every external concern is injectable for
// tests, but no caller needs to pre-assemble a lifecycle in production.
export async function composeProductionRuntime(env, injected = {}) {
  const runtime = createAzureRuntime(env, injected.runtime ?? {});
  const { config } = runtime; const telemetry = injected.telemetry ?? noop;
  if (!config.keyVaultUri && !injected.keyVault) throw new Error("KEY_VAULT_URI_REQUIRED");
  if (!config.postgresUrl && !injected.pool) throw new Error("POSTGRES_URL_REQUIRED");
  const credential = injected.credential ?? new ManagedIdentityCredential();
  const keyVault = injected.keyVault ?? await createManagedIdentityKeyVaultPort({ vaultUrl: config.keyVaultUri, credential, logger: telemetry });
  const credentials = await keyVault.readOkxCredentials(config.secretNames);
  const readyGate = injected.readyGate ?? new ReadyGate();
  const pool = injected.pool ?? new EntraPostgresPool({ connectionString: config.postgresUrl, credential, logger: telemetry, onUnavailable: (reason) => { readyGate.set("database", false); telemetry({ reason }); } });
  const ownerClient = injected.ownerClient ?? await pool.connect();
  const ownerGuard = injected.ownerGuard ?? new PostgresOwnerGuard(ownerClient);
  const market = injected.market ?? new MarketProjection({ clock: runtime.clock }); const account = injected.account ?? new AccountCapitalSnapshot({ clock: runtime.clock });
  const orders = injected.orders ?? new OrderRepository(); const state = injected.state ?? new TradingStateRepository();
  const transaction = injected.transaction ?? asTransaction(pool); const profile = OKX_PROFILES[config.entityProfile]; const rest = injected.rest ?? new OkxRestClient({ credentials, profile, clock: runtime.clock, timeoutMs: config.http_timeout_ms });
  const instIds = injected.instIds ?? config.instrumentIds;
  const executionRoutes = injected.executionRoutes ?? new Map();
  const quoteCurrencies = injected.quoteCurrencies ?? new Map();
  const slo = injected.slo ?? new VirtualSloMetrics(runtime.clock);
  const coordinator = injected.coordinator ?? new OrderCoordinator({ transaction, orders, state, transport: rest, ownerGuard, readyGate, market, account, mode: () => config.tradingMode, executionRoute: (instId) => executionRoutes.get(instId), tradeQuoteCurrency: (instId) => quoteCurrencies.get(instId), clock: runtime.clock, config: injected.orderConfig ?? { accountId: config.accountId, strategyTag: config.strategyTag, orderVersion: config.orderVersion, accountFreshMs: config.account_max_age_ms, quoteFreshMs: config.quote_max_age_ms, orderExpiryMs: config.order_expiry_ms }, telemetry, slo });
  const sellService = injected.sellService ?? new SellService({ state, transaction, coordinator, market, clock: runtime.clock, telemetry });
  const delist = injected.delist ?? new DelistOrchestrator({ transaction, state, orders, coordinator, accountId: config.accountId, market, telemetry }).bind();
  const protection = injected.protection ?? new InstrumentProtectionService({ state, transaction, telemetry, onExit: (p) => delist.drive(p.instId) });
  const holdHoursByInst = Object.fromEntries(Object.entries(config.strategyConfig.rows).map(([instId, row]) => [instId, row.holdHours]));
  const reconciliation = injected.reconciliation ?? new ReconciliationService({ orders, state, transport: rest, ownerGuard, readyGate, clock: runtime.clock, safetyWaitMs: config.owner_safety_wait_ms, transaction, telemetry,
    ownership: { accountId: config.accountId, managedAfter: config.managedFillStartMs, enabledInstIds: instIds, systemClOrdIdPrefix: config.orderVersion, strategyTag: config.strategyTag, holdHoursByInst, configHash: config.strategyConfig.contentHash },
    onAccountBuy: (instId) => engine?.protectInstrument(instId), onRecovery: ({ ledger, protection: rows }) => { sellService.rebuild(ledger); return delist.recover(rows); } });
  const engine = injected.engine ?? new TradingEngine({ projection: market, account, readyGate, clock: runtime.clock, coordinator, sellService, onWatchdog: injected.onWatchdog ?? telemetry, slo });
  const workLoop = injected.workLoop ?? new EngineWorkLoop({ engine, coordinator, timers: injected.timers ?? globalThis, telemetry });
  const socketFactory = injected.socketFactory ?? ((url) => { if (typeof WebSocket !== "function") throw new Error("WEBSOCKET_FACTORY_UNAVAILABLE"); return new WebSocket(url); });
  if (!injected.ws && !instIds.length) throw new Error("OKX_INSTRUMENTS_REQUIRED");
  const instrumentBaseline = new Set();
  // Subscription ACKs never establish account readiness. A valid account
  // observation is required. The REST baseline establishes instrument
  // readiness; public WS freshness is a separate gate, so a reconnect must
  // not discard already validated static instrument metadata.
  const observePublic = (row) => {
    if (row.type === "ticker") engine.receiveTicker(row);
    else if (row.type === "instrument") {
      const updated = market.updateInstrument(row);
      if (updated.accepted && instIds.includes(row.instId)) instrumentBaseline.add(row.instId);
      if (instrumentBaseline.size === instIds.length) readyGate.set("instruments", true);
    }
  };
  const observePrivate = (row) => { if (row.type === "account" && account.update(row)) readyGate.set("account", true); };
  const observeBusiness = (row) => { if (row.type === "candle5m") engine.receiveCandle(row); };
  const ws = injected.ws ?? { public: new OkxPublicWsClient({ instIds, socketFactory, profile, clock: runtime.clock, onObservation: observePublic, onState: (s) => readyGate.set("public", s.fresh) }), private: new OkxPrivateWsClient({ socketFactory, credentials, profile, clock: runtime.clock, onObservation: observePrivate, onState: (s) => readyGate.set("private", s.fresh) }), business: new OkxBusinessWsClient({ instIds, socketFactory, profile, clock: runtime.clock, onObservation: observeBusiness, onState: (s) => readyGate.set("business", s.fresh) }) };
  const migrationCheck = injected.migrationCheck ?? (async () => {
    const result = await pool.query(`SELECT to_regclass('public.order_attempts') AS attempts, to_regclass('public.filled_orders') AS fills,
      to_regclass('public.sync_watermarks') AS watermarks,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_attempts' AND column_name='execution_mode') AS attempt_mode,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='filled_orders' AND column_name='execution_mode') AS fill_mode,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_attempts' AND column_name='execution_route') AS attempt_route,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='filled_orders' AND column_name='execution_route') AS fill_route`);
    if (!result.rows?.[0] || Object.values(result.rows[0]).some((value) => value === null || value === false)) throw new Error("POSTGRES_MIGRATIONS_MISSING");
  });
  const reconcile = async () => {
    const [attempts, watermarks] = await transaction((tx) => Promise.all([orders.listNonTerminal(tx, config.accountId), orders.listWatermarks(tx, config.accountId)]));
    return reconciliation.reconcileAll({ accountId: config.accountId, attempts, watermarks });
  };
  const baseline = injected.baseline ?? (() => runRestBaseline({ rest, instIds, market, account, readyGate, clock: runtime.clock, executionRoutes, quoteCurrencies }));
  const recurring = injected.recurring ?? new EngineRecurringWork({ timers: injected.timers ?? globalThis, telemetry,
    announcementMs: injected.announcementMs ?? 60_000, reconcileMs: injected.reconcileMs ?? 300_000, routeMs: injected.routeMs ?? 3_600_000, weeklyMs: injected.weeklyMs ?? 7 * 86_400_000,
    announcements: () => protection.scanAnnouncements((page) => rest.announcements(page), instIds.map((instId) => market.instrument(instId)).filter(Boolean)),
    reconcile, refreshRoutes: async () => {
      try {
        const counts = await refreshExecutionRoutes({ rest, instIds, executionRoutes, quoteCurrencies }); readyGate.set("account", true);
        try { Promise.resolve(telemetry({ type: "execution_routes", reason: "ROUTES_REFRESHED", ...counts })).catch(() => {}); } catch {}
        return counts;
      } catch (error) { readyGate.set("account", false); throw error; }
    }, weeklyReconcile: injected.weeklyReconcile ?? reconcile,
  });
  return { runtime, keyVault, credentials, pool, ownerClient, ownerGuard, orders, state, transaction, market, account, readyGate, coordinator, reconciliation, sellService, protection, delist, rest, ws, engine, workLoop, slo, recurring, executionRoutes, quoteCurrencies, offline: false,
    async start() { // fixed startup order: config -> secrets -> DB -> migration -> owner -> recovery -> REST baseline -> WS -> timers
      readyGate.set("database", false); await migrationCheck(); readyGate.set("database", true); if (!await ownerGuard.acquire()) throw new Error("OWNER_UNAVAILABLE");
      try { await reconciliation.recover({ accountId: config.accountId }); await baseline(); for (const client of Object.values(ws)) client.connect?.(); engine.startWatchdog(); workLoop.start?.(); recurring.start?.(); }
      catch (error) { readyGate.set("owner", false); for (const client of Object.values(ws)) client.stop?.(); recurring.stop?.(); workLoop.stop?.(); engine.stopWatchdog?.(); await ownerGuard.release(); throw error; }
    },
    async stopIntake() { coordinator.stopNewMutations(); }, async stopTimers() { recurring.stop?.(); workLoop.stop?.(); engine.stopWatchdog(); }, async stopNewMutations() { coordinator.stopNewMutations(); }, async closeWebSockets() { for (const client of Object.values(ws)) client.stop?.(); }, async finishInFlight() { await coordinator.finishInFlight(); }, async releaseOwner() { await ownerGuard.release(); }, async closeDatabase() { ownerClient.release?.(); ownerClient.end?.(); await pool.end?.(); },
  };
}
