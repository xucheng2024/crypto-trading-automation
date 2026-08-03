import assert from "node:assert/strict";
import test from "node:test";

import { executeTasks } from "../src/index.js";

test("safe default pauses before credentials, APIs, or database writes", async () => {
  const result = await executeTasks({}, ["fetch_filled_orders"], {}, "test");
  assert.equal(result.paused, true);
});
