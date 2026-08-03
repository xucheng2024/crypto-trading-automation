import { ALLOWED_TASKS, CRON_TASKS, flagsForCron, tradingEnabled } from "./config.js";
import { logRun } from "./db.js";
import { OKXClient } from "./okx.js";
import { TASKS } from "./tasks.js";

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

async function claimRun(env, runKey) {
  const id = env.CRON_DEDUP.idFromName("scheduled-runs");
  const stub = env.CRON_DEDUP.get(id);
  const response = await stub.fetch("https://coordinator/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runKey }),
  });
  return { stub, response, data: await response.json() };
}

async function runScheduled(event, env) {
  const tasks = event.scripts || CRON_TASKS.get(event.cron);
  if (!tasks) return { ignored: true, cron: event.cron };
  const scheduledTime = Number(event.scheduledTime || Date.now());
  const minute = Math.floor(scheduledTime / 60_000);
  const runKey = `${event.cron}:${tasks.join(",")}:${minute}`;
  const claim = await claimRun(env, runKey);
  if (!claim.response.ok || !claim.data.claimed) return { duplicate: true, runKey };
  try {
    const results = await executeTasks(env, tasks, { ...flagsForCron(event.cron), ...(event.options || {}) }, runKey);
    return { runKey, tasks, results };
  } finally {
    await claim.stub.fetch("https://coordinator/release", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runKey, action: "release" }),
    });
  }
}

export class CronDeduplicator {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const { runKey, action = "claim" } = await request.json();
    if (!runKey) return json({ error: "runKey is required" }, 400);
    const claimed = await this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const runs = (await txn.get("runs")) || {};
      for (const [key, expiresAt] of Object.entries(runs)) if (expiresAt <= now) delete runs[key];
      if (action === "release") delete runs[runKey];
      else if (Object.keys(runs).length || runs[runKey]) return false;
      else runs[runKey] = now + 15 * 60 * 1000;
      await txn.put("runs", runs);
      return true;
    });
    return json({ claimed });
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
      try {
        const okx = new OKXClient(env);
        const balances = await okx.balances();
        return json({ ok: true, authenticated: true, accountRows: balances.length, tradingEnabled: tradingEnabled(env) });
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
      return json(await runScheduled({ cron: "manual", scripts: tasks, options: payload.options || {}, scheduledTime: Date.now() }, env));
    } catch (error) {
      return json({ error: error.message }, 500);
    }
  },
};

export { executeTasks, runScheduled };
