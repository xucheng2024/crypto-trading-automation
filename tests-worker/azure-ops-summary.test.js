import assert from "node:assert/strict";
import test from "node:test";

import { assessRuntime, classifyBlock, classifyDecision, classifySevereTraces, countCsvInstruments, formatDecisionTelemetryLine, formatInstrumentTimelineSummary, formatPipelineCoverageLine, formatPositionsSummary, formatSevereDiagnostic, instrumentTimelineReadJobName, parseArgs, parseInstrumentTimelineLog, parseManagedPositionsLog, parsePipelineCoverageRow, parseStrategyBaseline, positionsReadJobName, queryRows, redactOperationalError, redactPositionsArtifact, runInstrumentTimelineCommand, runPositionsCommand, strategyBaselineQuery, summarizeDecisions, summarizeDeployment, summarizeRunner, summarizeTrading, traceEvents } from "../scripts/azure-ops-summary.mjs";

test("Azure ops summary converts query tables and aggregates decisions", () => {
  assert.deepEqual(queryRows({ tables: [{ columns: [{ name: "reason" }, { name: "decisions" }], rows: [["WAIT", 2]] }] }), [{ reason: "WAIT", decisions: 2 }]);
  assert.deepEqual(summarizeDecisions([
    { reason: "PRICE_OUTSIDE", instId: "BTC-USDT", decisions: 3, latest: "2026-01-01T00:00:00Z" },
    { reason: "CANDLE_PENDING", instId: "BTC-USDT", decisions: 1, latest: "2026-01-01T00:01:00Z" },
    { reason: "PRICE_OUTSIDE", instId: "ETH-USDT", decisions: 2, latest: "2026-01-01T00:00:30Z" },
  ]), { decisions: 6, instruments: 2, latest: "2026-01-01T00:01:00Z", reasons: { PRICE_OUTSIDE: 5, CANDLE_PENDING: 1 } });
});

test("Azure ops summary accepts trading, deployment, and runner commands", () => {
  assert.deepEqual(parseArgs(["report", "--since-last"]).command, "report");
  assert.deepEqual(parseArgs(["snapshot", "--minutes", "15"]).command, "snapshot");
  assert.deepEqual(parseArgs(["activity", "--minutes", "60"]).command, "activity");
  assert.deepEqual(parseArgs(["blocks", "--details"]).command, "blocks");
  assert.deepEqual(parseArgs(["deploy", "--run-id", "123"]).runId, 123);
  assert.deepEqual(parseArgs(["runner", "--json"]).command, "runner");
  assert.deepEqual(parseArgs(["positions", "--request"]).command, "positions");
  assert.deepEqual(parseArgs(["timeline", "--instrument", "BTC-USDT", "--request"]).command, "timeline");
  assert.deepEqual(parseArgs(["trade", "--instrument", "BTC-USDT", "--request"]).command, "trade");
  assert.throws(() => parseArgs(["positions"]), /requires --request/);
  assert.throws(() => parseArgs(["positions", "--run-id", "7"]), /does not accept --run-id/);
  assert.throws(() => parseArgs(["trade", "--instrument", "BTC-USDT"]), /requires --request/);
  assert.throws(() => parseArgs(["trade", "--instrument", "BTC-USDT", "--run-id", "8"]), /does not accept --run-id/);
  assert.throws(() => parseArgs(["deploy", "--run-id", "0"]), /positive integer/);
});

test("timeline CLI starts the VNet job with a scoped instrument and accepts only its redacted result", async () => {
  const calls = [];
  const result = await runInstrumentTimelineCommand(parseArgs(["timeline", "--instrument", "BTC-USDT", "--request", "--resource-group", "rg", "--app", "trading-cae-engine"]), {
    command: (bin, args) => { calls.push([bin, ...args]); if (args.includes("logs")) return 'INSTRUMENT_TIMELINE_JSON:{"instrument":"BTC-USDT","timeline":[],"summary":{"fills":0}}'; throw new Error("unexpected"); },
    json: (bin, args) => {
      calls.push([bin, ...args]);
      if (args.includes("start")) return { name: "trading-cae-timeline-read-abc" };
      if (args.includes("execution")) return { properties: { status: "Succeeded" } };
      return { properties: { template: { containers: [{ name: "instrument-timeline-read", image: "img", env: [{ name: "TRADING_MODE", value: "OFF" }] }] } } };
    }, sleep: async () => {},
  });
  assert.equal(result.job, "trading-cae-timeline-read"); assert.equal(instrumentTimelineReadJobName("trading-cae-engine"), "trading-cae-timeline-read");
  assert.ok(calls.some((row) => row[0] === "az" && row.includes("start") && row.includes("--yaml"))); assert.deepEqual(parseInstrumentTimelineLog('INSTRUMENT_TIMELINE_JSON:{"instrument":"BTC-USDT","timeline":[]}'), { instrument: "BTC-USDT", timeline: [] });
  const envelope = JSON.stringify({ TimeStamp: "t", Log: 'F INSTRUMENT_TIMELINE_JSON:{"instrument":"ETH-USDT","timeline":[]}' });
  assert.equal(parseInstrumentTimelineLog(envelope).instrument, "ETH-USDT");
});

test("positions CLI starts the VNet job and redacts log JSON", async () => {
  const calls = [];
  const requested = await runPositionsCommand(parseArgs(["positions", "--request", "--resource-group", "rg", "--app", "trading-cae-engine"]), {
    command: (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === "az" && args.includes("logs")) return 'ts MANAGED_POSITIONS_JSON:{"summary":{"instruments":1,"openFills":2,"forbidden":"no"},"positions":[{"instrument":"BTC-USDT","remainingCostUsd":"100","openFills":2,"sellStates":["WAITING"],"nextSellTime":1,"nextForceSellTime":2,"unprotectedWaitingFills":1,"nextProtectionAnchorTime":3,"anchorDueUnprotectedFills":1,"accountId":"forbidden"}]}';
      throw new Error(`unexpected command ${bin} ${args.join(" ")}`);
    },
    json: (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === "az" && args.includes("start")) return { name: "trading-cae-positions-read-abc" };
      if (bin === "az" && args.includes("execution")) return { properties: { status: "Succeeded" } };
      return { properties: { template: { containers: [{ name: "positions-read", image: "img", env: [{ name: "TRADING_MODE", value: "OFF" }] }] } } };
    },
    sleep: async () => {},
  });
  assert.deepEqual(requested, { command: "positions", requested: false, job: "trading-cae-positions-read", execution: "trading-cae-positions-read-abc", summary: { instruments: 1, openFills: 2 }, positions: [{ instrument: "BTC-USDT", remainingCostUsd: "100", openFills: 2, sellStates: ["WAITING"], nextSellTime: 1, nextForceSellTime: 2, unprotectedWaitingFills: 1, nextProtectionAnchorTime: 3, anchorDueUnprotectedFills: 1 }], realizedSummary: { instruments: 0, complete: 0 }, realized: [] });
  assert.match(formatPositionsSummary(requested), /BTC-USDT remaining_usd=100 open_fills=2 sell=WAITING next_sell=1970-01-01T00:00:00.001Z next_force_sell=1970-01-01T00:00:00.002Z protected=0 unprotected_waiting=1 next_anchor=1970-01-01T00:00:00.003Z anchor_due_unprotected=1 dust=0/);
  assert.equal(formatInstrumentTimelineSummary({
    instrument: "CFG-USDT", job: "timeline-read",
    timeline: [
      { eventTime: "2026-08-19T11:25:07.558Z", eventType: "FILL", recordKind: "DURABLE_EVENT", intent: "BUY", fillSize: "10", disposedSize: "10", sellTime: "1787225107558", sellState: "SOLD" },
      { eventTime: "2026-08-19T11:25:07.558Z", eventType: "FILL", recordKind: "DURABLE_EVENT", intent: "BUY", fillSize: "653.431713", disposedSize: "652.200582", sellTime: "1787225107558", sellState: "DUST_PENDING" },
      { eventTime: "2026-08-20T11:55:17.864Z", eventType: "FILL", recordKind: "DURABLE_EVENT", intent: "SELL", fillSize: "75" },
    ],
  }), "Instrument timeline: CFG-USDT | buy=2026-08-19T11:25:07.558Z | sellTime=2026-08-20T11:25:07.558Z | first_sell=2026-08-20T11:55:17.864Z | leftover=1.231131 DUST_PENDING | events=3 | job=timeline-read");
  assert.equal(formatInstrumentTimelineSummary({ instrument: "BTC-USDT", job: "timeline-read", timeline: [] }), "Instrument timeline: BTC-USDT | buy=- | sellTime=- | first_sell=- | leftover=0 | events=0 | job=timeline-read");
  assert.equal(positionsReadJobName("trading-cae-engine"), "trading-cae-positions-read");
  assert.ok(calls.some((row) => row[0] === "az" && row.includes("start")));
  assert.ok(!calls.some((row) => row[0] === "gh"));
  const redacted = redactPositionsArtifact({ summary: { instruments: 1, openFills: 2, forbidden: "no" }, positions: [{ instrument: "BTC-USDT", remainingCostUsd: "100", openFills: 2, accountId: "forbidden" }], realizedSummary: { instruments: 1, complete: 1 }, realized: [{ instrument: "BTC-USDT", netPnlUsd: "2", completeness: "COMPLETE", gapCount: 0, fee: "forbidden" }] });
  assert.deepEqual(redacted.positions[0], { instrument: "BTC-USDT", remainingCostUsd: "100", openFills: 2 }); assert.deepEqual(redacted.realized[0], { instrument: "BTC-USDT", netPnlUsd: "2", completeness: "COMPLETE", gapCount: 0 });
  assert.throws(() => parseManagedPositionsLog("no marker"), /missing the redacted JSON marker/);
  const envelope = JSON.stringify({ TimeStamp: "t", Log: `F MANAGED_POSITIONS_JSON:${JSON.stringify({ summary: { instruments: 1, openFills: 1 }, positions: [{ instrument: "ETH-USDT", remainingCostUsd: "2", openFills: 1 }] })}` });
  assert.deepEqual(parseManagedPositionsLog(envelope).positions[0].instrument, "ETH-USDT");
});

test("Azure ops summary attributes expected OFF transition traces without hiding other revisions", () => {
  const severe = classifySevereTraces([
    { message: "owner_lost SESSION_ADVISORY_LOCK_LOST", tradingMode: "OFF", cloudRoleInstance: "engine--off-old-pod" },
    { message: "watchdog WATCHDOG", tradingMode: "FULL", cloudRoleInstance: "engine--full-old-pod" },
    { message: "ready_false READY_FALSE", tradingMode: "FULL", cloudRoleInstance: "engine--full-new-pod" },
  ], "engine--full-new");
  assert.equal(severe.transitions.length, 1); assert.equal(severe.inactive.length, 1); assert.equal(severe.current.length, 1);
  assert.equal(severe.transitions[0].classification, "EXPECTED_OFF_TRANSITION");
});

test("Azure ops summary exposes only redacted operational error classes", () => {
  assert.equal(redactOperationalError("OKX code 50011"), "OKX_50011");
  assert.equal(redactOperationalError("HTTP 429 response"), "HTTP_429");
  assert.equal(redactOperationalError("request timed out"), "TIMEOUT");
  assert.equal(redactOperationalError("NETWORK_ERROR"), "NETWORK_ERROR");
  assert.equal(redactOperationalError("credential=secret"), "REDACTED_ERROR");
  assert.equal(redactOperationalError(), undefined);
});

test("Azure ops summary prints structured max-avail diagnostics without raw exchange text", () => {
  assert.equal(formatSevereDiagnostic({ timestamp: "t", classification: "CURRENT_OR_UNATTRIBUTED", message: "exit_deferred MAX_AVAIL_FAILED", error: "OKX_ERROR", failureClass: "OKX_ERROR", endpoint: "/api/v5/account/max-avail-size", httpStatus: "400", okxCode: "51000", okxMessageClass: "PARAMETER", okxSummary: "Parameter reduceOnly error", responseClass: "", durationMs: 123, attempts: 4 }), "  t CURRENT_OR_UNATTRIBUTED exit_deferred MAX_AVAIL_FAILED error=OKX_ERROR class=OKX_ERROR endpoint=/api/v5/account/max-avail-size http_status=400 okx_code=51000 okx_message=PARAMETER okx_summary=\"Parameter reduceOnly error\" duration_ms=123 attempts=4");
});

test("Azure ops summary compacts workflow failures, approvals, and runner readiness", () => {
  const deployment = summarizeDeployment(
    { id: 7, status: "completed", conclusion: "failure", head_sha: "abc", html_url: "https://example/run/7" },
    [{ name: "migrate", status: "completed", conclusion: "failure", runner_name: "runner-1", steps: [{ name: "Plan", conclusion: "failure" }] }],
    [{ environment: { name: "production-full" } }],
  );
  assert.equal(deployment.healthy, false); assert.equal(deployment.state, "FAILED"); assert.deepEqual(deployment.failedJobs[0].failedSteps, ["Plan"]); assert.deepEqual(deployment.pendingEnvironments, ["production-full"]);
  const runner = summarizeRunner(
    { properties: { provisioningState: "Succeeded", runningStatus: "Running", latestRevisionName: "runner--1" } },
    [{ properties: { containers: [{ ready: true, runningState: "Running", restartCount: 2 }] } }],
    [{ name: "runner-1", status: "online", busy: false, labels: [{ name: "crypto-remote-migration" }] }],
    ["GH_RUNNER_PAT"],
  );
  assert.equal(runner.healthy, true); assert.equal(runner.restarts, 2); assert.equal(runner.github[0].status, "online");
});

test("Azure ops summary separates waiting, policy, opportunity, and safety blocks", () => {
  assert.equal(classifyDecision("PRICE_OUTSIDE"), "waiting");
  assert.equal(classifyDecision("SKIPPED_YESTERDAY_GAIN"), "policy");
  assert.equal(classifyDecision("BUY_QUEUED"), "opportunity");
  assert.equal(classifyDecision("QUOTE_STALE"), "blocked");
  assert.equal(classifyBlock("QUOTE_STALE"), "LIKELY_RECOVERABLE"); assert.equal(classifyBlock("BREAKOUT_NOT_CONFIRMED"), "MARKET_MOVED"); assert.equal(classifyBlock("HARD_STOP"), "SAFETY_BOUNDARY");
  const decisions = traceEvents([
    { timestamp: "2", message: "trading_decision QUOTE_STALE", customDimensions: JSON.stringify({ instId: "BTC-USDT", reason: "QUOTE_STALE", last: "1", breakoutPrice: "0.9" }) },
    { timestamp: "1", message: "trading_decision PRICE_OUTSIDE", customDimensions: { instId: "ETH-USDT", reason: "PRICE_OUTSIDE" } },
  ]);
  const trading = summarizeTrading(decisions, [{ timestamp: "3", reason: "BUY_PREPARED", decisionId: "D1", instId: "ETH-USDT", clOrdId: "one" }], new Map([["BTC-USDT", "margin"], ["ETH-USDT", "spot"]]), decisions, [{ timestamp: "4", type: "block_evidence", stage: "AVAILABILITY", reason: "INSUFFICIENT_FUNDS_WAIT_RISK_VERSION", decisionId: "D2", instId: "SOL-USDT", availBuy: "0" }]);
  assert.deepEqual(trading.currentStates, { waiting: 1, policy: 0, blocked: 1, opportunity: 0 });
  assert.equal(trading.currentStateCoverage, 2);
  assert.equal(trading.blocked[0].route, "margin"); assert.equal(trading.blocked[1].stage, "AVAILABILITY"); assert.equal(trading.blocked[1].availBuy, "0"); assert.equal(trading.events.prepared, 1); assert.equal(trading.executions[0].route, "spot");
  assert.equal(trading.blocked[0].breakoutGap, "0.1");
  assert.equal(trading.blocked[0].apiBoundary, "PRE_API_STRATEGY_DECISION"); assert.equal(trading.executions[0].apiBoundary, "DB_RESERVED_BEFORE_API");
  assert.equal(trading.attemptTimelines.length, 2); assert.deepEqual(trading.attemptTimelines.find((row) => row.decisionId === "D1").timeline.map((event) => event.stage), ["PERSISTED"]);
  assert.deepEqual(trading.blockClasses, { LIKELY_RECOVERABLE: 2, MARKET_MOVED: 0, SAFETY_BOUNDARY: 0 }); assert.deepEqual(trading.blockStages, { PLANNER: 1, AVAILABILITY: 1 });
});

test("Azure ops summary classifies a DIP_FIRST_ENTRY_ONLY block as policy, not a safety block", () => {
  assert.equal(classifyDecision("DIP_FIRST_ENTRY_ONLY"), "policy");
  const blockEvents = [{ timestamp: "1", type: "block_evidence", stage: "COORDINATOR_GUARD", reason: "DIP_FIRST_ENTRY_ONLY", decisionId: "D1", instId: "BTC-USDT", generation: 1, dipPrice: "94" }];
  const trading = summarizeTrading([], [], new Map(), [], blockEvents);
  assert.equal(trading.blocked.length, 0);
  assert.deepEqual(trading.blockedReasons, {});
  assert.deepEqual(trading.blockClasses, { LIKELY_RECOVERABLE: 0, MARKET_MOVED: 0, SAFETY_BOUNDARY: 0 });
  assert.equal(trading.policy.length, 1);
  assert.equal(trading.policy[0].reason, "DIP_FIRST_ENTRY_ONLY");
  assert.equal(trading.policy[0].optimizationClass, undefined);
  const timeline = trading.attemptTimelines.find((row) => row.decisionId === "D1").timeline[0];
  assert.equal(timeline.evidence.optimizationClass, undefined, "the attempt timeline must not label a policy skip as a safety-boundary block");
});

test("Azure ops summary labels lifecycle telemetry separately from durable recovery confirmation", () => {
  const trading = summarizeTrading([], [], new Map(), [], [], [
    { type: "fill_reconciliation", reason: "FILL_BATCH_COMMITTED", inserted: "2", linked: "1" },
    { type: "sell_watch_loaded", reason: "SELL_WATCH_SNAPSHOT", total: "3", instruments: "1", waiting: "2", triggered: "1", dustPending: "0" },
  ]);
  assert.equal(trading.observability.lifecycleCoverage, "TELEMETRY_ONLY"); assert.equal(trading.observability.reconciliationCoverage, "PARTIAL_DURABLE_CONFIRMATION");
  assert.equal(trading.observability.recoveredInserted, 2); assert.equal(trading.observability.recoveredLinked, 1);
  assert.deepEqual(trading.observability.sellWatchSnapshot, { total: 3, instruments: 1, waiting: 2, triggered: 1, dustPending: 0 });
});

test("Azure ops summary calculates the smallest exact capacity gap", () => {
  const trading = summarizeTrading([], [], new Map(), [], [
    { timestamp: "1", stage: "SIZING", reason: "MINIMUM_SIZE", instId: "BTC-USDT", availableCapacity: "3.7", minimumCapacity: "10", capacityGap: "6.3" },
    { timestamp: "2", stage: "SIZING", reason: "MINIMUM_SIZE", instId: "ETH-USDT", availableCapacity: "1", minimumCapacity: "10", capacityGap: "9" },
  ]);
  assert.equal(trading.minimumCapacityGap, "6.3"); assert.deepEqual(trading.blockClasses, { LIKELY_RECOVERABLE: 0, MARKET_MOVED: 0, SAFETY_BOUNDARY: 2 }); assert.deepEqual(trading.blockStages, { SIZING: 2 });
});

test("Azure ops summary links one BUY from candidate through API and fill", () => {
  const decisions = [{ timestamp: "1", reason: "BUY_QUEUED", decisionId: "D1", instId: "BTC-USDT" }];
  const lifecycle = [
    { timestamp: "2", reason: "BUY_PREPARED", decisionId: "D1", clOrdId: "O1", instId: "BTC-USDT" },
    { timestamp: "3", reason: "BUY_SUBMITTED", decisionId: "D1", clOrdId: "O1", instId: "BTC-USDT" },
    { timestamp: "4", reason: "BUY_SETTLED", decisionId: "D1", clOrdId: "O1", instId: "BTC-USDT" },
  ];
  const attempt = summarizeTrading(decisions, lifecycle).attemptTimelines[0];
  assert.equal(attempt.outcome, "BUY_SETTLED"); assert.equal(attempt.clOrdId, "O1");
  assert.deepEqual(attempt.timeline.map((event) => event.stage), ["CANDIDATE", "PERSISTED", "API", "FILLED"]);
});

test("Azure ops summary exposes a post-commit recovery fill as durable ledger confirmation", () => {
  const decisions = [{ timestamp: "1", reason: "BUY_QUEUED", decisionId: "D1", instId: "BTC-USDT" }];
  const lifecycle = [
    { timestamp: "2", reason: "BUY_PREPARED", decisionId: "D1", clOrdId: "O1", instId: "BTC-USDT" },
    { timestamp: "3", reason: "BUY_LEDGER_CONFIRMED", decisionId: "D1", clOrdId: "O1", instId: "BTC-USDT", executionRoute: "margin", filledSize: "1", weightedAvgPrice: "2" },
  ];
  const trading = summarizeTrading(decisions, lifecycle);
  assert.equal(trading.events.settled, 0); assert.equal(trading.events.ledgerConfirmed, 1);
  assert.equal(trading.executions[1].apiBoundary, "DURABLE_LEDGER_CONFIRMED");
  assert.deepEqual(trading.attemptTimelines[0].timeline.map((event) => event.stage), ["CANDIDATE", "PERSISTED", "LEDGER_CONFIRMED"]);
});

test("Azure ops summary prints pipeline coverage counts without instrument names", () => {
  assert.equal(formatPipelineCoverageLine(null), "Pipeline coverage: unavailable");
  const row = parsePipelineCoverageRow({
    runtime: "3", quote_ready: "2", candle_ready: "2", strategy_row: "3", daily_state: "2",
    evaluator_seen: "1", decision_emit: "1", no_market_data: "1", candle_not_initialized: "0",
    no_strategy_row: "0", strategy_state_never_created: "0", filtered_before_evaluator: "1", unknown: "0",
  });
  assert.equal(formatPipelineCoverageLine(row), "Pipeline coverage: runtime=3 quote_ready=2 candle_ready=2 strategy_row=3 daily_state=2 evaluator_seen=1 decision_emit=1 | drop no_market_data=1 candle_not_initialized=0 no_strategy_row=0 strategy_state_never_created=0 filtered_before_evaluator=1 unknown=0");
  assert.equal(formatPipelineCoverageLine(row).includes("BTC"), false);
});

test("Azure ops summary labels decision telemetry against runtime and repo-enabled counts", () => {
  assert.equal(countCsvInstruments("BTC-USDT, ETH-USDT,BTC-USDT"), 2);
  assert.equal(countCsvInstruments(""), 0);
  assert.equal(formatDecisionTelemetryLine({
    windowInstruments: 146, currentStateCoverage: 146, currentStates: { waiting: 94, policy: 52, blocked: 0, opportunity: 0 }, runtimeInstruments: 146, repoEnabled: 146, strategyReadyInstruments: 146,
  }), "Decision telemetry: 146 instruments with decision telemetry / 146 runtime / 146 repo-enabled; current-state=146 waiting=94 policy=52 blocked=0; strategy_ready=146");
  assert.equal(formatDecisionTelemetryLine({
    windowInstruments: 94, runtimeInstruments: null, repoEnabled: 146, strategyReadyInstruments: 146,
  }), "Decision telemetry: 94 instruments with decision telemetry / missing runtime / 146 repo-enabled; strategy_ready=146");
});

test("Azure ops summary attributes strategy baselines to the current revision and latest outcome", () => {
  const query = strategyBaselineQuery("engine--full-new");
  assert.match(query, /message startswith 'strategy_baseline '/);
  assert.match(query, /cloud_RoleInstance == 'engine--full-new' or cloud_RoleInstance startswith 'engine--full-new-'/);
  assert.match(query, /top 1 by timestamp desc/);
  assert.equal(parseStrategyBaseline({ timestamp: "2026-08-23T00:00:00Z", status: "STRATEGY_READY", instruments: "146", strategyDay: "2026-08-23", instance: "engine--full-new-abc" }).instruments, 146);
  assert.deepEqual(parseStrategyBaseline({ timestamp: "2026-08-23T00:01:00Z", status: "STRATEGY_BASELINE_FAILED", instruments: "146", strategyDay: "2026-08-23", instance: "engine--full-new-abc" }), { status: "STRATEGY_BASELINE_FAILED", timestamp: "2026-08-23T00:01:00Z", strategyDay: "2026-08-23", instruments: null, instance: "engine--full-new-abc" });
  assert.deepEqual(parseStrategyBaseline(null), { status: "UNAVAILABLE" });
  assert.equal(strategyBaselineQuery("engine--full'o").includes("'engine--full''o'"), true);
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
