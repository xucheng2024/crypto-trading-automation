const encoder = new TextEncoder();

function toBase64(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}

function operationError(result, requireData = false) {
  if (!result || result.code !== "0") return result?.msg || `OKX code ${result?.code || "empty response"}`;
  if (requireData && (!Array.isArray(result.data) || result.data.length === 0)) return "OKX response has no mutation result";
  for (const item of result.data || []) {
    if (item.sCode && item.sCode !== "0") return item.sMsg || `OKX order code ${item.sCode}`;
  }
  return null;
}

export class OKXClient {
  constructor(env, fetcher = fetch, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.apiKey = env.OKX_API_KEY;
    this.secretKey = env.OKX_SECRET_KEY;
    this.passphrase = env.OKX_PASSPHRASE;
    this.demo = String(env.OKX_TESTNET || "false").toLowerCase() === "true";
    // Cloudflare's native fetch must not be invoked with this client as its
    // receiver ("Illegal invocation").  The arrow wrapper preserves an
    // unbound call while still allowing a fetch implementation in tests.
    this.fetcher = (...args) => fetcher(...args);
    this.baseUrl = "https://www.okx.com";
    this.sleep = sleepFn;
    // A task uses one client and scheduled tasks are serialized by the DO.
    // Keep the per-task request rate deliberately below OKX's public limits.
    this.requestGapMs = Math.max(0, Number(env.OKX_REQUEST_GAP_MS || 0));
    this.nextRequestAt = 0;
  }

  assertConfigured() {
    const missing = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"].filter((name) => !this[{ OKX_API_KEY: "apiKey", OKX_SECRET_KEY: "secretKey", OKX_PASSPHRASE: "passphrase" }[name]]);
    if (missing.length) throw new Error(`Missing Cloudflare secrets: ${missing.join(", ")}`);
  }

  async sign(payload) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(this.secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return toBase64(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  }

  async waitForRequestSlot() {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(this.nextRequestAt, now) + this.requestGapMs;
    if (waitMs) await this.sleep(waitMs);
  }

  retryDelay(response, attempt) {
    const value = response?.headers?.get("retry-after");
    if (value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
      const dateMs = Date.parse(value);
      if (Number.isFinite(dateMs)) return Math.min(30_000, Math.max(0, dateMs - Date.now()));
    }
    return Math.min(15_000, 2_000 * (2 ** attempt));
  }

  async request(method, path, { params, body, auth = true, retries = 3 } = {}) {
    if (auth) this.assertConfigured();
    const qs = queryString(params);
    const requestPath = `${path}${qs}`;
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.waitForRequestSlot();
        const headers = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "crypto-trading-cloudflare/1.0" };
        if (auth) {
          const timestamp = new Date().toISOString();
          Object.assign(headers, {
            "OK-ACCESS-KEY": this.apiKey,
            "OK-ACCESS-SIGN": await this.sign(`${timestamp}${method}${requestPath}${bodyText}`),
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": this.passphrase,
          });
          if (this.demo) headers["x-simulated-trading"] = "1";
        }
        const response = await this.fetcher(`${this.baseUrl}${requestPath}`, {
          method,
          headers,
          body: bodyText || undefined,
          signal: AbortSignal.timeout(15_000),
        });
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); } catch {
          const error = new Error(`OKX returned non-JSON HTTP ${response.status}`);
          error.retryable = response.status === 429 || response.status >= 500;
          error.okxRateLimited = response.status === 429;
          error.retryDelayMs = this.retryDelay(response, attempt);
          throw error;
        }
        if (!response.ok || response.status === 429 || response.status >= 500) {
          const error = new Error(`OKX HTTP ${response.status}: ${result.msg || text.slice(0, 200)}`);
          error.retryable = response.status === 429 || response.status >= 500;
          error.okxRateLimited = response.status === 429;
          error.retryDelayMs = this.retryDelay(response, attempt);
          throw error;
        }
        if (result.code === "50011") {
          const error = new Error(`OKX rate limited: ${result.msg || result.code}`);
          error.retryable = true;
          error.okxRateLimited = true;
          error.retryDelayMs = this.retryDelay(response, attempt);
          throw error;
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt === retries || !error.retryable) break;
        await this.sleep(error.retryDelayMs ?? Math.min(15_000, 2_000 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  get(path, params, auth = true) { return this.request("GET", path, { params, auth, retries: 3 }); }
  post(path, body, { retries = 0 } = {}) { return this.request("POST", path, { body, auth: true, retries }); }

  async requireSuccess(result, { requireData = false, operation = "OKX operation" } = {}) {
    const error = operationError(result, requireData);
    if (error) throw new Error(`${operation} failed: ${error}`);
    return result.data || [];
  }

  async balances(currency) {
    const result = await this.get("/api/v5/account/balance", currency ? { ccy: currency } : {});
    return this.requireSuccess(result, { requireData: true, operation: "balance query" });
  }

  async pendingLimits() {
    return this.paginatedGet("/api/v5/trade/orders-pending", { instType: "SPOT" }, "ordId", "pending limit query");
  }

  async pendingTriggers(limit = 100) {
    return this.paginatedGet("/api/v5/trade/orders-algo-pending", { ordType: "trigger", limit }, "algoId", "pending trigger query");
  }

  async paginatedGet(path, params, cursorField, operation, maxPages = 20) {
    const rows = [];
    let after;
    const pageLimit = Math.min(100, Number(params.limit || 100));
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.get(path, { ...params, limit: pageLimit, after });
      const data = await this.requireSuccess(result, { operation });
      rows.push(...data);
      if (data.length < pageLimit) return rows;
      const next = data.at(-1)?.[cursorField];
      if (!next || next === after) throw new Error(`${operation} pagination cursor did not advance`);
      after = next;
    }
    throw new Error(`${operation} exceeded ${maxPages} pages`);
  }

  async fillsSince(begin) {
    return this.paginatedGet("/api/v5/trade/fills", { instType: "SPOT", begin, limit: 100 }, "billId", "filled trade query", 50);
  }

  async cancelLimit(instId, ordId) {
    const result = await this.post("/api/v5/trade/cancel-order", { instId, ordId });
    await this.requireSuccess(result, { requireData: true, operation: `cancel limit ${instId}/${ordId}` });
  }

  async cancelLimits(orders) {
    if (!orders.length) return;
    const result = await this.post("/api/v5/trade/cancel-batch-orders", orders.map(({ instId, ordId }) => ({ instId, ordId })));
    await this.requireSuccess(result, { requireData: true, operation: "cancel limit batch" });
  }

  async cancelTriggers(orders) {
    if (!orders.length) return;
    const result = await this.post("/api/v5/trade/cancel-algos", orders.map(({ instId, algoId }) => ({ instId, algoId })));
    await this.requireSuccess(result, { requireData: true, operation: "cancel trigger batch" });
  }

  async placeOrder(payload) {
    const result = await this.post("/api/v5/trade/order", payload);
    return (await this.requireSuccess(result, { requireData: true, operation: `place ${payload.side} order` }))[0];
  }

  async placeAlgo(payload) {
    const result = await this.post("/api/v5/trade/order-algo", payload);
    return (await this.requireSuccess(result, { requireData: true, operation: "place trigger order" }))[0];
  }
}

export { operationError };
