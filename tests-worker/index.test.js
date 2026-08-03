import assert from "node:assert/strict";
import test from "node:test";

import { CronDeduplicator, executeTasks } from "../src/index.js";
import { flagsForCron } from "../src/config.js";

test("safe default pauses before credentials, APIs, or database writes", async () => {
  const result = await executeTasks({}, ["fetch_filled_orders"], {}, "test");
  assert.equal(result.paused, true);
});

test("scheduled runs skip while manual runs queue, while true duplicate keys are rejected", async () => {
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

test("trigger rebuild is deferred across the 23:55 to 00:05 SGT quiet window", () => {
  assert.equal(flagsForCron("55 15 * * *", Date.UTC(2026, 7, 3, 15, 55)).deferTriggerRebuild, true);
  assert.equal(flagsForCron("0,15,30,45 * * * *", Date.UTC(2026, 7, 3, 16, 0)).deferTriggerRebuild, true);
  assert.equal(flagsForCron("5 16 * * *", Date.UTC(2026, 7, 3, 16, 5)).deferTriggerRebuild, false);
  assert.equal(flagsForCron("5 16 * * *", Date.UTC(2026, 7, 3, 16, 5)).clearRebuildPending, true);
});
