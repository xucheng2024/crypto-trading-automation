const encoder = new TextEncoder();
export const CLOCK_SYNC_STALE_AFTER_MS = 600_000;

export const OKX_PROFILES = Object.freeze({
  GLOBAL: Object.freeze({ restUrl: "https://openapi.okx.com", publicWsUrl: "wss://ws.okx.com:8443/ws/v5/public", privateWsUrl: "wss://ws.okx.com:8443/ws/v5/private", businessWsUrl: "wss://ws.okx.com:8443/ws/v5/business" }),
});

function base64(bytes) {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}

function query(params = {}) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") out.set(key, String(value));
  const text = out.toString();
  return text ? `?${text}` : "";
}

function retryAfter(response, nowMs) {
  const value = response?.headers?.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(30_000, seconds * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(30_000, at - nowMs)) : null;
}

export function assertOkxResponse(result, { requireData = false } = {}) {
  if (!result || result.code !== "0") {
    const code = result?.code ?? "empty";
    const error = new Error(result?.msg ? `OKX code ${code}: ${result.msg}` : `OKX code ${code}`);
    error.okxCode = String(code);
    error.okxMessageClass = classifyOkxMessage(result?.msg);
    error.okxSummary = safeOkxSummary(result?.msg);
    throw error;
  }
  if (requireData && (!Array.isArray(result.data) || result.data.length === 0)) {
    const error = new Error("OKX response has no data");
    error.responseClass = "EMPTY_DATA";
    throw error;
  }
  return result.data || [];
}

export function safeOkxSummary(message) {
  const text = String(message ?? "").trim();
  if (!text) return undefined;
  return text
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]")
    .replace(/\b(api.?key|secret|passphrase|token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9+/_=-]{24,}\b/g, "[TOKEN]")
    .replace(/\b\d{6,}\b/g, "[ID]")
    .slice(0, 160);
}

function classifyOkxMessage(message) {
  const text = String(message ?? "").trim().toLowerCase();
  if (!text) return "EMPTY";
  if (/rate.?limit|too many requests/.test(text)) return "RATE_LIMITED";
  if (/ip|whitelist/.test(text)) return "IP_RESTRICTED";
  if (/api.?key|passphrase|sign|auth/.test(text)) return "AUTHENTICATION";
  if (/permission|not allowed|forbidden/.test(text)) return "PERMISSION";
  if (/region|domain|jurisdiction/.test(text)) return "REGION_DOMAIN";
  if (/account mode|unsupported.*account/.test(text)) return "ACCOUNT_MODE";
  if (/parameter|invalid arg/.test(text)) return "PARAMETER";
  return "UNCLASSIFIED";
}

export function safeOkxFailure(error, { endpoint, durationMs, attempts } = {}) {
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? "");
  const httpStatus = Number.isInteger(error?.httpStatus) ? error.httpStatus : undefined;
  const okxCode = error?.okxCode === undefined ? undefined : String(error.okxCode);
  const okxMessageClass = error?.okxMessageClass;
  const okxSummary = error?.okxSummary;
  const responseClass = error?.responseClass ?? (/non-JSON/i.test(message) ? "NON_JSON" : undefined);
  const timeout = /timeout|timed out|abort/i.test(`${name} ${message}`);
  const network = /network|connect|connection|fetch|socket|econn|enotfound|eai_again/i.test(`${name} ${message}`);
  return {
    failureClass: timeout ? "TIMEOUT" : httpStatus ? "HTTP_ERROR" : okxCode ? "OKX_ERROR" : responseClass ? "RESPONSE_INVALID" : network ? "NETWORK_ERROR" : "UNCLASSIFIED",
    endpoint,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : undefined,
    attempts,
    httpStatus,
    okxCode,
    okxMessageClass,
    okxSummary,
    responseClass,
  };
}

function invalidOkxResponse(responseClass) {
  const error = new Error(`OKX response validation failed: ${responseClass}`);
  error.responseClass = responseClass;
  return error;
}

export function classifyBatchResponse(result, clOrdIds) {
  const byId = new Map((result?.data || []).filter((item) => item?.clOrdId).map((item) => [item.clOrdId, item]));
  return clOrdIds.map((clOrdId) => {
    const item = byId.get(clOrdId);
    if (!result || result.code !== "0" || !item) return { clOrdId, status: "UNKNOWN", reason: result?.msg || "MISSING_BATCH_ITEM" };
    if (item.sCode === "0") return { clOrdId, status: "SUBMITTED", ordId: item.ordId };
    if (typeof item.sCode === "string" && item.sCode) return { clOrdId, status: "NOT_CREATED", sCode: item.sCode, reason: item.sMsg || item.sCode };
    return { clOrdId, status: "UNKNOWN", reason: "INVALID_BATCH_ITEM" };
  });
}

export function validateAccountProfile({ config, spotInstruments = [], marginInstruments = [], enabledInstIds = [], allowUnavailable = false }) {
  const configRow = Array.isArray(config) ? config[0] : config;
  if (!configRow || String(configRow.acctLv) !== "3" || String(configRow.autoLoan).toLowerCase() !== "true") return { ready: false, reason: "ACCOUNT_PROFILE" };
  const spot = new Map(spotInstruments.map((row) => [row.instId, row]));
  const margin = new Map(marginInstruments.map((row) => [row.instId, row]));
  const quoteCurrency = new Map();
  const executionRoutes = new Map();
  const unavailable = [];
  for (const instId of enabledInstIds) {
    const spotRow = spot.get(instId);
    const marginRow = margin.get(instId);
    if (!spotRow || (spotRow.state && spotRow.state !== "live")) {
      if (allowUnavailable) { unavailable.push(instId); continue; }
      return { ready: false, reason: "ACCOUNT_INSTRUMENT", instId };
    }
    const currencies = String(marginRow?.tradeQuoteCcyList || "").split(",").filter(Boolean);
    const marginUsable = marginRow && (!marginRow.state || marginRow.state === "live") && (!currencies.length || currencies.includes("USDT"));
    if (!marginUsable) {
      executionRoutes.set(instId, "spot");
      quoteCurrency.set(instId, null);
      continue;
    }
    executionRoutes.set(instId, "margin");
    quoteCurrency.set(instId, currencies.length ? "USDT" : null);
  }
  return { ready: true, quoteCurrency, executionRoutes, unavailable };
}

export function classifyManagedFill(fill, order, { managedAfter, enabledInstIds, systemClOrdIdPrefix, strategyTag, attemptClOrdIds = [] }) {
  if (!fill || !enabledInstIds?.includes(fill.instId) || !["SPOT", "MARGIN"].includes(fill.instType) || !["buy", "sell"].includes(fill.side)) return null;
  if (Number(fill.fillTime) < Number(managedAfter) || !["cross", "cash"].includes(order?.tdMode)) return null;
  const inLedger = Boolean(order?.clOrdId && (attemptClOrdIds instanceof Set ? attemptClOrdIds.has(order.clOrdId) : attemptClOrdIds.includes(order.clOrdId)));
  const ownedPrefixAndTag = Boolean(order?.clOrdId && systemClOrdIdPrefix && strategyTag && order.clOrdId.startsWith(systemClOrdIdPrefix) && order.tag === strategyTag);
  return { source: inLedger || ownedPrefixAndTag ? "SYSTEM" : "ACCOUNT", instId: fill.instId, tradeId: fill.tradeId, side: fill.side, fillTime: fill.fillTime, billId: fill.billId, sz: fill.fillSz, executionMode: order.tdMode, executionRoute: order.tdMode === "cash" || fill.instType === "SPOT" ? "spot" : "margin" };
}

// Compatibility export for callers compiled against the original cross-only name.
export const classifyCrossFill = classifyManagedFill;

export class OkxRestClient {
  constructor({ credentials = {}, profile = OKX_PROFILES.GLOBAL, fetcher = fetch, clock = { nowMs: () => Date.now() }, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), requestGapMs = 0, timeoutMs = 15_000, slo = null } = {}) {
    if (!profile?.restUrl) throw new TypeError("OKX entity profile is required");
    this.credentials = credentials;
    this.profile = profile;
    this.fetcher = (...args) => fetcher(...args);
    this.clock = clock;
    this.sleep = sleep;
    this.requestGapMs = Math.max(0, requestGapMs);
    this.timeoutMs = timeoutMs;
    this.slo = slo;
    this.nextRequestAt = 0;
    this.clockSkewMs = 0;
    this.clockSyncedAt = 0;
  }

  async sign(text) {
    const secret = this.credentials.secretKey;
    if (!this.credentials.apiKey || !secret || !this.credentials.passphrase) throw new Error("OKX credentials are incomplete");
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return base64(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
  }

  async waitForSlot(path = "") {
    const now = this.clock.nowMs();
    const delay = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + this.requestGapMs;
    const started = this.clock.nowMs();
    if (delay) await this.sleep(delay);
    const waited = Math.max(0, this.clock.nowMs() - started);
    this.slo?.observe("rest_throttle_delay", delay);
    this.slo?.observe("rest_throttle_wait", waited);
    if (path === "/api/v5/account/max-avail-size") {
      this.slo?.observe("max_avail_throttle_delay", delay);
      this.slo?.observe("max_avail_throttle_wait", waited);
    }
    return { delay, waited };
  }

  async syncServerTime() {
    await this.waitForSlot("/api/v5/public/time");
    const before = this.clock.nowMs();
    const data = assertOkxResponse(await this.request("GET", "/api/v5/public/time", { authenticated: false, retryReads: 0, skipWait: true }));
    const after = this.clock.nowMs();
    const serverMs = Number(data[0]?.ts);
    if (!Number.isFinite(serverMs)) throw new Error("Invalid OKX server time");
    this.clockSkewMs = serverMs - Math.round((before + after) / 2);
    this.clockSyncedAt = after;
    return serverMs;
  }

  clockFresh(maxAgeMs = CLOCK_SYNC_STALE_AFTER_MS) {
    return this.clockSyncedAt > 0 && this.clock.nowMs() - this.clockSyncedAt <= maxAgeMs;
  }

  async request(method, path, { params, body, authenticated = true, expTime, retryReads = method === "GET" ? 3 : 0, skipWait = false } = {}) {
    const requestPath = `${path}${query(params)}`;
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const startedAt = this.clock.nowMs();
    let lastError; let attempts = 0;
    for (let attempt = 0; attempt <= retryReads; attempt += 1) {
      attempts = attempt + 1;
      try {
        if (!skipWait || attempt > 0) await this.waitForSlot(path);
        const headers = { Accept: "application/json", "Content-Type": "application/json" };
        if (authenticated) {
          const timestamp = new Date(this.clock.nowMs() + this.clockSkewMs).toISOString();
          Object.assign(headers, { "OK-ACCESS-KEY": this.credentials.apiKey, "OK-ACCESS-PASSPHRASE": this.credentials.passphrase, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-SIGN": await this.sign(`${timestamp}${method}${requestPath}${bodyText}`) });
        }
        if (expTime !== undefined) headers.expTime = String(expTime);
        const response = await this.fetcher(`${this.profile.restUrl}${requestPath}`, { method, headers, body: bodyText || undefined, signal: AbortSignal.timeout(this.timeoutMs) });
        const raw = await response.text();
        let result;
        try { result = JSON.parse(raw); } catch {
          const error = new Error(`OKX returned non-JSON HTTP ${response.status}`);
          error.httpStatus = response.status;
          error.responseClass = "NON_JSON";
          error.retryable = response.status === 429 || response.status >= 500;
          error.delay = retryAfter(response, this.clock.nowMs()) ?? Math.min(15_000, 1_000 * 2 ** attempt);
          throw error;
        }
        if (!response.ok || response.status === 429 || response.status >= 500 || result.code === "50011") {
          const error = new Error(`OKX HTTP ${response.status}: ${result.msg || raw.slice(0, 200)}`);
          error.httpStatus = response.status;
          if (result?.code !== undefined) { error.okxCode = String(result.code); error.okxMessageClass = classifyOkxMessage(result.msg); error.okxSummary = safeOkxSummary(result.msg); }
          error.retryable = response.status === 429 || response.status >= 500 || result.code === "50011";
          error.delay = retryAfter(response, this.clock.nowMs()) ?? Math.min(15_000, 1_000 * 2 ** attempt);
          throw error;
        }
        return result;
      } catch (error) {
        lastError = error;
        if (method === "GET" && error.retryable === undefined) {
          error.retryable = true;
          error.delay = Math.min(15_000, 1_000 * 2 ** attempt);
        }
        if (attempt === retryReads || !error.retryable) break;
        await this.sleep(error.delay);
      }
    }
    lastError.diagnostic ??= safeOkxFailure(lastError, { endpoint: path, durationMs: this.clock.nowMs() - startedAt, attempts });
    throw lastError;
  }

  async read(path, params = {}, authenticated = true) {
    const startedAt = this.clock.nowMs();
    try { return assertOkxResponse(await this.request("GET", path, { params, authenticated })); }
    catch (error) {
      error.diagnostic ??= safeOkxFailure(error, { endpoint: path, durationMs: this.clock.nowMs() - startedAt, attempts: 1 });
      throw error;
    }
  }
  async submitBatchOrders(orders, expTime) {
    if (!Array.isArray(orders) || orders.length < 1 || orders.length > 5) throw new RangeError("batch must contain 1 to 5 orders");
    const clOrdIds = orders.map((order) => order.clOrdId);
    if (new Set(clOrdIds).size !== clOrdIds.length || clOrdIds.some((id) => !id)) throw new Error("batch requires unique clOrdId values");
    try { return classifyBatchResponse(await this.request("POST", "/api/v5/trade/batch-orders", { body: orders, expTime, retryReads: 0 }), clOrdIds); }
    catch (error) { return clOrdIds.map((clOrdId) => ({ clOrdId, status: "UNKNOWN", reason: error.message })); }
  }

  systemStatus() { return this.read("/api/v5/system/status", {}, false); }
  publicInstruments(instType = "SPOT") { return this.read("/api/v5/public/instruments", { instType }, false); }
  tickers(instType = "SPOT") { return this.read("/api/v5/market/tickers", { instType }, false); }
  candles(instId, { bar = "3m", limit, after, before } = {}) { return this.read("/api/v5/market/candles", { instId, bar, limit, after, before }, false); }
  announcements(page) { return this.read("/api/v5/support/announcements", { annType: "announcements-delistings", page }, false); }
  accountInstruments(instType) { return this.read("/api/v5/account/instruments", { instType }); }
  accountConfig() { return this.read("/api/v5/account/config"); }
  balance(ccy) { return this.read("/api/v5/account/balance", ccy ? { ccy } : {}); }
  leverageInfo(instId) { return this.read("/api/v5/account/leverage-info", { instId, mgnMode: "cross" }); }
  async maxAvailSize(instId, { tdMode = "cross", ccy, reduceOnly } = {}) {
    const endpoint = "/api/v5/account/max-avail-size";
    const startedAt = this.clock.nowMs();
    try {
      const data = await this.read(endpoint, { instId, tdMode, ccy, reduceOnly });
      const expected = new Set(String(instId).split(","));
      if (!Array.isArray(data) || !data.length) throw invalidOkxResponse("EMPTY_DATA");
      if (data.some((row) => !row || typeof row.instId !== "string" || !expected.has(row.instId) || typeof row.availBuy !== "string" || typeof row.availSell !== "string")) throw invalidOkxResponse("INVALID_AVAILABILITY_ITEM");
      return data;
    } catch (error) {
      error.diagnostic ??= safeOkxFailure(error, { endpoint, durationMs: this.clock.nowMs() - startedAt, attempts: 1 });
      throw error;
    }
  }
  async order({ instId, ordId, clOrdId }) { return (await this.read("/api/v5/trade/order", { instId, ordId, clOrdId }))[0] ?? { state: "NOT_FOUND", instId, ordId, clOrdId }; }
  ordersPending(instType, params = {}) { return this.read("/api/v5/trade/orders-pending", { ...params, instType }); }
  ordersHistory(instType, params = {}) { return this.read("/api/v5/trade/orders-history", { ...params, instType }); }
  ordersHistoryArchive(instType, params = {}) { return this.read("/api/v5/trade/orders-history-archive", { ...params, instType }); }
  fills(instType, params = {}) { return this.read("/api/v5/trade/fills", { instType, ...params }); }
  fillsHistory(instType, params = {}) { return this.read("/api/v5/trade/fills-history", { instType, ...params }); }
}
