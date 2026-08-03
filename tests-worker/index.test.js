import assert from "node:assert/strict";
import test from "node:test";

import { CronDeduplicator, executeTasks } from "../src/index.js";
import { flagsForCron } from "../src/config.js";

test("safe default pauses before credentials, APIs, or database writes", async () => {
  const result = await executeTasks({}, ["fetch_filled_orders"], {}, "test");
  assert.equal(result.paused, true);
});

test("scheduled runs queue globally while true duplicate keys are rejected", async () => {
  let storedRuns = {};
  const ctx = {
    storage: {
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
  const request = (runKey) => new Request("https://coordinator/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runKey, tasks: ["fetch_filled_orders"] }),
  });

  const first = coordinator.fetch(request("first"));
  await Promise.resolve();
  const second = coordinator.fetch(request("second"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["start:first"]);

  const duplicate = await coordinator.fetch(request("second"));
  assert.deepEqual(await duplicate.json(), { duplicate: true, runKey: "second" });

  releaseFirst();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
});

test("trigger rebuild is deferred across the 23:55 to 00:05 SGT quiet window", () => {
  assert.equal(flagsForCron("55 15 * * *", Date.UTC(2026, 7, 3, 15, 55)).deferTriggerRebuild, true);
  assert.equal(flagsForCron("0,15,30,45 * * * *", Date.UTC(2026, 7, 3, 16, 0)).deferTriggerRebuild, true);
  assert.equal(flagsForCron("5 16 * * *", Date.UTC(2026, 7, 3, 16, 5)).deferTriggerRebuild, false);
  assert.equal(flagsForCron("5 16 * * *", Date.UTC(2026, 7, 3, 16, 5)).clearRebuildPending, true);
});
