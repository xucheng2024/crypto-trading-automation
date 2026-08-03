import { ALLOWED_TASKS, CRON_TASKS, flagsForCron, tradingEnabled } from "./config.js";
import { logRun } from "./db.js";
import { OKXClient } from "./okx.js";
import { fetchDelistAnnouncements, TASKS } from "./tasks.js";

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

async function executeTasks(env, tasks, options, runId) {
  if (!tradingEnabled(env)) return { paused: true, message: "TRADING_ENABLED is not true; no OKX or D1 mutations executed" };
  const okx = new OKXClient(env);
  okx.assertConfigured();
  const results = {};
  const failures = [];
  for (const task of tasks) {
    await logRun(env.DB, runId, task, "RUNNING");
    try {
      results[task] = await TASKS[task](env, okx, options);
      await logRun(env.DB, runId, task, "SUCCEEDED", JSON.stringify(results[task]).slice(0, 2000));
    } catch (error) {
      await logRun(env.DB, runId, task, "FAILED", String(error.stack || error).slice(0, 2000));
      failures.push(`${task}: ${error.message}`);
      results[task] = { error: error.message };
    }
  }
  if (failures.length) throw new AggregateError(failures.map((message) => new Error(message)), failures.join("; "));
  return results;
}

async function enqueueRun(env, runKey, tasks, options, { skipIfBusy = false } = {}) {
  const id = env.CRON_DEDUP.idFromName("scheduled-runs");
  const stub = env.CRON_DEDUP.get(id);
  const response = await stub.fetch("https://coordinator/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runKey, tasks, options, skipIfBusy }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Trading queue failed with HTTP ${response.status}`);
  return data;
}

async function runScheduled(event, env) {
  const tasks = event.scripts || CRON_TASKS.get(event.cron);
  if (!tasks) return { ignored: true, cron: event.cron };
  const scheduledTime = Number(event.scheduledTime || Date.now());
  const minute = Math.floor(scheduledTime / 60_000);
  const runKey = `${event.cron}:${tasks.join(",")}:${minute}`;
  // A late run is not useful: the following normal Cron catches the latest
  // state, while a backlog can delay protection and sell reconciliation.
  return enqueueRun(env, runKey, tasks, { ...flagsForCron(event.cron, scheduledTime), ...(event.options || {}) }, { skipIfBusy: true });
}

async function validateOkx(env, scope = "all") {
  const okx = new OKXClient(env);
  const checks = {};
  if (scope === "all" || scope === "account") {
    const balances = await okx.balances();
    checks.account = balances.length;
  }
  if (scope === "all" || scope === "pending_limits") checks.pendingLimits = (await okx.pendingLimits()).length;
  if (scope === "all" || scope === "pending_triggers") checks.pendingTriggers = (await okx.pendingTriggers()).length;
  if (scope === "all" || scope === "fills") checks.recentFills = (await okx.fillsSince(Date.now() - 15 * 60_000)).length;
  if (scope === "all" || scope === "instruments") {
    const result = await okx.get("/api/v5/public/instruments", { instType: "SPOT", instId: "BTC-USDT" }, false);
    await okx.requireSuccess(result, { requireData: true, operation: "public instrument validation" });
    checks.instruments = true;
  }
  if (scope === "all" || scope === "candles") {
    const result = await okx.get("/api/v5/market/candles", { instId: "BTC-USDT", bar: "1D", limit: 2 }, false);
    await okx.requireSuccess(result, { requireData: true, operation: "candle validation" });
    checks.candles = true;
  }
  if (scope === "all" || scope === "ticker") {
    const result = await okx.get("/api/v5/market/ticker", { instId: "BTC-USDT" }, false);
    await okx.requireSuccess(result, { requireData: true, operation: "ticker validation" });
    checks.ticker = true;
  }
  if (scope === "all" || scope === "announcements") {
    checks.announcements = (await fetchDelistAnnouncements(okx)).length;
  }
  if (scope === "all" || scope === "d1") {
    const config = await env.DB.prepare("SELECT COUNT(*) AS count FROM crypto_limits").first();
    checks.d1Configs = config?.count || 0;
  }
  return checks;
}

export class CronDeduplicator {
  constructor(ctx, env, runner = executeTasks) {
    this.ctx = ctx;
    this.env = env;
    this.runner = runner;
    this.tail = Promise.resolve();
    this.queueDepth = 0;
  }

  async fetch(request) {
    const { runKey, tasks, options = {}, skipIfBusy = false } = await request.json();
    if (!runKey || !Array.isArray(tasks) || !tasks.length) return json({ error: "runKey and tasks are required" }, 400);
    if (skipIfBusy && this.queueDepth) return json({ skippedBusy: true, runKey });
    // Reserve synchronously before the first await so concurrent Cron fetches
    // cannot both see an idle coordinator and form a backlog.
    this.queueDepth += 1;
    let claimed;
    try {
      claimed = await this.ctx.storage.transaction(async (txn) => {
        const now = Date.now();
        const runs = (await txn.get("runs")) || {};
        for (const [key, expiresAt] of Object.entries(runs)) if (expiresAt <= now) delete runs[key];
        if (runs[runKey]) return false;
        runs[runKey] = now + 24 * 60 * 60 * 1000;
        await txn.put("runs", runs);
        return true;
      });
    } catch (error) {
      this.queueDepth -= 1;
      throw error;
    }
    if (!claimed) {
      this.queueDepth -= 1;
      return json({ duplicate: true, runKey });
    }

    const execute = this.tail.then(async () => ({
      runKey,
      tasks,
      results: await this.runner(this.env, tasks, options, runKey),
    })).finally(() => { this.queueDepth -= 1; });
    this.tail = execute.catch(() => undefined);
    try {
      return json(await execute);
    } catch (error) {
      return json({ error: error.message, runKey }, 500);
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env).then((result) => console.log("Trading run complete", JSON.stringify(result))).catch((error) => { console.error("Trading run failed", error.stack || error); throw error; }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      const latest = env.DB ? await env.DB.prepare("SELECT task,status,updated_at FROM task_runs ORDER BY updated_at DESC LIMIT 10").all().catch(() => ({ results: [] })) : { results: [] };
      return json({ service: "crypto-trading-cloudflare", status: "ok", tradingEnabled: tradingEnabled(env), storage: "D1", scheduler: "Cloudflare Cron", latestRuns: latest.results || [] });
    }
    if (request.method === "POST" && url.pathname === "/validate-okx") {
      if (!env.MANUAL_TRIGGER_TOKEN || request.headers.get("authorization") !== `Bearer ${env.MANUAL_TRIGGER_TOKEN}`) return json({ error: "Unauthorized" }, 401);
      // A diagnostic used to make seven extra calls concurrently with a cron.
      // Keep it strictly off the live path; use health/task_runs while enabled.
      if (tradingEnabled(env)) return json({ error: "Validation is disabled while live trading is enabled" }, 409);
      const scope = url.searchParams.get("scope") || "all";
      const allowedScopes = new Set(["all", "account", "pending_limits", "pending_triggers", "fills", "instruments", "candles", "ticker", "announcements", "d1"]);
      if (!allowedScopes.has(scope)) return json({ error: "Invalid validation scope" }, 400);
      try {
        const checks = await validateOkx(env, scope);
        return json({
          ok: true,
          authenticated: true,
          tradingEnabled: tradingEnabled(env),
          scope,
          checks,
        });
      } catch (error) {
        return json({ ok: false, authenticated: false, error: error.message, tradingEnabled: tradingEnabled(env) }, 503);
      }
    }
    if (request.method !== "POST" || url.pathname !== "/run") return json({ error: "Not found" }, 404);
    if (!env.MANUAL_TRIGGER_TOKEN || request.headers.get("authorization") !== `Bearer ${env.MANUAL_TRIGGER_TOKEN}`) return json({ error: "Unauthorized" }, 401);
    let payload;
    try { payload = await request.json(); } catch { return json({ error: "Expected JSON body" }, 400); }
    const tasks = payload?.tasks || payload?.scripts;
    if (!Array.isArray(tasks) || !tasks.length || tasks.some((task) => !ALLOWED_TASKS.has(task))) return json({ error: "Invalid tasks" }, 400);
    try {
      const result = await runScheduled({ cron: "manual", scripts: tasks, options: payload.options || {}, scheduledTime: Date.now() }, env);
      return json(result, result.skippedBusy ? 409 : 200);
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  },
};

export { executeTasks, runScheduled, validateOkx };
