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
import { OkxRestClient, OKX_PROFILES, validateAccountProfile, CLOCK_SYNC_STALE_AFTER_MS } from "../infrastructure/okx/rest-client.js";
import { OkxPublicWsClient, OkxPrivateWsClient, OkxWsReconnectBudget } from "../infrastructure/okx/ws-client.js";
import { VirtualSloMetrics } from "./slo-metrics.js";
import { EngineRecurringWork } from "./engine-recurring-work.js";
import { EngineWorkLoop } from "./engine-work-loop.js";
import { ExitSubmissionReconciler } from "./exit-submission-reconciler.js";
import { PanicReboundPlanner } from "./panic-rebound-planner.js";
import { evaluateWatchdog } from "./operations-watchdog.js";
import { ManagedIdentityCredential } from "@azure/identity";

const noop = () => {};
const asTransaction = (pool) => pool.transaction.bind(pool);

export function createCancellableSleep(timers = globalThis) {
  const pending = new Set();
  let cancelled = false;
  const fail = (reason = "STARTUP_CANCELLED") => Object.assign(new Error(reason), { code: reason });
  const sleep = (ms) => new Promise((resolve, reject) => {
    if (cancelled) { reject(fail()); return; }
    const handle = { reject };
    handle.timer = timers.setTimeout(() => { pending.delete(handle); resolve(); }, ms);
    pending.add(handle);
  });
  const cancel = (reason = "STARTUP_CANCELLED") => {
    cancelled = true;
    for (const handle of pending) {
      timers.clearTimeout?.(handle.timer);
      handle.reject(fail(reason));
    }
    pending.clear();
  };
  return { sleep, cancel, get cancelled() { return cancelled; } };
}

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

// Pairs listed less than this long ago are left out of the universe.
export const PANIC_MIN_LISTED_MS = 7 * 86_400_000;
// OKX instCategory "1" is crypto; stocks (3), commodities (4) etc. are out.
const CRYPTO_INST_CATEGORY = "1";
// USD and other fiat-pegged stablecoins never panic like the rest of the market.
export const FIAT_STABLECOIN_BASES = new Set([
  "USDC", "USDG", "USD1", "USDS", "PYUSD", "RLUSD", "FDUSD", "TUSD", "USDP", "GUSD", "BUSD", "DAI", "USDE", "USDD", "LUSD", "FRAX", "GHO", "USDB", "USDQ", "USDR",
  "EURC", "EURI", "EURT", "EURS", "AEUR", "AUDM", "AUDF", "AUDD", "BRL1", "BRZ", "XSGD", "GYEN", "TRYB", "BIDR", "IDRT", "CNHT", "GBPT",
]);

// The strategy universe is every normally trading OKX USDT spot crypto pair
// (instCategory 1), except fiat stablecoins, pairs with an announced expiry
// (expTime) and pairs listed less than seven days before nowMs.  Blacklisted
// and delisting pairs are removed from the count by the planner.
export function liveUsdtSpotUniverse(publicRows, { nowMs = null } = {}) {
  return [...new Set((publicRows ?? []).filter((row) => {
    const instId = String(row?.instId ?? "");
    const base = String(row?.baseCcy ?? instId.split("-")[0]).toUpperCase();
    const listTime = Number(row?.listTime);
    return /^[A-Z0-9]+-USDT$/.test(instId) && (row.quoteCcy ?? instId.split("-")[1]) === "USDT" && (!row.state || row.state === "live") && (!row.ruleType || row.ruleType === "normal")
      && String(row.instCategory ?? "") === CRYPTO_INST_CATEGORY && !FIAT_STABLECOIN_BASES.has(base) && !row.expTime
      && (nowMs == null || !(listTime > 0) || nowMs - listTime >= PANIC_MIN_LISTED_MS);
  }).map((row) => row.instId))].sort();
}

// A pair also needs a 30-day median daily turnover (completed UTC+8 1D bars,
// quote volume) of at least 100k USDT.  One candle read per pair per day.
export const PANIC_LIQUIDITY_DAYS = 30;
export const PANIC_MIN_MEDIAN_QUOTE_VOLUME = 100_000;

export function medianDailyQuoteVolume(candles) {
  const values = (candles ?? []).filter((bar) => String(bar?.[8]) === "1").slice(0, PANIC_LIQUIDITY_DAYS)
    .map((bar) => Number(bar?.[7] ?? bar?.[6])).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

// Pairs whose candles cannot be read keep yesterday's decision (fallback), or
// stay out when there is none; if most reads fail the refresh fails instead.
export async function liquidUniverse({ rest, instIds, fallback = new Set() }) {
  const kept = []; let illiquid = 0; let failed = 0;
  for (const instId of instIds) {
    let median = null;
    try { median = medianDailyQuoteVolume(await rest.candles(instId, { bar: "1D", limit: PANIC_LIQUIDITY_DAYS + 1 })); } catch { median = null; }
    if (median === null) { failed += 1; if (fallback.has(instId)) kept.push(instId); continue; }
    if (median >= PANIC_MIN_MEDIAN_QUOTE_VOLUME) kept.push(instId); else illiquid += 1;
  }
  if (instIds.length && failed * 2 > instIds.length) throw new Error("OKX_LIQUIDITY_UNAVAILABLE");
  return { instIds: kept, illiquid, failed };
}

export async function runRestBaseline({ rest, instIds = null, market, account, readyGate, clock, executionRoutes = new Map(), quoteCurrencies = new Map() }) {
  await rest.syncServerTime();
  const status = await rest.systemStatus();
  if (!serviceAvailable(status, clock.nowMs())) throw new Error("OKX_SERVICE_UNAVAILABLE");
  const publicRows = await rest.publicInstruments("SPOT");
  // The liquidity scan takes one candle read per pair; account and ticker
  // baselines are read only after it so they are fresh when applied.
  let liquidity = null;
  if (!instIds) { liquidity = await liquidUniverse({ rest, instIds: liveUsdtSpotUniverse(publicRows, { nowMs: clock.nowMs() }) }); instIds = liquidity.instIds; }
  if (!instIds.length) throw new Error("OKX_UNIVERSE_EMPTY");
  const [tickers, accountConfig, spotRows, marginRows, balances] = await Promise.all([
    rest.tickers("SPOT"), rest.accountConfig(), rest.accountInstruments("SPOT"), rest.accountInstruments("MARGIN"), rest.balance(),
  ]);
  // Pairs the account cannot trade still count toward the panic tally; they
  // are left without an execution route and are therefore never bought.
  const profile = validateAccountProfile({ config: accountConfig, spotInstruments: spotRows, marginInstruments: marginRows, enabledInstIds: instIds, allowUnavailable: true });
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
  return { instIds, quoteCurrency: profile.quoteCurrency, executionRoutes: profile.executionRoutes, unavailable: profile.unavailable, status, leverage, illiquid: liquidity?.illiquid ?? 0, liquidityFailed: liquidity?.failed ?? 0 };
}

export async function reconcileAndRestoreDatabase({ transaction, orders, reconciliation, accountId, readyGate, ownerGuard, telemetry = noop }) {
  const [attempts, watermarks] = await transaction((tx) => Promise.all([orders.listNonTerminal(tx, accountId), orders.listWatermarks(tx, accountId)]));
  const result = await reconciliation.reconcileAll({ accountId, attempts, watermarks });
  if (!ownerGuard.isHeld()) {
    readyGate.set("database", false);
    throw new Error("DATABASE_RECOVERY_OWNER_LOST");
  }
  const wasReady = readyGate.snapshot?.().dependencies?.database === true;
  readyGate.set("database", true);
  if (!wasReady) {
    try { Promise.resolve(telemetry({ type: "database_recovery", reason: "DATABASE_READY_RESTORED" })).catch(() => {}); } catch { /* telemetry cannot block recovery */ }
  }
  return result;
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
  const ownerGuard = injected.ownerGuard ?? new PostgresOwnerGuard(ownerClient, "azure-trading-owner", telemetry);
  const market = injected.market ?? new MarketProjection({ clock: runtime.clock }); market.quoteFreshMs ??= config.quote_max_age_ms; const account = injected.account ?? new AccountCapitalSnapshot({ clock: runtime.clock });
  const orders = injected.orders ?? new OrderRepository(); const state = injected.state ?? new TradingStateRepository();
  const slo = injected.slo ?? new VirtualSloMetrics(runtime.clock);
  const transaction = injected.transaction ?? asTransaction(pool); const profile = OKX_PROFILES[config.entityProfile]; const rest = injected.rest ?? new OkxRestClient({ credentials, profile, clock: runtime.clock, timeoutMs: config.http_timeout_ms, requestGapMs: injected.requestGapMs ?? 60, slo });
  // The trading universe is discovered from OKX at baseline (live USDT spot
  // pairs, see liveUsdtSpotUniverse) and refreshed each strategy day; tests may pin it.  This array
  // is shared by reference, so it is only ever replaced in place.
  const fixedUniverse = injected.instIds ?? null;
  const instIds = [...(fixedUniverse ?? [])];
  let ws;
  const executionRoutes = injected.executionRoutes ?? new Map();
  const quoteCurrencies = injected.quoteCurrencies ?? new Map();
  let buyPlanner; let engine; let sellService;
  const delistingInstIds = new Set();
  const expTimeConfirmingInstIds = new Set();
  const coordinator = injected.coordinator ?? new OrderCoordinator({ transaction, orders, state, transport: rest, ownerGuard, readyGate, market, account, mode: () => config.tradingMode, executionRoute: (instId) => executionRoutes.get(instId), tradeQuoteCurrency: (instId) => quoteCurrencies.get(instId), isBuyAllowed: (instId) => !buyPlanner?.protected?.has(instId), clock: runtime.clock, config: injected.orderConfig ?? { accountId: config.accountId, strategyTag: config.strategyTag, orderVersion: config.orderVersion, accountFreshMs: config.account_max_age_ms, quoteFreshMs: config.quote_max_age_ms, orderExpiryMs: config.order_expiry_ms }, telemetry, slo,
    onBuySettled: async () => { if (!buyPlanner) return; const ledger = await buyPlanner.reloadLedger(); rebuildSellWatches(ledger); },
    onExitDust: ({ row }) => sellService?.applyDust(row),
  });
  const setUniverse = (next) => {
    instIds.splice(0, instIds.length, ...next);
    buyPlanner?.setUniverse?.(instIds);
    ws?.public?.updateInstIds?.(instIds);
  };
  const refreshUniverse = async () => {
    if (fixedUniverse) return { instruments: instIds.length };
    const rows = await rest.publicInstruments("SPOT");
    const { instIds: next, illiquid, failed } = await liquidUniverse({ rest, instIds: liveUsdtSpotUniverse(rows, { nowMs: runtime.clock.nowMs() }), fallback: new Set(instIds) });
    if (!next.length) throw new Error("OKX_UNIVERSE_EMPTY");
    const byId = new Map(rows.map((row) => [row.instId, row]));
    for (const instId of next) {
      if (market.instrument(instId)) continue;
      const row = byId.get(instId);
      market.updateInstrument({ instId, ts: Number(row.uTime ?? row.listTime ?? 0), state: row.state ?? "live", tickSz: row.tickSz, lotSz: row.lotSz, minSz: row.minSz, expTime: row.expTime, base: row.baseCcy ?? instId.split("-")[0], quote: row.quoteCcy ?? instId.split("-")[1], version: row.uTime ?? row.listTime ?? "1" });
    }
    await refreshExecutionRoutes({ rest, instIds: next, executionRoutes, quoteCurrencies });
    const previous = new Set(instIds); const added = next.filter((instId) => !previous.has(instId)).length;
    setUniverse(next);
    try { Promise.resolve(telemetry({ type: "strategy_baseline", reason: "UNIVERSE_REFRESHED", instruments: next.length, added, illiquid, liquidityFailed: failed })).catch(() => {}); } catch {}
    return { instruments: next.length, added, illiquid, liquidityFailed: failed };
  };
  let clockSyncPromise = null;
  const clockSync = () => {
    if (!clockSyncPromise) clockSyncPromise = Promise.resolve(rest.syncServerTime()).finally(() => { clockSyncPromise = null; });
    return clockSyncPromise;
  };
  sellService = injected.sellService ?? new SellService({ state, transaction, coordinator, market, clock: runtime.clock, exchangeNowMs: () => runtime.clock.nowMs() + Number(rest.clockSkewMs ?? 0), isDelisting: (instId) => delistingInstIds.has(instId), telemetry });
  function rebuildSellWatches(ledger, attempts = []) {
    sellService.rebuild(ledger);
    const active = new Set(attempts.filter((attempt) => ["SELL", "DELIST"].includes(attempt.intent) && !["NOT_CREATED", "SETTLED"].includes(attempt.state)).map((attempt) => attempt.source_buy_trade_id ?? attempt.sourceBuyTradeId));
    engine?.enqueueSellEvents?.(sellService.resumeTriggered?.(active) ?? []);
  }
  const delist = injected.delist ?? new DelistOrchestrator({ transaction, state, orders, coordinator, accountId: config.accountId, market, telemetry }).bind();
  const protection = injected.protection ?? new InstrumentProtectionService({ state, transaction, telemetry, onProtect: (p) => { delistingInstIds.add(p.instId); buyPlanner?.protect?.(p.instId); }, onExit: (p) => delist.drive(p.instId) });
  buyPlanner = injected.buyPlanner ?? new PanicReboundPlanner({ accountId: config.accountId, instIds, market, coordinator, state, orders, transaction, rest, readyGate, clock: runtime.clock, quoteFreshMs: config.quote_max_age_ms, telemetry, slo, refreshUniverse });
  const startupWait = injected.startupWait ?? createCancellableSleep(injected.timers ?? globalThis);
  const reconciliation = injected.reconciliation ?? new ReconciliationService({ orders, state, transport: rest, ownerGuard, readyGate, clock: runtime.clock, safetyWaitMs: config.owner_safety_wait_ms, sleep: startupWait.sleep, aborted: () => startupWait.cancelled, transaction, telemetry,
    // Ownership spans every USDT pair, not just today's live universe: a held
    // symbol can stop being live and its SYSTEM or manual SELL fills must
    // still reconcile against the managed position.
    ownership: { accountId: config.accountId, managedAfter: config.managedFillStartMs, enabledInstIds: { includes: (instId) => /^[A-Z0-9]+-USDT$/.test(String(instId ?? "")) }, systemClOrdIdPrefix: config.orderVersion, strategyTag: config.strategyTag },
    onAccountBuy: async () => { const ledger = await buyPlanner.reloadLedger(); rebuildSellWatches(ledger); },
    onRecovery: ({ ledger, protection: rows, attempts }) => { delistingInstIds.clear(); for (const row of rows) if (["EXITING", "DELIST_DUST"].includes(row.state)) delistingInstIds.add(row.inst_id ?? row.instId); rebuildSellWatches(ledger, attempts); buyPlanner.restore?.({ ledger, protection: rows }); return delist.recover(rows); },
    onTerminal: async ({ attempt, order, fills, exchangeState, accFillSz }) => {
      const result = attempt.intent === "BUY" ? await coordinator.settleBuy({ attempt, fills, exchangeState, accFillSz }) : await coordinator.settleExit({ attempt, fills, exchangeState, accFillSz });
      if (result?.settled) { const ledger = await buyPlanner.reloadLedger?.(); if (ledger) rebuildSellWatches(ledger); }
      return result;
    },
  });
  const exitConfirmation = injected.exitConfirmation ?? new ExitSubmissionReconciler({ orders, reconciliation, transaction, timers: injected.timers ?? globalThis, telemetry });
  coordinator.onExitSubmitted = (attempt) => exitConfirmation.schedule(attempt);
  coordinator.onBuySubmitted = (attempt) => exitConfirmation.schedule(attempt);
  engine = injected.engine ?? new TradingEngine({ projection: market, account, readyGate, clock: runtime.clock, coordinator, sellService, onMarketEvent: (event) => buyPlanner.observe?.(event), onOrderEvent: (order) => reconciliation.observeOrder?.(order), onWatchdog: injected.onWatchdog ?? telemetry, slo });
  const workLoop = injected.workLoop ?? new EngineWorkLoop({ engine, coordinator, timers: injected.timers ?? globalThis, telemetry });
  const socketFactory = injected.socketFactory ?? ((url) => { if (typeof WebSocket !== "function") throw new Error("WEBSOCKET_FACTORY_UNAVAILABLE"); return new WebSocket(url); });
  const instrumentBaseline = new Set();
  const protectionWatchInstIds = () => [...new Set([...instIds, ...(sellService.byInst?.keys() ?? [])])];
  // Subscription ACKs never establish account readiness. A valid account
  // observation is required. The REST baseline establishes instrument
  // readiness; public WS freshness is a separate gate, so a reconnect must
  // not discard already validated static instrument metadata.
  // A standalone non-live state (suspend/preopen/test) must never force an exit on its
  // own — only a trustworthy delist signal may. expTime straight from the exchange is
  // the second such signal alongside announcement text; confirm it once per instrument.
  const maybeConfirmExpTime = (instId, expTime) => {
    if ((!instIds.includes(instId) && !sellService.byInst?.has(instId)) || !expTime || delistingInstIds.has(instId) || expTimeConfirmingInstIds.has(instId)) return;
    const baseCcy = market.instrument(instId)?.base; if (!baseCcy) return;
    expTimeConfirmingInstIds.add(instId);
    Promise.resolve(protection.confirm({ instId, baseCcy, reason: "EXP_TIME" }))
      .catch((error) => { try { telemetry({ type: "protection", reason: "EXP_TIME_CONFIRM_FAILED", instId, error: error?.message }); } catch {} })
      .finally(() => expTimeConfirmingInstIds.delete(instId));
  };
  const observePublic = (row) => {
    if (row.type === "ticker") engine.receiveTicker(row);
    else if (row.type === "instrument") {
      const updated = market.updateInstrument(row);
      if (updated.accepted && instIds.includes(row.instId)) instrumentBaseline.add(row.instId);
      if (instrumentBaseline.size === instIds.length) readyGate.set("instruments", true);
      if (updated.accepted) maybeConfirmExpTime(row.instId, row.expTime);
    }
  };
  const observePrivate = (row) => { if (row.type === "account" && account.update(row)) readyGate.set("account", true); else if (row.type === "orders") engine.receiveOrder(row); };
  const reconnectBudget = injected.reconnectBudget ?? new OkxWsReconnectBudget();
  ws = injected.ws ?? { public: new OkxPublicWsClient({ instIds, socketFactory, profile, clock: runtime.clock, reconnectBudget, onObservation: observePublic, onState: (s) => readyGate.set("public", s.fresh) }), private: new OkxPrivateWsClient({ socketFactory, credentials, profile, clock: runtime.clock, clockSkewMs: () => rest.clockSkewMs, reconnectBudget, onObservation: observePrivate, onState: (s) => readyGate.set("private", s.fresh) }) };
  const migrationCheck = injected.migrationCheck ?? (async () => {
    const result = await pool.query(`SELECT to_regclass('public.order_attempts') AS attempts, to_regclass('public.filled_orders') AS fills,
      to_regclass('public.sync_watermarks') AS watermarks,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_attempts' AND column_name='execution_mode') AS attempt_mode,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='filled_orders' AND column_name='execution_mode') AS fill_mode,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_attempts' AND column_name='execution_route') AS attempt_route,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='filled_orders' AND column_name='execution_route') AS fill_route,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='filled_orders' AND column_name='fill_price') AS fill_price,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_attempts' AND column_name='max_hold_hours') AS attempt_max_hold,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='filled_orders' AND column_name='max_hold_hours') AS fill_max_hold,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='filled_orders' AND column_name='force_sell_time') AS force_sell_time,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='filled_orders' AND column_name='sell_trigger_reason') AS sell_trigger_reason,
      to_regclass('public.panic_daily_instruments') AS panic_daily`);
    if (!result.rows?.[0] || Object.values(result.rows[0]).some((value) => value === null || value === false)) throw new Error("POSTGRES_MIGRATIONS_MISSING");
  });
  const reconcile = async () => {
    return reconcileAndRestoreDatabase({ transaction, orders, reconciliation, accountId: config.accountId, readyGate, ownerGuard, telemetry });
  };
  const baseline = injected.baseline ?? (async () => {
    const result = await runRestBaseline({ rest, instIds: fixedUniverse, market, account, readyGate, clock: runtime.clock, executionRoutes, quoteCurrencies });
    setUniverse(result.instIds);
    return result;
  });
  const recurring = injected.recurring ?? new EngineRecurringWork({ timers: injected.timers ?? globalThis, telemetry,
    announcementMs: injected.announcementMs ?? 60_000, reconcileMs: injected.reconcileMs ?? 300_000, routeMs: injected.routeMs ?? 3_600_000, weeklyMs: injected.weeklyMs ?? 7 * 86_400_000, clockSyncMs: injected.clockSyncMs ?? 300_000, sellReviewMs: injected.sellReviewMs ?? 5_000, dustReviewMs: injected.dustReviewMs ?? 15_000,
    announcements: () => protection.scanAnnouncements((page) => rest.announcements(page), protectionWatchInstIds().map((instId) => market.instrument(instId) ?? { instId, base: instId.split("-")[0] })),
    reconcile, refreshRoutes: async () => {
      try {
        const counts = await refreshExecutionRoutes({ rest, instIds, executionRoutes, quoteCurrencies }); readyGate.set("account", true);
        try { Promise.resolve(telemetry({ type: "execution_routes", reason: "ROUTES_REFRESHED", ...counts })).catch(() => {}); } catch {}
        return counts;
      } catch (error) { readyGate.set("account", false); throw error; }
    }, weeklyReconcile: injected.weeklyReconcile ?? reconcile, clockSync, reviewSells: async () => {
      engine.enqueueSellEvents(sellService.reviewDueWatches());
      if (!sellService.hasTriggered()) return;
      const attempts = await transaction((tx) => orders.listNonTerminal(tx, config.accountId));
      const active = new Set(attempts.filter((attempt) => ["SELL", "DELIST"].includes(attempt.intent)).map((attempt) => attempt.source_buy_trade_id ?? attempt.sourceBuyTradeId));
      engine.enqueueSellEvents(sellService.resumeStalled({ activeSourceTradeIds: active, pendingSourceTradeIds: coordinator.pendingExitSources() }));
    },
    reviewDust: async () => {
      await sellService.reviewDust();
      const rows = await transaction((tx) => state.listProtection(tx));
      for (const row of rows) if (["EXITING", "DELIST_DUST"].includes(row.state)) await delist.drive(row.inst_id ?? row.instId);
    },
    reportMetrics: () => {
      const snapshot = engine.snapshot(); const ws = readyGate.snapshot().dependencies;
      const backlog = coordinator.stuckExitSnapshot?.(5 * 60_000) ?? { count: coordinator.stuckExitCount(5 * 60_000), oldestAgeMs: 0, reasons: "", instruments: "" };
      const exitReady = readyGate.exitReady ?? snapshot.ready.ready;
      const verdict = evaluateWatchdog({ ready: snapshot.ready.ready, ws: { public: ws.public, private: ws.private }, owner: ws.owner, exitBacklog: backlog.count });
      if (!verdict.healthy) telemetry({ type: "watchdog", reason: "WATCHDOG_UNHEALTHY", reasons: verdict.reasons, exitBacklog: backlog.count });
      telemetry({ type: "metric_snapshot", reason: "RUNTIME_METRICS", ...slo.snapshot({ reset: true }), ...market.health(instIds), ...buyPlanner.health(), ...sellService.protectionHealth(), ready: snapshot.ready.ready ? 1 : 0, exit_ready: exitReady ? 1 : 0, ready_owner: ws.owner ? 1 : 0, ready_database: ws.database ? 1 : 0, ready_public: ws.public ? 1 : 0, ready_private: ws.private ? 1 : 0, ready_account: ws.account ? 1 : 0, ready_instruments: ws.instruments ? 1 : 0, strategy_ready: ws.strategy ? 1 : 0, queue_depth_current: snapshot.queue, pending_buy_current: coordinator.pending?.BUY?.size ?? 0, exit_backlog_current: backlog.count, exit_backlog_oldest_age_ms: backlog.oldestAgeMs, exit_backlog_reasons: backlog.reasons, exit_backlog_instruments: backlog.instruments });
      try { telemetry(buyPlanner.pipelineCoverage()); } catch { /* pipeline coverage is diagnostic only */ }
    },
  });
  return { runtime, keyVault, credentials, pool, ownerClient, ownerGuard, orders, state, transaction, market, account, readyGate, coordinator, reconciliation, exitConfirmation, buyPlanner, sellService, protection, delist, rest, ws, engine, workLoop, slo, recurring, executionRoutes, quoteCurrencies, offline: false,
    onOwnerLost(listener) { return ownerGuard.onLost(listener); },
    async start() { // fixed startup order: config -> secrets -> DB -> migration -> owner -> recovery -> REST baseline -> WS -> timers
      readyGate.set("database", false); await migrationCheck(); readyGate.set("database", true);
      while (!await ownerGuard.acquire()) {
        try { telemetry({ type: "owner_recovery", reason: "OWNER_UNAVAILABLE" }); } catch { /* lock wait must not depend on telemetry */ }
        await startupWait.sleep(config.owner_safety_wait_ms);
      }
      if (startupWait.cancelled) throw Object.assign(new Error("STARTUP_CANCELLED"), { code: "STARTUP_CANCELLED" });
      try {
        const recovered = await reconciliation.recover({ accountId: config.accountId });
        if (startupWait.cancelled) throw Object.assign(new Error("STARTUP_CANCELLED"), { code: "STARTUP_CANCELLED" });
        exitConfirmation.scheduleAttempts(recovered?.attempts ?? []); await baseline();
        for (const instId of protectionWatchInstIds()) maybeConfirmExpTime(instId, market.instrument(instId)?.expTime);
        if (injected.baseline && !injected.buyPlanner) readyGate.set("strategy", true); else await buyPlanner.prime();
        engine.enqueueSellEvents?.(sellService.reviewDueWatches?.() ?? []);
        if (startupWait.cancelled) throw Object.assign(new Error("STARTUP_CANCELLED"), { code: "STARTUP_CANCELLED" });
        for (const client of Object.values(ws)) client.connect?.(); engine.startWatchdog(); workLoop.start?.(); recurring.start?.();
      }
      catch (error) { readyGate.set("owner", false); for (const client of Object.values(ws)) client.stop?.(); await exitConfirmation.stop?.(); recurring.stop?.(); workLoop.stop?.(); engine.stopWatchdog?.(); await ownerGuard.release(); throw error; }
    },
    async stopIntake() { startupWait.cancel(); coordinator.stopNewMutations(); }, async stopTimers() { await exitConfirmation.stop?.(); recurring.stop?.(); workLoop.stop?.(); engine.stopWatchdog(); }, async stopNewMutations() { coordinator.stopNewMutations(); }, async closeWebSockets() { for (const client of Object.values(ws)) client.stop?.(); }, async finishInFlight() { await coordinator.finishInFlight(); }, async releaseOwner() { await ownerGuard.release(); }, async closeDatabase() { ownerClient.release?.(); ownerClient.end?.(); await pool.end?.(); },
  };
}
