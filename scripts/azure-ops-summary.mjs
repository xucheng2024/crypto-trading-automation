import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { subtractDecimal } from "../src/decimal.js";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `${command} exited ${result.status}`).trim().split("\n").slice(-3).join("\n");
    throw new Error(detail);
  }
  return result.stdout.trim();
}

function runJson(command, args) {
  const output = run(command, args);
  return output ? JSON.parse(output) : null;
}

export function queryRows(result) {
  const table = result?.tables?.[0];
  if (!table) return [];
  const names = table.columns.map((column) => column.name);
  return table.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

export function summarizeDecisions(rows) {
  const instruments = new Set(); const reasons = new Map(); let decisions = 0; let latest = null;
  for (const row of rows) {
    instruments.add(row.instId); decisions += Number(row.decisions ?? 0);
    reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + Number(row.decisions ?? 0));
    if (!latest || row.latest > latest) latest = row.latest;
  }
  return { decisions, instruments: instruments.size, latest, reasons: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])) };
}

const WAITING_REASONS = new Set(["PRICE_OUTSIDE", "BREAKOUT_NOT_CONFIRMED", "CANDLE_PENDING", "ASK_ABOVE_LIMIT"]);
const POLICY_REASONS = new Set(["SKIPPED_YESTERDAY_GAIN", "STRATEGY_POSITION_EXISTS", "ACTIVE_BUY_ATTEMPT", "TARGET_FILLED"]);
const OPPORTUNITY_REASONS = new Set(["BUY_QUEUED"]);

export function classifyDecision(reason) {
  if (WAITING_REASONS.has(reason)) return "waiting";
  if (POLICY_REASONS.has(reason)) return "policy";
  if (OPPORTUNITY_REASONS.has(reason)) return "opportunity";
  return "blocked";
}

export function traceEvents(rows) {
  return rows.map((row) => {
    let dimensions = row.customDimensions ?? {};
    if (typeof dimensions === "string") try { dimensions = JSON.parse(dimensions); } catch { dimensions = {}; }
    return { timestamp: row.timestamp, message: row.message, ...dimensions };
  });
}

export function summarizeTrading(decisionEvents, lifecycleEvents, routeByInst = new Map(), currentDecisionEvents = decisionEvents) {
  const latest = new Map();
  for (const event of currentDecisionEvents) if (event.instId && (!latest.has(event.instId) || event.timestamp > latest.get(event.instId).timestamp)) latest.set(event.instId, event);
  const states = { waiting: 0, policy: 0, blocked: 0, opportunity: 0 };
  for (const event of latest.values()) states[classifyDecision(event.reason)] += 1;
  const preparedByOrder = new Map(lifecycleEvents.filter((event) => event.reason === "BUY_PREPARED" && event.clOrdId).map((event) => [event.clOrdId, event]));
  const executions = lifecycleEvents.map((event) => {
    const prepared = preparedByOrder.get(event.clOrdId); const instId = event.instId ?? prepared?.instId;
    const apiBoundary = { BUY_PREPARED: "DB_RESERVED_BEFORE_API", BUY_SUBMITTED: "API_ACKNOWLEDGED", BUY_UNKNOWN: "API_RESULT_AMBIGUOUS", BUY_NOT_CREATED: "API_REJECTED_OR_NOT_SENT", BUY_SETTLED: "EXCHANGE_FILL_CONFIRMED" }[event.reason] ?? "EXECUTION_LIFECYCLE";
    return { timestamp: event.timestamp, reason: event.reason, instId, route: routeByInst.get(instId), clOrdId: event.clOrdId, exchangeReason: event.exchangeReason, apiBoundary };
  });
  const gap = (left, right) => {
    if (left === undefined || right === undefined) return undefined;
    try { return subtractDecimal(left, right); } catch { return undefined; }
  };
  const detail = (event) => {
    const apiBoundary = event.reason === "BUY_QUEUE_REJECTED" ? "COORDINATOR_QUEUE_REJECTED" : "PRE_API_STRATEGY_DECISION";
    return {
      timestamp: event.timestamp, instId: event.instId, reason: event.reason, route: routeByInst.get(event.instId), apiBoundary,
      last: event.last, askPx: event.askPx, previousClosedHigh: event.previousClosedHigh,
      dailyLimitPrice: event.dailyLimitPrice, breakoutPrice: event.breakoutPrice,
      breakoutGap: gap(event.last, event.breakoutPrice), limitHeadroom: gap(event.dailyLimitPrice, event.last), askLimitGap: gap(event.askPx, event.dailyLimitPrice),
    };
  };
  const blocked = decisionEvents.filter((event) => classifyDecision(event.reason) === "blocked").map(detail);
  const policy = [...latest.values()].filter((event) => classifyDecision(event.reason) === "policy").map(detail);
  const blockedReasons = {};
  for (const row of blocked) blockedReasons[row.reason] = (blockedReasons[row.reason] ?? 0) + 1;
  return {
    currentStates: states,
    currentStateCoverage: latest.size,
    events: {
      queued: decisionEvents.filter((event) => event.reason === "BUY_QUEUED").length,
      prepared: lifecycleEvents.filter((event) => event.reason === "BUY_PREPARED").length,
      submitted: lifecycleEvents.filter((event) => event.reason === "BUY_SUBMITTED").length,
      settled: lifecycleEvents.filter((event) => event.reason === "BUY_SETTLED").length,
      unknown: lifecycleEvents.filter((event) => event.reason === "BUY_UNKNOWN").length,
      notCreated: lifecycleEvents.filter((event) => event.reason === "BUY_NOT_CREATED").length,
    },
    blocked, blockedReasons, policy, executions,
  };
}

export function assessRuntime({ app, active, replicas, traffic, metric, expectedMode }) {
  const containers = replicas.flatMap((replica) => replica.properties?.containers ?? []);
  const trafficWeight = traffic.reduce((sum, row) => sum + Number(row.weight ?? 0), 0);
  const checks = {
    provisioned: app.properties?.provisioningState === "Succeeded",
    running: app.properties?.runningStatus === "Running",
    singleActiveRevision: active.length === 1,
    revisionHealthy: active[0]?.properties?.healthState === "Healthy" && active[0]?.properties?.runningState === "RunningAtMaxScale",
    immutableImage: active[0]?.properties?.template?.containers?.[0]?.image?.includes("@sha256:") === true,
    expectedMode: !expectedMode || active[0]?.properties?.template?.containers?.[0]?.env?.find((row) => row.name === "TRADING_MODE")?.value === expectedMode,
    traffic: trafficWeight === 100,
    replicasReady: containers.length > 0 && containers.every((container) => container.ready && container.runningState === "Running"),
    noRestarts: containers.every((container) => Number(container.restartCount ?? 0) === 0),
    telemetryReady: Number(metric?.ready) === 1,
  };
  return { healthy: Object.values(checks).every(Boolean), checks };
}

export function parseArgs(argv) {
  const args = [...argv];
  const options = { command: "report", minutes: 15, json: false, details: false, expectedMode: null, since: null, sinceLast: false };
  if (["report", "snapshot", "activity", "blocks"].includes(args[0])) options.command = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--details") options.details = true;
    else if (arg === "--since-last") options.sinceLast = true;
    else if (arg === "--since") {
      const value = args[++index]; if (!value || Number.isNaN(Date.parse(value))) throw new Error("--since requires an ISO timestamp");
      options.since = new Date(value).toISOString();
    }
    else if (["--minutes", "--resource-group", "--app", "--app-insights", "--expect-mode"].includes(arg)) {
      const value = args[++index]; if (!value) throw new Error(`${arg} requires a value`);
      const key = { "--minutes": "minutes", "--resource-group": "resourceGroup", "--app": "app", "--app-insights": "appInsights", "--expect-mode": "expectedMode" }[arg];
      options[key] = arg === "--minutes" ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.minutes) || options.minutes < 1 || options.minutes > 1440) throw new Error("--minutes must be an integer from 1 to 1440");
  if (options.expectedMode && !["OFF", "FULL", "EXIT_ONLY"].includes(options.expectedMode)) throw new Error("--expect-mode must be OFF, FULL, or EXIT_ONLY");
  if (options.since && options.sinceLast) throw new Error("Use only one of --since or --since-last");
  return options;
}

function azJson(args) { return runJson("az", [...args, "--only-show-errors", "--output", "json"]); }

function appInsightsQuery(resourceGroup, appInsights, query) {
  return queryRows(azJson(["monitor", "app-insights", "query", "--resource-group", resourceGroup, "--app", appInsights, "--analytics-query", query]));
}

function compactDigest(image = "") { return image.includes("@sha256:") ? `sha256:${image.split("@sha256:")[1].slice(0, 12)}` : image; }

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const queryStartedAt = new Date().toISOString();
  const checkpointPath = run("git", ["rev-parse", "--git-path", "azure-ops-last-check.json"]);
  let checkpointFallback = false;
  if (options.sinceLast) {
    const checkpoint = await readFile(checkpointPath, "utf8").then(JSON.parse).catch(() => null);
    checkpointFallback = !checkpoint?.checkedAt;
    options.since = checkpoint?.checkedAt ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
  }
  const timeFilter = options.since ? `timestamp >= datetime(${options.since})` : `timestamp > ago(${options.minutes}m)`;
  const windowLabel = options.since ? `since ${options.since}` : `${options.minutes}m`;
  const resourceGroup = options.resourceGroup ?? run("gh", ["variable", "get", "AZURE_RESOURCE_GROUP"]);
  const appName = options.app ?? run("gh", ["variable", "get", "CONTAINER_APP_NAME"]);
  const appInsights = options.appInsights ?? (appName.endsWith("-cae-engine") ? `${appName.slice(0, -"-cae-engine".length)}-ai` : null);
  if (!appInsights) throw new Error("Pass --app-insights when it cannot be derived from the Container App name");

  const app = azJson(["containerapp", "show", "--resource-group", resourceGroup, "--name", appName]);
  const active = azJson(["containerapp", "revision", "list", "--resource-group", resourceGroup, "--name", appName]).filter((revision) => revision.properties?.active);
  const revisionName = app.properties?.latestReadyRevisionName;
  const replicas = azJson(["containerapp", "replica", "list", "--resource-group", resourceGroup, "--name", appName, "--revision", revisionName]);
  const traffic = azJson(["containerapp", "ingress", "traffic", "show", "--resource-group", resourceGroup, "--name", appName]);

  const metricQuery = `traces | where ${timeFilter} | where message == 'metric_snapshot RUNTIME_METRICS' | top 1 by timestamp desc | project timestamp, ready=toint(customDimensions.ready), eventCount=toint(customDimensions.event_enqueue_count), decisionCount=toint(customDimensions.decision_eval_count), eventP99=toint(customDimensions.event_enqueue_p99_ms), decisionP99=toint(customDimensions.decision_eval_p99_ms), sourceLagP99=toint(customDimensions.market_source_lag_p99_ms), queueDepth=toint(customDimensions.queue_depth_current), pendingBuy=toint(customDimensions.pending_buy_current), exitBacklog=toint(customDimensions.exit_backlog_current), tradingMode=tostring(customDimensions.tradingMode)`;
  const decisionQuery = `traces | where ${timeFilter} | where message startswith 'trading_decision ' | project timestamp, message, customDimensions | order by timestamp desc | take 5000`;
  const currentDecisionQuery = "traces | where timestamp > ago(24h) | where message startswith 'trading_decision ' | extend instId=tostring(customDimensions.instId) | summarize arg_max(timestamp, customDimensions) by instId";
  const lifecycleQuery = `traces | where ${timeFilter} | where message startswith 'order_lifecycle BUY_' or message startswith 'trade_lifecycle BUY_' | project timestamp, message, customDimensions | order by timestamp desc | take 1000`;
  const errorQuery = `traces | where ${timeFilter} | where severityLevel >= 3 | project timestamp, message | order by timestamp desc | take 10`;
  const metric = appInsightsQuery(resourceGroup, appInsights, metricQuery)[0] ?? null;
  const needDecisions = options.command !== "snapshot";
  const needCurrentDecisions = options.command === "report" || options.command === "blocks";
  const needLifecycle = options.command === "report" || options.command === "activity";
  const needErrors = options.command === "report" || options.command === "snapshot";
  const decisionEvents = needDecisions ? traceEvents(appInsightsQuery(resourceGroup, appInsights, decisionQuery)) : [];
  const currentDecisionEvents = needCurrentDecisions ? traceEvents(appInsightsQuery(resourceGroup, appInsights, currentDecisionQuery)) : [];
  const lifecycleEvents = needLifecycle ? traceEvents(appInsightsQuery(resourceGroup, appInsights, lifecycleQuery)) : [];
  const groupedDecisions = new Map();
  for (const event of decisionEvents) {
    const key = `${event.reason}:${event.instId}`; const current = groupedDecisions.get(key) ?? { reason: event.reason, instId: event.instId, decisions: 0, latest: event.timestamp };
    current.decisions += 1; if (event.timestamp > current.latest) current.latest = event.timestamp; groupedDecisions.set(key, current);
  }
  const decisions = summarizeDecisions([...groupedDecisions.values()]);
  const errors = needErrors ? appInsightsQuery(resourceGroup, appInsights, errorQuery) : [];
  const artifact = JSON.parse(await readFile(new URL("../infrastructure/config/p5-enabled-instruments.json", import.meta.url), "utf8"));
  const routeByInst = new Map([...(artifact.routes?.margin ?? []).map((instId) => [instId, "margin"]), ...(artifact.routes?.spot ?? []).map((instId) => [instId, "spot"])]);
  const trading = summarizeTrading(decisionEvents, lifecycleEvents, routeByInst, currentDecisionEvents);
  const assessment = assessRuntime({ app, active, replicas, traffic, metric, expectedMode: options.expectedMode });
  const revision = active[0]; const container = revision?.properties?.template?.containers?.[0];
  const replicaContainers = replicas.flatMap((replica) => replica.properties?.containers ?? []);
  const summary = {
    command: options.command,
    healthy: assessment.healthy,
    window: { from: options.since, to: queryStartedAt, minutes: options.since ? null : options.minutes, checkpointFallback },
    target: { resourceGroup, app: appName, appInsights },
    runtime: {
      revision: revision?.name, mode: container?.env?.find((row) => row.name === "TRADING_MODE")?.value,
      runningState: revision?.properties?.runningState, healthState: revision?.properties?.healthState,
      image: compactDigest(container?.image), trafficWeight: traffic.reduce((sum, row) => sum + Number(row.weight ?? 0), 0),
      replicas: replicas.length, readyContainers: replicaContainers.filter((row) => row.ready).length,
      restarts: replicaContainers.reduce((sum, row) => sum + Number(row.restartCount ?? 0), 0),
    },
    telemetry: { ...metric, configuredInstruments: artifact.enabled_count, observedInstruments: decisions.instruments, decisions: decisions.decisions, reasons: decisions.reasons },
    trading,
    severeTraces: errors,
    riskSignals: errors.filter((row) => /HALT|READY_FALSE|WATCHDOG|UNKNOWN|OWNER_LOST|STALE/.test(row.message ?? "")),
    checks: assessment.checks,
  };

  if (options.json) console.log(JSON.stringify(summary));
  else {
    const topReasons = Object.entries(decisions.reasons).slice(0, 4).map(([reason, count]) => `${reason}=${count}`).join(", ") || "none";
    console.log(`Window: ${windowLabel} -> ${queryStartedAt}`);
    if (checkpointFallback) console.log("Checkpoint: missing; used the most recent 60 minutes");
    if (options.command === "report") {
      console.log(`Azure production: ${summary.healthy ? "HEALTHY" : "UNHEALTHY"}`);
      console.log(`Revision: ${summary.runtime.revision} | ${summary.runtime.mode} | ${summary.runtime.runningState}/${summary.runtime.healthState}`);
      console.log(`Runtime: traffic=${summary.runtime.trafficWeight}% replicas=${summary.runtime.replicas} ready=${summary.runtime.readyContainers} restarts=${summary.runtime.restarts} image=${summary.runtime.image}`);
      console.log(`Latest metrics: ready=${metric?.ready ?? "missing"} events=${metric?.eventCount ?? 0} decisions=${metric?.decisionCount ?? decisions.decisions}`);
      console.log(`Decision activity: instruments=${decisions.instruments}/${artifact.enabled_count}; current-state coverage=${trading.currentStateCoverage}/${artifact.enabled_count}`);
      console.log(`Latency: enqueue_p99=${metric?.eventP99 ?? "?"}ms decision_p99=${metric?.decisionP99 ?? "?"}ms source_lag_p99=${metric?.sourceLagP99 ?? "?"}ms`);
      console.log(`Queues: current=${metric?.queueDepth ?? "?"} pending_buy=${metric?.pendingBuy ?? "?"} exit_backlog=${metric?.exitBacklog ?? "?"}`);
      console.log(`Decisions: ${topReasons}`);
      console.log(`Trading: opportunities=${trading.events.queued} prepared=${trading.events.prepared} submitted=${trading.events.submitted} settled=${trading.events.settled}`);
      console.log(`Current states: waiting=${trading.currentStates.waiting} policy=${trading.currentStates.policy} blocked=${trading.currentStates.blocked} opportunity=${trading.currentStates.opportunity}`);
      console.log(`Severe traces: ${errors.length}${errors.length ? ` | ${errors.slice(0, 3).map((row) => row.message).join("; ")}` : ""}`);
    } else if (options.command === "snapshot") {
      console.log(`Azure production: ${summary.healthy ? "HEALTHY" : "UNHEALTHY"}`);
      console.log(`Revision: ${summary.runtime.revision} | ${summary.runtime.mode} | ${summary.runtime.runningState}/${summary.runtime.healthState}`);
      console.log(`Runtime: traffic=${summary.runtime.trafficWeight}% replicas=${summary.runtime.replicas} ready=${summary.runtime.readyContainers} restarts=${summary.runtime.restarts} image=${summary.runtime.image}`);
      console.log(`Signals: ready=${metric?.ready ?? "missing"} source_lag_p99=${metric?.sourceLagP99 ?? "?"}ms severe_sample=${errors.length} risk_signals=${summary.riskSignals.length} exit_backlog=${metric?.exitBacklog ?? "?"}`);
    } else if (options.command === "activity") {
      console.log(`Activity: opportunities=${trading.events.queued} prepared=${trading.events.prepared} submitted=${trading.events.submitted} settled=${trading.events.settled} unknown=${trading.events.unknown} not_created=${trading.events.notCreated}`);
      console.log(`Decision activity: instruments=${decisions.instruments}/${artifact.enabled_count} | ${topReasons}`);
    } else {
      const blockReasons = Object.entries(trading.blockedReasons).map(([reason, count]) => `${reason}=${count}`).join(", ") || "none";
      console.log(`Blocks: safety_events=${trading.blocked.length} current_safety=${trading.currentStates.blocked} current_policy=${trading.currentStates.policy}`);
      console.log(`Block reasons: ${blockReasons}`);
    }
      const evidence = (row) => [row.last && `last=${row.last}`, row.askPx && `ask=${row.askPx}`, row.breakoutPrice && `breakout=${row.breakoutPrice}`, row.dailyLimitPrice && `limit=${row.dailyLimitPrice}`, row.breakoutGap !== undefined && `breakout_gap=${row.breakoutGap}`, row.limitHeadroom !== undefined && `limit_headroom=${row.limitHeadroom}`, `boundary=${row.apiBoundary}`].filter(Boolean).join(" ");
    if (options.details && options.command !== "activity") {
      console.log("Blocked details:");
      if (!trading.blocked.length) console.log("  none");
      else for (const row of trading.blocked.slice(0, 100)) console.log(`  ${row.timestamp} ${row.instId ?? "?"} route=${row.route ?? "?"} ${row.reason} ${evidence(row)}`.trimEnd());
      if (trading.blocked.length > 100) console.log(`  ... ${trading.blocked.length - 100} more; use --json for all`);
      console.log("Current policy states:");
      if (!trading.policy.length) console.log("  none");
      else for (const row of trading.policy.slice(0, 100)) console.log(`  ${row.timestamp} ${row.instId ?? "?"} route=${row.route ?? "?"} ${row.reason} ${evidence(row)}`.trimEnd());
      if (trading.policy.length > 100) console.log(`  ... ${trading.policy.length - 100} more; use --json for all`);
    }
    if (options.details && options.command !== "blocks") {
      console.log("Execution details:");
      if (!trading.executions.length) console.log("  none");
      else for (const row of trading.executions.slice(0, 100)) console.log(`  ${row.timestamp} ${row.instId ?? "?"} route=${row.route ?? "?"} ${row.reason} boundary=${row.apiBoundary} clOrdId=${row.clOrdId ?? "?"}${row.exchangeReason ? ` exchange=${row.exchangeReason}` : ""}`);
      if (trading.executions.length > 100) console.log(`  ... ${trading.executions.length - 100} more; use --json for all`);
    }
  }
  if (options.command === "report" && options.since) await writeFile(checkpointPath, `${JSON.stringify({ checkedAt: queryStartedAt })}\n`, "utf8");
  if (!summary.healthy) process.exitCode = 2;
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
