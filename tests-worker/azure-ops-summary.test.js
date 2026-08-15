import assert from "node:assert/strict";
import test from "node:test";

import { assessRuntime, classifyDecision, parseArgs, queryRows, summarizeDecisions, summarizeTrading, traceEvents } from "../scripts/azure-ops-summary.mjs";

test("Azure ops summary converts query tables and aggregates decisions", () => {
  assert.deepEqual(queryRows({ tables: [{ columns: [{ name: "reason" }, { name: "decisions" }], rows: [["WAIT", 2]] }] }), [{ reason: "WAIT", decisions: 2 }]);
  assert.deepEqual(summarizeDecisions([
    { reason: "PRICE_OUTSIDE", instId: "BTC-USDT", decisions: 3, latest: "2026-01-01T00:00:00Z" },
    { reason: "CANDLE_PENDING", instId: "BTC-USDT", decisions: 1, latest: "2026-01-01T00:01:00Z" },
    { reason: "PRICE_OUTSIDE", instId: "ETH-USDT", decisions: 2, latest: "2026-01-01T00:00:30Z" },
  ]), { decisions: 6, instruments: 2, latest: "2026-01-01T00:01:00Z", reasons: { PRICE_OUTSIDE: 5, CANDLE_PENDING: 1 } });
});

test("Azure ops summary accepts report, activity, and blocks commands", () => {
  assert.deepEqual(parseArgs(["report", "--since-last"]).command, "report");
  assert.deepEqual(parseArgs(["snapshot", "--minutes", "15"]).command, "snapshot");
  assert.deepEqual(parseArgs(["activity", "--minutes", "60"]).command, "activity");
  assert.deepEqual(parseArgs(["blocks", "--details"]).command, "blocks");
});

test("Azure ops summary separates waiting, policy, opportunity, and safety blocks", () => {
  assert.equal(classifyDecision("PRICE_OUTSIDE"), "waiting");
  assert.equal(classifyDecision("SKIPPED_YESTERDAY_GAIN"), "policy");
  assert.equal(classifyDecision("BUY_QUEUED"), "opportunity");
  assert.equal(classifyDecision("QUOTE_STALE"), "blocked");
  const decisions = traceEvents([
    { timestamp: "2", message: "trading_decision QUOTE_STALE", customDimensions: JSON.stringify({ instId: "BTC-USDT", reason: "QUOTE_STALE", last: "1", breakoutPrice: "0.9" }) },
    { timestamp: "1", message: "trading_decision PRICE_OUTSIDE", customDimensions: { instId: "ETH-USDT", reason: "PRICE_OUTSIDE" } },
  ]);
  const trading = summarizeTrading(decisions, [{ timestamp: "3", reason: "BUY_PREPARED", instId: "ETH-USDT", clOrdId: "one" }], new Map([["BTC-USDT", "margin"], ["ETH-USDT", "spot"]]));
  assert.deepEqual(trading.currentStates, { waiting: 1, policy: 0, blocked: 1, opportunity: 0 });
  assert.equal(trading.currentStateCoverage, 2);
  assert.equal(trading.blocked[0].route, "margin"); assert.equal(trading.events.prepared, 1); assert.equal(trading.executions[0].route, "spot");
  assert.equal(trading.blocked[0].breakoutGap, "0.1");
  assert.equal(trading.blocked[0].apiBoundary, "PRE_API_STRATEGY_DECISION"); assert.equal(trading.executions[0].apiBoundary, "DB_RESERVED_BEFORE_API");
});

test("Azure ops summary fails closed on unsafe runtime state", () => {
  const container = { image: "registry/engine@sha256:abc", env: [{ name: "TRADING_MODE", value: "FULL" }] };
  const base = {
    app: { properties: { provisioningState: "Succeeded", runningStatus: "Running" } },
    active: [{ properties: { healthState: "Healthy", runningState: "RunningAtMaxScale", template: { containers: [container] } } }],
    replicas: [{ properties: { containers: [{ ready: true, runningState: "Running", restartCount: 0 }] } }],
    traffic: [{ weight: 100 }], metric: { ready: 1 }, expectedMode: "FULL",
  };
  assert.equal(assessRuntime(base).healthy, true);
  assert.equal(assessRuntime({ ...base, metric: { ready: 0 } }).healthy, false);
  assert.equal(assessRuntime({ ...base, active: [...base.active, base.active[0]] }).healthy, false);
});
