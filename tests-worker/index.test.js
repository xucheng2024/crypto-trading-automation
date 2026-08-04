import assert from "node:assert/strict";
import test from "node:test";

import { CronDeduplicator, executeTasks } from "../src/index.js";
import { flagsForCron } from "../src/config.js";

test("safe default pauses before credentials, APIs, or database writes", async () => {
  const result = await executeTasks({}, ["fetch_filled_orders"], {}, "test");
  assert.equal(result.paused, true);
});

test("OKX cooldown defers every task without constructing a client", async () => {
  const logs = [];
  const db = {
    prepare: () => ({
      bind: (...values) => ({ run: async () => { logs.push(values); return { meta: { changes: 1 } }; } }),
    }),
  };
  const result = await executeTasks({ TRADING_ENABLED: "true", DB: db }, ["auto_sell_orders", "fetch_filled_orders"], { deferUntil: Date.now() + 60_000 }, "rate-limit-test");
  assert.equal(result.deferred, true);
  assert.deepEqual(logs.map((values) => values[2]), ["DEFERRED", "DEFERRED"]);
});

test("rate-limited runs persist a coordinator cooldown", async () => {
  const values = {};
  const ctx = {
    storage: {
      get: async (key) => values[key],
      put: async (key, value) => { values[key] = value; },
      transaction: async (callback) => callback({
        get: async () => ({}),
        put: async () => {},
      }),
    },
  };
  const runner = async () => {
    const error = new Error("rate limited");
    error.okxRateLimited = true;
    throw error;
  };
  const coordinator = new CronDeduplicator(ctx, {}, runner);
  const response = await coordinator.fetch(new Request("https://coordinator/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runKey: "rate-limited", tasks: ["fetch_filled_orders"] }),
  }));
  assert.equal(response.status, 500);
  assert.ok(values.okxCooldownUntil > Date.now());
});

test("scheduled runs skip while manual runs queue, while true duplicate keys are rejected", async () => {
  let storedRuns = {};
  const durableValues = {};
  const ctx = {
    storage: {
      get: async (key) => durableValues[key],
      put: async (key, value) => { durableValues[key] = value; },
      transaction: async (callback) => callback({
        get: async () => storedRuns,
        put: async (_key, value) => { storedRuns = value; },
      }),
    },
  };
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const runner = async (_env, _tasks, _options, runKey) => {
    events.push(`start:${runKey}`);
    if (runKey === "first") await firstGate;
    events.push(`end:${runKey}`);
    return { ok: true };
  };
  const coordinator = new CronDeduplicator(ctx, {}, runner);
  const request = (runKey, skipIfBusy = false) => new Request("https://coordinator/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runKey, tasks: ["fetch_filled_orders"], skipIfBusy }),
  });

  const first = coordinator.fetch(request("first", true));
  await Promise.resolve();
  const second = await coordinator.fetch(request("second", true));
  assert.deepEqual(await second.json(), { skippedBusy: true, runKey: "second" });

  const manual = coordinator.fetch(request("manual", false));

  const duplicate = await coordinator.fetch(request("first", true));
  assert.deepEqual(await duplicate.json(), { skippedBusy: true, runKey: "first" });

  releaseFirst();
  assert.equal((await first).status, 200);
  assert.equal((await manual).status, 200);
  const completedDuplicate = await coordinator.fetch(request("first", true));
  assert.deepEqual(await completedDuplicate.json(), { duplicate: true, runKey: "first" });
  assert.deepEqual(events, ["start:first", "end:first", "start:manual", "end:manual"]);
});

test("only the daily fill sync retains a Worker-specific schedule flag", () => {
  assert.deepEqual(flagsForCron("10 16 * * *"), { forceDbFetch: true });
  assert.deepEqual(flagsForCron("0,15,30,45 * * * *"), { forceDbFetch: false });
});
