import http from "node:http";
import os from "node:os";
import { statfs } from "node:fs/promises";
import pg from "pg";
import { compareDecimal, divideDecimal, multiplyDecimal, subtractDecimal } from "../../decimal.js";
import { createApplicationInsightsTelemetry } from "../../infrastructure/azure/application-insights-telemetry.js";

export const OBSERVATION_SYMBOLS = Object.freeze(["BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT", "XRP-USDT", "ADA-USDT", "DOGE-USDT", "AVAX-USDT", "LINK-USDT", "LTC-USDT"]);
export const SAVE_OBSERVATIONS_SQL = `INSERT INTO market_observations (inst_id,sampled_at,price,open_24h,change_pct)
  SELECT * FROM unnest($1::text[],$2::timestamptz[],$3::numeric[],$4::numeric[],$5::numeric[])
  ON CONFLICT (inst_id,sampled_at) DO NOTHING`;
export const LATEST_OBSERVATIONS_SQL = `SELECT DISTINCT ON (inst_id) inst_id,sampled_at,price::text,open_24h::text,change_pct::text
  FROM market_observations ORDER BY inst_id,sampled_at DESC`;

export function normalizeObservations(tickers, symbols = OBSERVATION_SYMBOLS, nowMs = Date.now()) {
  const wanted = new Set(symbols); const rows = []; let invalid = 0;
  for (const row of tickers ?? []) {
    if (!wanted.has(row.instId)) continue;
    try {
      const ts = Number(row.ts);
      if (!Number.isSafeInteger(ts) || ts <= 0 || ts > nowMs + 60_000 || compareDecimal(row.last, "0") <= 0 || compareDecimal(row.open24h, "0") <= 0) throw new Error("INVALID_TICKER");
      rows.push({ instId: row.instId, sampledAt: new Date(ts).toISOString(), price: row.last, open24h: row.open24h, changePct: multiplyDecimal(divideDecimal(subtractDecimal(row.last, row.open24h), row.open24h), "100") });
      wanted.delete(row.instId);
    } catch { invalid += 1; }
  }
  return { rows, missing: wanted.size, invalid };
}

export async function saveObservations(pool, rows) {
  if (!rows.length) return 0;
  const result = await pool.query(SAVE_OBSERVATIONS_SQL, [rows.map((r) => r.instId), rows.map((r) => r.sampledAt), rows.map((r) => r.price), rows.map((r) => r.open24h), rows.map((r) => r.changePct)]);
  return result.rowCount;
}

export function statusPage(apiUrl) {
  const endpoint = JSON.stringify(`${apiUrl.replace(/\/$/, "")}/api/status`).replaceAll("<", "\\u003c");
  return String.raw`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>行情观察</title><style>body{font:16px system-ui;background:#111827;color:#eee;max-width:760px;margin:5vh auto;padding:20px}h1{font-size:28px}p{color:#a8b4c8}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px 4px;border-bottom:1px solid #334155}th{color:#a8b4c8}.up{color:#5ee7a0}.down{color:#fb8a8a}</style><h1>行情观察</h1><p>只采集公开行情，不连接交易账户，不提交订单。</p><p id="health">正在读取状态…</p><table><thead><tr><th>币种</th><th>价格 · USDT</th><th>24h 涨跌</th></tr></thead><tbody id="rows"></tbody></table><p id="updated"></p><script>async function update(){try{const r=await fetch(__ENDPOINT__);if(!r.ok)throw Error();const s=await r.json();document.getElementById('health').textContent=s.ready?'采集正常 · 数据库正常 · 下单禁用':'正在恢复采集';const body=document.getElementById('rows');body.replaceChildren();for(const row of s.observations){const tr=document.createElement('tr');for(const value of [row.inst_id,row.price,Number(row.change_pct).toFixed(2)+'%']){const td=document.createElement('td');td.textContent=value;tr.appendChild(td)}tr.lastChild.className=Number(row.change_pct)>=0?'up':'down';body.appendChild(tr)}document.getElementById('updated').textContent='更新时间：'+new Date(s.updatedAt).toLocaleString()}catch{document.getElementById('health').textContent='状态暂不可用'}}update();setInterval(update,60000)</script></html>`.replace("__ENDPOINT__", endpoint);
}

export function createObserverServers({ pool, state, apiUrl, webPort = 8080, apiPort = 8081 }) {
  const respond = (response, code, body, type = "application/json") => { response.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" }); response.end(body); };
  const allowedMethod = (request, response) => { if (["GET", "HEAD"].includes(request.method)) return true; response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return false; };
  const live = (response) => respond(response, 200, JSON.stringify({ live: true, mode: "OBSERVE", orderExecutionEnabled: false }));
  const web = http.createServer((request, response) => {
    if (!allowedMethod(request, response)) return;
    if (request.url === "/health/live") return live(response);
    if (request.url !== "/") return respond(response, 404, "{}");
    respond(response, 200, statusPage(apiUrl), "text/html; charset=utf-8");
  }).listen(webPort, "0.0.0.0");
  const api = http.createServer(async (request, response) => {
    if (!allowedMethod(request, response)) return;
    if (request.url === "/health/live") return live(response);
    if (request.url !== "/api/status") return respond(response, 404, "{}");
    try {
      const result = await pool.query(LATEST_OBSERVATIONS_SQL);
      respond(response, 200, JSON.stringify({ live: true, ready: state.databaseOk && result.rows.length === OBSERVATION_SYMBOLS.length && Date.now() - state.lastSuccessAt < 120_000, mode: "OBSERVE", orderExecutionEnabled: false, updatedAt: new Date(state.lastSuccessAt || 0).toISOString(), observations: result.rows }));
    } catch { state.httpErrors += 1; respond(response, 503, JSON.stringify({ ready: false, error: "DATABASE_UNAVAILABLE" })); }
  }).listen(apiPort, "0.0.0.0");
  return { web, api, close: async () => Promise.all([web, api].map((server) => new Promise((resolve) => server.close(resolve)))) };
}

export async function startMarketObserver(env = process.env) {
  if (env.ORDER_EXECUTION_ENABLED !== "false") throw new Error("Market observation requires ORDER_EXECUTION_ENABLED=false");
  if (!env.OBSERVATION_POSTGRES_HOST || !env.OBSERVATION_POSTGRES_PASSWORD || !env.MARKET_API_URL) throw new Error("Observation configuration is incomplete");
  const pool = new pg.Pool({ host: env.OBSERVATION_POSTGRES_HOST, database: "observation", user: "observeradmin", password: env.OBSERVATION_POSTGRES_PASSWORD, ssl: { rejectUnauthorized: true }, max: 3, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  const telemetry = createApplicationInsightsTelemetry({ connectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING, environment: "milestone-observation", serviceName: "market-observer", tradingMode: "OBSERVE" });
  const state = { databaseOk: false, lastSuccessAt: 0, httpErrors: 0 }; let running = false; let collecting; let stopping; let lastRetentionDay = "";
  pool.on("error", () => { state.databaseOk = false; });
  const servers = createObserverServers({ pool, state, apiUrl: env.MARKET_API_URL });
  const collect = async () => {
    if (running) return;
    running = true;
    let writingDatabase = false;
    const metrics = { order_execution_enabled: 0, market_missing_symbols: OBSERVATION_SYMBOLS.length, invalid_rows: 0, database_ok: Number(state.databaseOk), api_read_errors: 0, retention_errors: 0, database_latency_ms: 0 };
    try {
      const response = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("PUBLIC_MARKET_UNAVAILABLE");
      const payload = await response.json(); if (payload.code !== "0" || !Array.isArray(payload.data)) throw new Error("PUBLIC_MARKET_INVALID");
      const sample = normalizeObservations(payload.data); metrics.market_missing_symbols = sample.missing; metrics.invalid_rows = sample.invalid;
      writingDatabase = true;
      const started = Date.now(); await saveObservations(pool, sample.rows); metrics.database_latency_ms = Date.now() - started;
      writingDatabase = false;
      metrics.database_ok = 1; state.databaseOk = true;
      if (!sample.missing && !sample.invalid) state.lastSuccessAt = Math.min(...sample.rows.map((row) => Date.parse(row.sampledAt)));
      const day = new Date().toISOString().slice(0, 10);
      if (lastRetentionDay !== day) {
        try { await pool.query("DELETE FROM market_observations WHERE sampled_at < now() - interval '7 days'"); lastRetentionDay = day; }
        catch { metrics.retention_errors = 1; }
      }
    } catch {
      if (writingDatabase) { state.databaseOk = false; metrics.database_ok = 0; }
      else metrics.api_read_errors = 1;
    }
    finally {
      metrics.market_age_ms = state.lastSuccessAt ? Date.now() - state.lastSuccessAt : 120_001;
      metrics.http_errors = state.httpErrors; state.httpErrors = 0;
      metrics.cpu_load_pct = os.loadavg()[0] / os.cpus().length * 100;
      metrics.memory_used_pct = (1 - os.freemem() / os.totalmem()) * 100;
      try { const disk = await statfs("/"); metrics.disk_used_pct = (1 - disk.bavail / disk.blocks) * 100; } catch { /* the heartbeat remains available */ }
      telemetry({ type: "metric_snapshot", reason: "RUNTIME_METRICS", ...metrics });
      running = false;
    }
  };
  const beginCollection = () => { if (!running) collecting = collect(); };
  const timer = setInterval(beginCollection, 60_000); beginCollection();
  const stop = () => stopping ??= (async () => { clearInterval(timer); await collecting; await servers.close(); await pool.end(); await telemetry.flush(); await telemetry.shutdown(); })();
  process.once("SIGTERM", () => void stop()); process.once("SIGINT", () => void stop());
  return { state, servers, stop };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) await startMarketObserver();
