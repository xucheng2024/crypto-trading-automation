import { CASH_CURRENCIES, MAX_ACTIVE_POSITIONS, POSITION_GATE_USD } from "./config.js";
import { acquireTrade, blacklistedSymbols, configuredPairs, dueTrades, releaseTrade, saveBuyFills } from "./db.js";
import { compareDecimal, decimalToNumber, divideDecimal, multiplyDecimal, roundToStep } from "./decimal.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stableId(prefix, value, length = 24) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return `${prefix}${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length)}`;
}

function balanceDetails(data) {
  return Array.isArray(data?.[0]?.details) ? data[0].details : [];
}

function frozenAmount(detail) {
  return Math.max(decimalToNumber(detail?.frozenBal), decimalToNumber(detail?.ordFrozen));
}

async function activeAssets(okx, threshold = POSITION_GATE_USD) {
  return activeAssetsFromDetails(balanceDetails(await okx.balances()), threshold);
}

function activeAssetsFromDetails(details, threshold = POSITION_GATE_USD) {
  return details.filter((item) => !CASH_CURRENCIES.has(String(item.ccy || "").toUpperCase()) && decimalToNumber(item.eqUsd) > threshold);
}

function balanceByCurrency(details) {
  return new Map(details.map((item) => [String(item.ccy || "").toUpperCase(), item]));
}

function sgtDay(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function candleValues(candles, instId) {
  const todayOpen = candles[0]?.[1];
  const yesterdayOpen = candles[1]?.[1];
  const yesterdayClose = candles[1]?.[4];
  if (!todayOpen || !yesterdayOpen || !yesterdayClose) throw new Error(`Incomplete daily candles for ${instId}`);
  return { todayOpen, yesterdayOpen, yesterdayClose };
}

async function loadDailyCandleCache(db, day) {
  const { results } = await db.prepare("SELECT inst_id,today_open,yesterday_open,yesterday_close FROM daily_candle_cache WHERE day_sgt=?").bind(day).all();
  return new Map((results || []).map((row) => [row.inst_id, {
    todayOpen: row.today_open,
    yesterdayOpen: row.yesterday_open,
    yesterdayClose: row.yesterday_close,
  }]));
}

async function saveDailyCandleCache(db, day, instId, values) {
  await db.prepare(`INSERT INTO daily_candle_cache(day_sgt,inst_id,today_open,yesterday_open,yesterday_close,updated_at)
    VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(day_sgt,inst_id) DO UPDATE SET today_open=excluded.today_open,yesterday_open=excluded.yesterday_open,
      yesterday_close=excluded.yesterday_close,updated_at=CURRENT_TIMESTAMP`)
    .bind(day, instId, values.todayOpen, values.yesterdayOpen, values.yesterdayClose).run();
}

async function instrumentRules(okx, instId) {
  const result = await okx.get("/api/v5/public/instruments", { instType: "SPOT", instId }, false);
  const rows = await okx.requireSuccess(result, { requireData: true, operation: `instrument rules ${instId}` });
  const item = rows[0];
  if (compareDecimal(item.tickSz || "0", "0") <= 0 || compareDecimal(item.lotSz || "0", "0") <= 0) {
    throw new Error(`Invalid instrument rules for ${instId}`);
  }
  return { tickSz: item.tickSz, lotSz: item.lotSz, minSz: item.minSz || item.lotSz };
}

function normalizeInstrumentRules(item) {
  if (compareDecimal(item.tickSz || "0", "0") <= 0 || compareDecimal(item.lotSz || "0", "0") <= 0) return null;
  return { tickSz: item.tickSz, lotSz: item.lotSz, minSz: item.minSz || item.lotSz };
}

async function loadSpotMarketSnapshot(okx) {
  // Both endpoints return all SPOT instruments in one response.  This removes
  // two public requests per configured pair without relaxing the candle rate.
  // A shared Cloudflare egress can reject either bulk endpoint, so snapshots
  // are an optimization only: individual endpoint fallbacks keep the task live.
  let rulesByInstId = new Map();
  let lastByInstId = new Map();
  try {
    const instrumentsResult = await okx.get("/api/v5/public/instruments", { instType: "SPOT" }, false);
    const instrumentRows = await okx.requireSuccess(instrumentsResult, { requireData: true, operation: "spot instrument snapshot" });
    rulesByInstId = new Map(instrumentRows.map((item) => [item.instId, normalizeInstrumentRules(item)]).filter(([, rules]) => rules));
  } catch (error) {
    console.warn(`Spot instrument snapshot unavailable; using per-instrument fallback: ${error.message}`);
  }
  try {
    const tickersResult = await okx.get("/api/v5/market/tickers", { instType: "SPOT" }, false);
    const tickerRows = await okx.requireSuccess(tickersResult, { requireData: true, operation: "spot ticker snapshot" });
    lastByInstId = new Map(tickerRows.map((item) => [item.instId, item.last]));
  } catch (error) {
    console.warn(`Spot ticker snapshot unavailable; using per-instrument fallback: ${error.message}`);
  }
  return { rulesByInstId, lastByInstId };
}

async function cancelAndVerify({ loadPending, cancelBatch, matches, batchSize, label, sleepFn = sleep }) {
  const orders = (await loadPending()).filter(matches);
  const failures = [];
  let remaining = orders;
  for (let attempt = 0; attempt < 3 && remaining.length; attempt += 1) {
    for (let i = 0; i < remaining.length; i += batchSize) {
      try { await cancelBatch(remaining.slice(i, i + batchSize)); } catch (error) { failures.push(error.message); }
      await sleepFn(100);
    }
    await sleepFn(300 * (attempt + 1));
    remaining = (await loadPending()).filter(matches);
  }
  if (remaining.length) throw new Error(`Failed to cancel ${remaining.length}/${orders.length} ${label}(s): ${failures.join("; ")}`);
  return { found: orders.length, remaining: 0 };
}

async function cancelPendingLimits(okx, { side = "buy", instIds, sleepFn = sleep } = {}) {
  const filter = instIds ? new Set(instIds) : null;
  return cancelAndVerify({
    loadPending: () => okx.pendingLimits(),
    cancelBatch: (orders) => okx.cancelLimits(orders),
    matches: (order) => (!side || order.side === side) && (!filter || filter.has(order.instId)),
    batchSize: 20,
    label: "limit order",
    sleepFn,
  });
}

async function cancelPendingTriggers(okx, { side, instIds, sleepFn = sleep } = {}) {
  const filter = instIds ? new Set(instIds) : null;
  return cancelAndVerify({
    loadPending: () => okx.pendingTriggers(),
    cancelBatch: (orders) => okx.cancelTriggers(orders),
    matches: (order) => order.ordType === "trigger" && (!side || order.side === side) && (!filter || filter.has(order.instId)),
    batchSize: 10,
    label: "trigger order",
    sleepFn,
  });
}

async function enforcePositionCapacity(okx, details) {
  const assets = details ? activeAssetsFromDetails(details) : await activeAssets(okx);
  if (assets.length >= MAX_ACTIVE_POSITIONS) await cancelPendingTriggers(okx, { side: "buy" });
  return assets.length;
}

async function reconcileManualSells(env, balances) {
  const threshold = Math.max(0, decimalToNumber(env.OKX_MIN_USD_VALUE || "0.01", 0.01));
  const { results } = await env.DB.prepare("SELECT DISTINCT instid FROM filled_orders WHERE side='buy' AND (sold_status IS NULL OR sold_status != 'SOLD')").all();
  let marked = 0;
  for (const row of results || []) {
    const currency = String(row.instid).split("-")[0].toUpperCase();
    const detail = balances.get(currency);
    if ((!detail || decimalToNumber(detail.eqUsd) < threshold) && frozenAmount(detail) <= 0) {
      const result = await env.DB.prepare("UPDATE filled_orders SET sold_status='SOLD',updated_at=CURRENT_TIMESTAMP WHERE side='buy' AND instid=? AND sold_status IS NULL").bind(row.instid).run();
      marked += result.meta.changes || 0;
    }
  }
  return marked;
}

async function fetchFilledOrders(env, okx, { forceDbFetch = false } = {}) {
  const last = await env.DB.prepare("SELECT MAX(CAST(ts AS INTEGER)) AS last_ts FROM filled_orders WHERE ts != '' AND ts NOT GLOB '*[^0-9]*'").first();
  const begin = last?.last_ts ? Number(last.last_ts) + 1 : Date.now() - (forceDbFetch ? 24 * 60 : 15) * 60_000;
  const fills = (await okx.fillsSince(begin)).filter((fill) => fill.side === "buy");
  const saved = await saveBuyFills(env.DB, fills);
  const details = balanceDetails(await okx.balances());
  const manuallySettled = await reconcileManualSells(env, balanceByCurrency(details));
  const activeCount = await enforcePositionCapacity(okx, details);
  return { fetched: fills.length, saved, manuallySettled, activeCount };
}

async function orderState(okx, instId, { ordId, clOrdId }) {
  const result = await okx.get("/api/v5/trade/order", { instId, ordId, clOrdId });
  if (result?.code === "51603") return "NOT_FOUND";
  let rows;
  try { rows = await okx.requireSuccess(result, { requireData: true, operation: "sell order query" }); } catch { return "UNKNOWN"; }
  const state = rows[0].state;
  if (state === "filled") return "FILLED";
  if (["canceled", "mmp_canceled"].includes(state)) return "FAILED";
  return "PENDING";
}

async function availableBalance(okx, instId) {
  const currency = instId.split("-")[0].toUpperCase();
  const details = balanceDetails(await okx.balances(currency));
  const detail = details.find((item) => String(item.ccy).toUpperCase() === currency);
  if (!detail) return { available: "0", availableUsd: 0, totalUsd: 0, frozen: false };
  const available = compareDecimal(detail.availBal || "0", "0") > 0 ? detail.availBal : detail.availEq || "0";
  const total = decimalToNumber(detail.eq);
  const totalUsd = decimalToNumber(detail.eqUsd);
  return {
    available,
    availableUsd: total > 0 ? totalUsd * Math.max(0, decimalToNumber(available)) / total : totalUsd,
    totalUsd,
    frozen: frozenAmount(detail) > 0,
  };
}

async function submitSell(env, okx, trade) {
  const balance = await availableBalance(okx, trade.instid);
  if (compareDecimal(balance.available, "0") <= 0) return { state: "FAILED" };
  const rules = await instrumentRules(okx, trade.instid);
  const requested = compareDecimal(balance.available, trade.fillsz) >= 0 ? trade.fillsz : balance.available;
  const size = roundToStep(requested, rules.lotSz, "down");
  const minUsd = Math.max(0, decimalToNumber(env.OKX_MIN_USD_VALUE || "0.01", 0.01));
  const unitUsd = decimalToNumber(balance.available) > 0 ? balance.availableUsd / decimalToNumber(balance.available) : 0;
  const effectiveMinUsd = Math.max(minUsd, decimalToNumber(rules.minSz) * unitUsd);
  if (compareDecimal(size, rules.minSz) < 0 || balance.availableUsd < effectiveMinUsd) {
    return { state: balance.totalUsd < effectiveMinUsd && !balance.frozen ? "INSUFFICIENT_VALUE" : "FAILED" };
  }
  const clOrdId = await stableId("sell", trade.tradeid);
  let placed;
  try {
    placed = await okx.placeOrder({ instId: trade.instid, tdMode: "cash", side: "sell", ordType: "market", sz: size, clOrdId, tgtCcy: "base_ccy" });
  } catch (error) {
    console.warn(`Sell outcome unknown for ${trade.tradeid}`, error.message);
    return { state: "UNKNOWN", clOrdId };
  }
  if (!placed.ordId) return { state: "FAILED" };
  return { state: await orderState(okx, trade.instid, { ordId: placed.ordId }), ordId: placed.ordId, clOrdId };
}

async function autoSellOrders(env, okx, { verifyDailyClose = false } = {}) {
  const assets = await activeAssets(okx, Math.max(0, decimalToNumber(env.OKX_MIN_USD_VALUE || "0.01", 0.01)));
  if (assets.length) {
    await env.DB.prepare("UPDATE filled_orders SET sell_time=CAST(CAST(ts AS INTEGER)+86400000 AS TEXT),updated_at=CURRENT_TIMESTAMP WHERE side='buy' AND sold_status IS NULL AND ts != '' AND ts NOT GLOB '*[^0-9]*' AND sell_time IS DISTINCT FROM CAST(CAST(ts AS INTEGER)+86400000 AS TEXT)").run();
  }
  const trades = await dueTrades(env.DB);
  let sold = 0;
  let failed = 0;
  for (const trade of trades) {
    let state;
    let ordId = trade.sell_order_id;
    if (["PROCESSING", "SELL_SUBMITTED"].includes(trade.sold_status)) {
      const clOrdId = await stableId("sell", trade.tradeid);
      state = await orderState(okx, trade.instid, ordId ? { ordId } : { clOrdId });
      if (state === "NOT_FOUND") { await releaseTrade(env.DB, trade.tradeid); continue; }
    } else {
      if (!assets.length || !(await acquireTrade(env.DB, trade.tradeid))) continue;
      const result = await submitSell(env, okx, trade);
      state = result.state;
      ordId = result.ordId;
      if (ordId) {
        const persisted = await env.DB.prepare("UPDATE filled_orders SET sold_status='SELL_SUBMITTED',sell_order_id=?,updated_at=CURRENT_TIMESTAMP WHERE tradeid=? AND sold_status='PROCESSING'").bind(ordId, trade.tradeid).run();
        if (persisted.meta.changes !== 1) continue;
      }
    }
    if (state === "FILLED" || state === "INSUFFICIENT_VALUE") {
      await env.DB.prepare("UPDATE filled_orders SET sold_status='SOLD',trigger_rebuild_pending=?,updated_at=CURRENT_TIMESTAMP WHERE tradeid=? AND sold_status IN ('PROCESSING','SELL_SUBMITTED')").bind(state === "FILLED" ? 1 : 0, trade.tradeid).run();
      sold += 1;
    } else if (["FAILED", "NOT_FOUND"].includes(state)) {
      await releaseTrade(env.DB, trade.tradeid);
      failed += 1;
    }
  }
  let unsettledBeforeToday = 0;
  if (verifyDailyClose) {
    const sgt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const start = Date.UTC(sgt.getUTCFullYear(), sgt.getUTCMonth(), sgt.getUTCDate()) - 8 * 60 * 60 * 1000;
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM filled_orders WHERE side='buy' AND (sold_status IS NULL OR sold_status!='SOLD') AND ts != '' AND ts NOT GLOB '*[^0-9]*' AND CAST(ts AS INTEGER)<?").bind(start).first();
    unsettledBeforeToday = row?.count || 0;
    if (unsettledBeforeToday) console.warn(`Daily close: ${unsettledBeforeToday} unsettled buy fill(s)`);
  }
  return { due: trades.length, sold, failed, unsettledBeforeToday };
}

async function dailyMarketData(env, okx, instId, snapshot, candleCache, candleDay) {
  // The candle remains per-instrument; ticker and rules come from the one-shot
  // SPOT snapshots loaded once for the complete trigger rebuild.
  let candles = candleCache.get(instId);
  if (!candles) {
    const candlesResult = await okx.get("/api/v5/market/candles", { instId, bar: "1D", limit: 2 }, false);
    candles = candleValues(await okx.requireSuccess(candlesResult, { requireData: true, operation: `daily candles ${instId}` }), instId);
    await saveDailyCandleCache(env.DB, candleDay, instId, candles);
    candleCache.set(instId, candles);
  }
  let current = snapshot.lastByInstId.get(instId);
  let rules = snapshot.rulesByInstId.get(instId);
  if (!current) {
    const tickerResult = await okx.get("/api/v5/market/ticker", { instId }, false);
    const ticker = await okx.requireSuccess(tickerResult, { requireData: true, operation: `ticker ${instId}` });
    current = ticker[0].last;
  }
  if (!rules) rules = await instrumentRules(okx, instId);
  return { ...candles, current, rules };
}

async function createPairTrigger(env, okx, pair, runDate, snapshot, candleCache, candleDay) {
  const { todayOpen, yesterdayOpen, yesterdayClose, current, rules } = await dailyMarketData(env, okx, pair.inst_id, snapshot, candleCache, candleDay);
  const yesterdayOpenTimes11 = multiplyDecimal(yesterdayOpen, "11");
  const yesterdayCloseTimes10 = multiplyDecimal(yesterdayClose, "10");
  if (compareDecimal(yesterdayCloseTimes10, yesterdayOpenTimes11) > 0) return { skipped: "yesterday_gain" };
  const target = divideDecimal(multiplyDecimal(todayOpen, pair.best_limit), "100");
  const price = roundToStep(target, rules.tickSz, "half-up");
  const size = roundToStep(divideDecimal(env.OKX_ORDER_SIZE || "100", price), rules.lotSz, "down");
  if (compareDecimal(size, rules.minSz) < 0) return { skipped: "below_min_size" };
  if (compareDecimal(current, target) < 0) {
    const clOrdId = await stableId("buy", `${runDate}:${pair.inst_id}`);
    const placed = await okx.placeOrder({ instId: pair.inst_id, tdMode: "cash", side: "buy", ordType: "limit", px: price, sz: size, tgtCcy: "base_ccy", clOrdId });
    return { orderId: placed.ordId, type: "limit" };
  }
  const algoClOrdId = await stableId("trg", `${runDate}:${pair.inst_id}`);
  const placed = await okx.placeAlgo({ instId: pair.inst_id, tdMode: "cash", side: "buy", ordType: "trigger", sz: size, triggerPx: price, orderPx: price, algoClOrdId });
  return { orderId: placed.algoId, type: "trigger" };
}

async function createAlgoTriggers(env, okx, { clearRebuildPending = false } = {}) {
  const assets = await activeAssets(okx);
  if (assets.length >= MAX_ACTIVE_POSITIONS) {
    if (clearRebuildPending) await env.DB.prepare("UPDATE filled_orders SET trigger_rebuild_pending=0,updated_at=CURRENT_TIMESTAMP WHERE trigger_rebuild_pending=1").run();
    return { skipped: "position_capacity", activeCount: assets.length };
  }
  const [pairs, blacklist] = await Promise.all([configuredPairs(env.DB), blacklistedSymbols(env.DB)]);
  const [pendingTriggers, pendingLimits] = await Promise.all([okx.pendingTriggers(), okx.pendingLimits()]);
  const alreadyCovered = new Set([
    ...pendingTriggers.filter((order) => order.ordType === "trigger" && order.side === "buy").map((order) => order.instId),
    ...pendingLimits.filter((order) => order.side === "buy").map((order) => order.instId),
  ]);
  const eligible = eligibleTriggerPairs(pairs, assets, blacklist, alreadyCovered);
  const runDate = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const candleDay = sgtDay();
  const candleCache = await loadDailyCandleCache(env.DB, candleDay);
  const snapshot = eligible.length ? await loadSpotMarketSnapshot(okx) : null;
  let created = 0;
  let skipped = pairs.length - eligible.length;
  const failures = [];
  for (const pair of eligible) {
    try {
      const result = await createPairTrigger(env, okx, pair, runDate, snapshot, candleCache, candleDay);
      if (result.skipped) skipped += 1; else created += 1;
    } catch (error) {
      failures.push(`${pair.inst_id}: ${error.message}`);
    }
    await sleep(80);
  }
  if (failures.length) throw new Error(`Trigger creation failed for ${failures.length} pair(s): ${failures.slice(0, 5).join("; ")}`);
  if (clearRebuildPending) await env.DB.prepare("UPDATE filled_orders SET trigger_rebuild_pending=0,updated_at=CURRENT_TIMESTAMP WHERE trigger_rebuild_pending=1").run();
  return { configured: pairs.length, created, skipped };
}

function eligibleTriggerPairs(pairs, assets, blacklist, alreadyCovered) {
  const heldSymbols = new Set(assets.map((asset) => String(asset.ccy || "").toUpperCase()));
  return pairs.filter((pair) => {
    const symbol = pair.inst_id.split("-")[0].toUpperCase();
    return !heldSymbols.has(symbol) && !blacklist.has(symbol) && !alreadyCovered.has(pair.inst_id);
  });
}

function symbolAppears(title, symbol) {
  const quotes = ["USDT", "USDC", "BTC", "ETH", "USD", "EUR", "GBP"];
  const aliases = [symbol, ...quotes.flatMap((quote) => [`${symbol}-${quote}`, `${symbol}/${quote}`, `${symbol}${quote}`])];
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, "i").test(title);
  });
}

async function latestDelistSellAttempt(db, announcementId, symbol) {
  return db.prepare(`SELECT attempt,cl_ord_id AS clOrdId,ord_id AS ordId,state
    FROM delist_sell_attempts WHERE announcement_id=? AND symbol=? ORDER BY attempt DESC LIMIT 1`)
    .bind(announcementId, symbol).first();
}

async function createDelistSellAttempt(db, announcementId, symbol, previousAttempt = -1) {
  const attempt = previousAttempt + 1;
  const clOrdId = await stableId("del", `${announcementId}:${symbol}:${attempt}`);
  await db.prepare(`INSERT INTO delist_sell_attempts(announcement_id,symbol,attempt,cl_ord_id,state)
    VALUES(?,?,?,?, 'PREPARED')`).bind(announcementId, symbol, attempt, clOrdId).run();
  return { attempt, clOrdId, state: "PREPARED" };
}

async function updateDelistSellAttempt(db, announcementId, symbol, attempt, state, ordId = null) {
  await db.prepare(`UPDATE delist_sell_attempts SET state=?,ord_id=COALESCE(?,ord_id),updated_at=CURRENT_TIMESTAMP
    WHERE announcement_id=? AND symbol=? AND attempt=?`).bind(state, ordId, announcementId, symbol, attempt).run();
}

async function confirmDelistSell(okx, instId, clOrdId, sleepFn) {
  let state = await orderState(okx, instId, { clOrdId });
  for (let attempt = 0; attempt < 3 && state === "PENDING"; attempt += 1) {
    await sleepFn(1000);
    state = await orderState(okx, instId, { clOrdId });
  }
  return state;
}

async function sellDelistedBalance(env, okx, symbol, announcementId, { sleepFn = sleep } = {}) {
  const instId = `${symbol}-USDT`;
  let sellAttempt = await latestDelistSellAttempt(env.DB, announcementId, symbol);
  if (sellAttempt) {
    const existing = await confirmDelistSell(okx, instId, sellAttempt.clOrdId, sleepFn);
    if (existing === "FILLED") {
      await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, "FILLED");
      return true;
    }
    if (existing === "PENDING") {
      await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, "PENDING");
      throw new Error(`Existing delist sell for ${symbol} remains pending`);
    }
    if (existing === "UNKNOWN") throw new Error(`Unable to reconcile delist sell for ${symbol}`);
    if (existing === "FAILED") {
      await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, "FAILED");
      sellAttempt = { ...sellAttempt, state: "FAILED" };
    }
    if (existing !== "FAILED" && existing !== "NOT_FOUND") throw new Error(`Unable to reconcile delist sell for ${symbol}: ${existing}`);
  }

  const details = balanceDetails(await okx.balances(symbol));
  const detail = details.find((item) => String(item.ccy).toUpperCase() === symbol);
  if (!detail || decimalToNumber(detail.eqUsd) <= 0) {
    if (sellAttempt?.state === "FAILED") await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, "SETTLED");
    return false;
  }
  if (frozenAmount(detail) > 0) throw new Error(`${symbol} balance remains frozen after cancellations`);
  const available = compareDecimal(detail.availBal || "0", "0") > 0 ? detail.availBal : detail.availEq || "0";
  const rules = await instrumentRules(okx, instId);
  const size = roundToStep(available, rules.lotSz, "down");
  if (compareDecimal(size, rules.minSz) < 0) return false;

  if (!sellAttempt || sellAttempt.state === "FAILED") {
    sellAttempt = await createDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt?.attempt);
  }
  try {
    const placed = await okx.placeOrder({ instId, tdMode: "cash", side: "sell", ordType: "market", sz: size, tgtCcy: "base_ccy", clOrdId: sellAttempt.clOrdId });
    await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, "SUBMITTED", placed.ordId);
  } catch (error) {
    console.warn(`Delist sell outcome unknown for ${symbol}`, error.message);
    await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, "UNKNOWN");
  }
  const state = await confirmDelistSell(okx, instId, sellAttempt.clOrdId, sleepFn);
  if (state === "FILLED") {
    await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, "FILLED");
    return true;
  }
  if (state === "PENDING") {
    await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, "PENDING");
    throw new Error(`Delist sell for ${symbol} remains unconfirmed`);
  }
  await updateDelistSellAttempt(env.DB, announcementId, symbol, sellAttempt.attempt, state === "FAILED" ? "FAILED" : "UNKNOWN");
  throw new Error(`Delist sell for ${symbol} is ${state}`);
}

async function fetchDelistAnnouncements(okx) {
  const result = await okx.get("/api/v5/support/announcements", { annType: "announcements-delistings", page: 1 }, false);
  const data = await okx.requireSuccess(result, { operation: "delisting announcement query" });
  return data[0]?.details || [];
}

async function monitorDelist(env, okx) {
  const announcements = await fetchDelistAnnouncements(okx);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const candidates = announcements.filter((item) => Number(item.pTime) >= cutoff && /spot/i.test(item.title || ""));
  const pairs = await configuredPairs(env.DB);
  const symbols = [...new Set(pairs.map((pair) => pair.inst_id.split("-")[0].toUpperCase()))];
  let processed = 0;
  let protectedCount = 0;
  for (const announcement of candidates) {
    const announcementId = `${announcement.title}_${announcement.pTime}`;
    if (await env.DB.prepare("SELECT 1 FROM processed_announcements WHERE announcement_id=?").bind(announcementId).first()) continue;
    const affected = symbols.filter((symbol) => symbolAppears(announcement.title || "", symbol));
    if (affected.length) {
      const reason = `Delisted due to OKX announcement: ${announcement.title}`;
      for (const symbol of affected) {
        await env.DB.prepare(`INSERT INTO blacklist(crypto_symbol,reason,blacklist_type,notes) VALUES(?,?,'delisted',?)
          ON CONFLICT(crypto_symbol) DO UPDATE SET reason=excluded.reason,blacklist_type='delisted',notes=excluded.notes,is_active=1,updated_at=CURRENT_TIMESTAMP`)
          .bind(symbol, reason, `Announcement URL: ${announcement.url || ""}`).run();
      }
      const instIds = affected.map((symbol) => `${symbol}-USDT`);
      await cancelPendingTriggers(okx, { instIds });
      await cancelPendingLimits(okx, { side: null, instIds });
      for (const symbol of affected) if (await sellDelistedBalance(env, okx, symbol, announcementId)) protectedCount += 1;
      for (const instId of instIds) await env.DB.prepare("DELETE FROM crypto_limits WHERE inst_id=?").bind(instId).run();
    }
    await env.DB.prepare(`INSERT INTO processed_announcements(announcement_id,title,url,p_time,affected_cryptos,protection_executed,notes)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(announcement_id) DO NOTHING`).bind(announcementId, announcement.title, announcement.url || "", Number(announcement.pTime), JSON.stringify(affected.sort()), affected.length ? 1 : 0, affected.length ? "Cloudflare protection completed" : "Info only").run();
    processed += 1;
  }
  return { candidates: candidates.length, processed, protected: protectedCount };
}

export const TASKS = {
  monitor_delist: monitorDelist,
  cancel_pending_limits: (_env, okx) => cancelPendingLimits(okx, { side: "buy" }),
  fetch_filled_orders: fetchFilledOrders,
  auto_sell_orders: autoSellOrders,
  cancel_pending_triggers: (_env, okx) => cancelPendingTriggers(okx),
  create_algo_triggers: (env, okx, options) => createAlgoTriggers(env, okx, options),
};

export { activeAssetsFromDetails, candleValues, cancelAndVerify, cancelPendingLimits, cancelPendingTriggers, createAlgoTriggers, eligibleTriggerPairs, fetchDelistAnnouncements, loadSpotMarketSnapshot, sellDelistedBalance, stableId, symbolAppears };
