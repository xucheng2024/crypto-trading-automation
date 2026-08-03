import { logRun } from "../src/db.js";
import { OKXClient } from "../src/okx.js";
import { cancelPendingTriggers, createAlgoTriggers } from "../src/tasks.js";
import { D1HttpDatabase } from "./d1-http-client.mjs";

const mode = process.argv[2] || process.env.TRIGGER_MODE || "rebuild";
if (!new Set(["cancel", "rebuild"]).has(mode)) throw new Error("TRIGGER_MODE must be cancel or rebuild");

const env = {
  OKX_API_KEY: process.env.OKX_API_KEY,
  OKX_SECRET_KEY: process.env.OKX_SECRET_KEY,
  OKX_PASSPHRASE: process.env.OKX_PASSPHRASE,
  OKX_TESTNET: process.env.OKX_TESTNET || "false",
  OKX_ORDER_SIZE: process.env.OKX_ORDER_SIZE,
  // GitHub Actions has dedicated task concurrency and is not using Cloudflare's
  // shared Worker egress.  The creation pool itself remains conservative.
  OKX_REQUEST_GAP_MS: process.env.OKX_REQUEST_GAP_MS || "0",
};
const db = new D1HttpDatabase({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  apiToken: process.env.CLOUDFLARE_D1_API_TOKEN,
});
env.DB = db;
const okx = new OKXClient(env);
okx.assertConfigured();
if (!env.OKX_ORDER_SIZE) throw new Error("Missing OKX_ORDER_SIZE");

const runId = `github:${mode}:${process.env.GITHUB_RUN_ID || Date.now()}`;

async function runTask(task, fn) {
  await logRun(db, runId, task, "RUNNING");
  try {
    const result = await fn();
    await logRun(db, runId, task, "SUCCEEDED", JSON.stringify(result).slice(0, 2000));
    return result;
  } catch (error) {
    await logRun(db, runId, task, "FAILED", String(error.stack || error).slice(0, 2000));
    throw error;
  }
}

const result = {};
if (mode === "cancel") {
  result.cancel = await runTask("cancel_pending_triggers", () => cancelPendingTriggers(okx, { side: "buy" }));
} else {
  result.cancel = await runTask("cancel_pending_triggers", () => cancelPendingTriggers(okx, { side: "buy" }));
  result.create = await runTask("create_algo_triggers", () => createAlgoTriggers(env, okx, {
    clearRebuildPending: true,
    concurrency: Number(process.env.TRIGGER_REBUILD_CONCURRENCY || "4"),
    pauseMs: Number(process.env.TRIGGER_REBUILD_PAUSE_MS || "0"),
  }));
}
console.log(JSON.stringify({ runId, mode, result }));
