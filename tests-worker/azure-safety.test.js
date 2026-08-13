import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAzureRuntime } from "../src/azure/runtime.js";
import { loadAzureRuntimeConfig } from "../src/azure/config.js";
import { OwnerGuard, RecoveryState } from "../src/azure/owner-guard.js";

class HeldOwnerGuard extends OwnerGuard {
  isHeld() { return true; }
}

function readyState() {
  const state = new RecoveryState();
  state.markReady();
  return state;
}

test("Azure runtime defaults to OFF and never calls its mutation handler", async () => {
  let calls = 0;
  const runtime = createAzureRuntime({}, { mutationHandler: async () => { calls += 1; } });
  assert.equal(runtime.config.tradingMode, "OFF");
  for (const mutation of ["BUY", "SELL", "DELIST"]) {
    assert.deepEqual(await runtime.mutationPort.submit(mutation, {}), { allowed: false, reason: "MODE_OFF" });
  }
  assert.equal(calls, 0);
});

test("invalid Azure TRADING_MODE fails fast", () => {
  assert.throws(() => loadAzureRuntimeConfig({ TRADING_MODE: "live" }), /Invalid TRADING_MODE/);
});

test("EXIT_ONLY permits only guarded SELL and DELIST", async () => {
  const calls = [];
  const runtime = createAzureRuntime({ TRADING_MODE: "EXIT_ONLY" }, {
    ownerGuard: new HeldOwnerGuard(), recoveryState: readyState(), dependencies: { account: true },
    mutationHandler: async (command) => { calls.push(command); return "fake"; },
  });
  assert.deepEqual(await runtime.mutationPort.submit("BUY", {}), { allowed: false, reason: "MODE_EXIT_ONLY" });
  assert.equal((await runtime.mutationPort.submit("SELL", {})).allowed, true);
  assert.equal((await runtime.mutationPort.submit("DELIST", {})).allowed, true);
  assert.deepEqual(calls.map(({ mutation }) => mutation), ["SELL", "DELIST"]);
});

test("FULL still requires owner, READY, and healthy dependencies", async () => {
  const ownerMissing = createAzureRuntime({ TRADING_MODE: "FULL" }, { recoveryState: readyState() });
  assert.deepEqual(await ownerMissing.mutationPort.submit("BUY", {}), { allowed: false, reason: "OWNER_NOT_HELD" });
  const notReady = createAzureRuntime({ TRADING_MODE: "FULL" }, { ownerGuard: new HeldOwnerGuard() });
  assert.deepEqual(await notReady.mutationPort.submit("BUY", {}), { allowed: false, reason: "NOT_READY" });
  const dependencyMissing = createAzureRuntime({ TRADING_MODE: "FULL" }, { ownerGuard: new HeldOwnerGuard(), recoveryState: readyState(), dependencies: { account: false } });
  assert.deepEqual(await dependencyMissing.mutationPort.submit("BUY", {}), { allowed: false, reason: "DEPENDENCY_NOT_READY" });
});

test("unknown mutations are rejected before the Azure handler", async () => {
  let calls = 0;
  const runtime = createAzureRuntime({ TRADING_MODE: "FULL" }, {
    ownerGuard: new HeldOwnerGuard(), recoveryState: readyState(), dependencies: { account: true },
    mutationHandler: async () => { calls += 1; },
  });
  assert.deepEqual(await runtime.mutationPort.submit("BORROW", {}), { allowed: false, reason: "UNKNOWN_MUTATION" });
  assert.equal(calls, 0);
});

test("FULL rejects empty dependency confirmation before the Azure handler", async () => {
  let calls = 0;
  const runtime = createAzureRuntime({ TRADING_MODE: "FULL" }, {
    ownerGuard: new HeldOwnerGuard(), recoveryState: readyState(),
    mutationHandler: async () => { calls += 1; },
  });
  assert.deepEqual(await runtime.mutationPort.submit("BUY", {}), { allowed: false, reason: "DEPENDENCY_NOT_READY" });
  assert.equal(calls, 0);
});

test("P0 Azure mutation port has no real transport and keeps Clock injectable", async () => {
  const clock = { nowMs: () => 1234 };
  const runtime = createAzureRuntime({ TRADING_MODE: "FULL" }, { clock, ownerGuard: new HeldOwnerGuard(), recoveryState: readyState(), dependencies: { account: true } });
  assert.equal(runtime.clock.nowMs(), 1234);
  assert.deepEqual(await runtime.mutationPort.submit("BUY", {}), { allowed: false, reason: "MUTATION_HANDLER_UNAVAILABLE" });
});

test("new Azure modules contain no direct OKX mutation bypass", async () => {
  const directory = new URL("../src/azure/", import.meta.url);
  const files = await readdir(directory);
  for (const file of files) {
    const source = await readFile(join(directory.pathname, file), "utf8");
    assert.doesNotMatch(source, /OKXClient|placeOrder|placeAlgo|\/api\/v5\/trade\//, file);
  }
});
