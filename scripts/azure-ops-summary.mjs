import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareDecimal, subtractDecimal } from "../src/decimal.js";

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

const RECOVERABLE_REASONS = new Set(["QUOTE_STALE", "CANDLE_STALE", "CLOCK_SYNC_STALE", "NOT_READY", "MARKET", "MAX_AVAIL_FAILED", "INSUFFICIENT_FUNDS_WAIT_RISK_VERSION", "EXECUTION_ROUTE_UNAVAILABLE"]);
const MARKET_MOVED_REASONS = new Set(["BREAKOUT_NOT_CONFIRMED"]);

export function classifyBlock(reason) {
  if (RECOVERABLE_REASONS.has(reason)) return "LIKELY_RECOVERABLE";
  if (MARKET_MOVED_REASONS.has(reason)) return "MARKET_MOVED";
  return "SAFETY_BOUNDARY";
}

export function traceEvents(rows) {
  return rows.map((row) => {
    let dimensions = row.customDimensions ?? {};
    if (typeof dimensions === "string") try { dimensions = JSON.parse(dimensions); } catch { dimensions = {}; }
    return { timestamp: row.timestamp, message: row.message, ...dimensions };
  });
}

export function summarizeTrading(decisionEvents, lifecycleEvents, routeByInst = new Map(), currentDecisionEvents = decisionEvents, blockEvents = [], observabilityEvents = []) {
  const latest = new Map();
  for (const event of currentDecisionEvents) if (event.instId && (!latest.has(event.instId) || event.timestamp > latest.get(event.instId).timestamp)) latest.set(event.instId, event);
  const states = { waiting: 0, policy: 0, blocked: 0, opportunity: 0 };
  for (const event of latest.values()) states[classifyDecision(event.reason)] += 1;
  const preparedByOrder = new Map(lifecycleEvents.filter((event) => event.reason === "BUY_PREPARED" && event.clOrdId).map((event) => [event.clOrdId, event]));
  const executions = lifecycleEvents.map((event) => {
    const prepared = preparedByOrder.get(event.clOrdId); const instId = event.instId ?? prepared?.instId;
    const apiBoundary = { BUY_PREPARED: "DB_RESERVED_BEFORE_API", BUY_SUBMITTED: "API_ACKNOWLEDGED", BUY_UNKNOWN: "API_RESULT_AMBIGUOUS", BUY_NOT_CREATED: "API_REJECTED_OR_NOT_SENT", BUY_SETTLED: "EXCHANGE_FILL_CONFIRMED", BUY_LEDGER_CONFIRMED: "DURABLE_LEDGER_CONFIRMED" }[event.reason] ?? "EXECUTION_LIFECYCLE";
    return { timestamp: event.timestamp, reason: event.reason, decisionId: event.decisionId ?? prepared?.decisionId, instId, route: event.executionRoute ?? routeByInst.get(instId), clOrdId: event.clOrdId, exchangeReason: event.exchangeReason, apiBoundary };
  });
  const gap = (left, right) => {
    if (left === undefined || right === undefined) return undefined;
    try { return subtractDecimal(left, right); } catch { return undefined; }
  };
  const detail = (event, isBlock = classifyDecision(event.reason) === "blocked" || event.type === "block_evidence") => {
    const apiBoundary = event.reason === "BUY_QUEUE_REJECTED" ? "COORDINATOR_QUEUE_REJECTED" : "PRE_API_STRATEGY_DECISION";
    return {
      timestamp: event.timestamp, decisionId: event.decisionId, clOrdId: event.clOrdId, stage: event.stage, instId: event.instId, reason: event.reason, route: event.executionRoute ?? routeByInst.get(event.instId), apiBoundary: event.stage ? `PRE_API_${event.stage}` : apiBoundary,
      last: event.last, askPx: event.askPx, previousClosedHigh: event.previousClosedHigh,
      dailyLimitPrice: event.dailyLimitPrice, breakoutPrice: event.breakoutPrice,
      breakoutGap: event.breakoutGap ?? gap(event.last, event.breakoutPrice), priceLimitGap: event.priceLimitGap,
      limitHeadroom: gap(event.dailyLimitPrice, event.last), askLimitGap: gap(event.askPx, event.dailyLimitPrice),
      quoteAgeMs: event.quoteAgeMs, candleAgeMs: event.candleAgeMs, availBuy: event.availBuy,
      remainingCapacity: event.remainingCapacity, plannedSize: event.plannedSize, minSize: event.minSize,
      availableCapacity: event.availableCapacity, minimumCapacity: event.minimumCapacity, capacityGap: event.capacityGap,
      adjustedEquity: event.adjustedEquity, managedExposure: event.managedExposure, leverage: event.leverage, exposureScope: event.exposureScope, equityBasis: event.equityBasis, riskVersion: event.riskVersion,
      optimizationClass: isBlock ? classifyBlock(event.reason) : undefined,
    };
  };
  const blocked = [...decisionEvents.filter((event) => classifyDecision(event.reason) === "blocked"), ...blockEvents].map((event) => detail(event, true));
  const policy = [...latest.values()].filter((event) => classifyDecision(event.reason) === "policy").map(detail);
  const blockedReasons = {};
  for (const row of blocked) blockedReasons[row.reason] = (blockedReasons[row.reason] ?? 0) + 1;
  const blockClasses = { LIKELY_RECOVERABLE: 0, MARKET_MOVED: 0, SAFETY_BOUNDARY: 0 };
  const blockStages = {}; let minimumCapacityGap;
  for (const row of blocked) {
    blockClasses[row.optimizationClass] += 1; const stage = row.stage ?? "PLANNER"; blockStages[stage] = (blockStages[stage] ?? 0) + 1;
    if (row.capacityGap !== undefined && (minimumCapacityGap === undefined || compareDecimal(row.capacityGap, minimumCapacityGap) < 0)) minimumCapacityGap = row.capacityGap;
  }
  const clOrdDecision = new Map(lifecycleEvents.filter((event) => event.clOrdId && event.decisionId).map((event) => [event.clOrdId, event.decisionId]));
  const attempts = new Map();
  const appendAttempt = (event, stage) => {
    const decisionId = event.decisionId ?? clOrdDecision.get(event.clOrdId); if (!decisionId) return;
    const current = attempts.get(decisionId) ?? { decisionId, instId: event.instId, clOrdId: event.clOrdId, route: event.executionRoute ?? routeByInst.get(event.instId), timeline: [] };
    current.instId ??= event.instId; current.clOrdId ??= event.clOrdId; current.route ??= event.executionRoute ?? routeByInst.get(event.instId);
    current.timeline.push({ timestamp: event.timestamp, stage, reason: event.reason, clOrdId: event.clOrdId, exchangeReason: event.exchangeReason, apiBoundary: event.apiBoundary, evidence: detail(event) });
    attempts.set(decisionId, current);
  };
  for (const event of decisionEvents) if (event.decisionId) appendAttempt(event, event.reason === "BUY_QUEUED" ? "CANDIDATE" : "DECISION");
  for (const event of blockEvents) appendAttempt(event, event.stage ?? "BLOCKED");
  for (const event of lifecycleEvents) appendAttempt(event, ({ BUY_PREPARED: "PERSISTED", BUY_SUBMITTED: "API", BUY_UNKNOWN: "API", BUY_NOT_CREATED: "API", BUY_SETTLED: "FILLED", BUY_LEDGER_CONFIRMED: "LEDGER_CONFIRMED" })[event.reason] ?? "LIFECYCLE");
  const attemptTimelines = [...attempts.values()].map((attempt) => {
    attempt.timeline.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const latest = attempt.timeline.at(-1); return { ...attempt, outcome: latest?.reason, latest: latest?.timestamp };
  }).sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
  const reconciliation = observabilityEvents.filter((event) => event.type === "fill_reconciliation" && event.reason === "FILL_BATCH_COMMITTED");
  const watchSnapshots = observabilityEvents.filter((event) => event.type === "sell_watch_loaded" && event.reason === "SELL_WATCH_SNAPSHOT");
  const latestWatchSnapshot = watchSnapshots.at(-1);
  return {
    currentStates: states,
    currentStateCoverage: latest.size,
    events: {
      queued: decisionEvents.filter((event) => event.reason === "BUY_QUEUED").length,
      prepared: lifecycleEvents.filter((event) => event.reason === "BUY_PREPARED").length,
      submitted: lifecycleEvents.filter((event) => event.reason === "BUY_SUBMITTED").length,
      settled: lifecycleEvents.filter((event) => event.reason === "BUY_SETTLED").length,
      ledgerConfirmed: lifecycleEvents.filter((event) => event.reason === "BUY_LEDGER_CONFIRMED").length,
      unknown: lifecycleEvents.filter((event) => event.reason === "BUY_UNKNOWN").length,
      notCreated: lifecycleEvents.filter((event) => event.reason === "BUY_NOT_CREATED").length,
    },
    observability: {
      lifecycleCoverage: "TELEMETRY_ONLY",
      reconciliationCoverage: reconciliation.length ? "PARTIAL_DURABLE_CONFIRMATION" : "UNAVAILABLE_IN_WINDOW",
      recoveredInserted: reconciliation.reduce((sum, event) => sum + Number(event.inserted ?? 0), 0),
      recoveredLinked: reconciliation.reduce((sum, event) => sum + Number(event.linked ?? 0), 0),
      sellWatchSnapshot: latestWatchSnapshot ? { total: Number(latestWatchSnapshot.total ?? 0), instruments: Number(latestWatchSnapshot.instruments ?? 0), waiting: Number(latestWatchSnapshot.waiting ?? 0), triggered: Number(latestWatchSnapshot.triggered ?? 0), dustPending: Number(latestWatchSnapshot.dustPending ?? 0) } : { coverage: "UNAVAILABLE_IN_WINDOW" },
    },
    blocked, blockedReasons, blockClasses, blockStages, minimumCapacityGap, policy, executions, attemptTimelines,
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

export function classifySevereTraces(rows, activeRevision) {
  const traces = rows.map((row) => {
    const activeInstance = !row.cloudRoleInstance || row.cloudRoleInstance === activeRevision || row.cloudRoleInstance.startsWith(`${activeRevision}-`);
    const expectedTransition = !activeInstance && row.tradingMode === "OFF" && row.message === "owner_lost SESSION_ADVISORY_LOCK_LOST";
    return { ...row, classification: expectedTransition ? "EXPECTED_OFF_TRANSITION" : activeInstance ? "CURRENT_OR_UNATTRIBUTED" : "INACTIVE_REVISION" };
  });
  return {
    traces,
    current: traces.filter((row) => row.classification === "CURRENT_OR_UNATTRIBUTED"),
    inactive: traces.filter((row) => row.classification === "INACTIVE_REVISION"),
    transitions: traces.filter((row) => row.classification === "EXPECTED_OFF_TRANSITION"),
  };
}

export function summarizeDeployment(runInfo, jobs = [], pendingDeployments = []) {
  const normalizedJobs = jobs.map((job) => ({
    name: job.name, status: job.status, conclusion: job.conclusion, runner: job.runner_name || null,
    failedSteps: (job.steps ?? []).filter((step) => step.conclusion === "failure").map((step) => step.name),
  }));
  const failedJobs = normalizedJobs.filter((job) => job.conclusion === "failure");
  const state = runInfo.status !== "completed" ? "IN_PROGRESS" : runInfo.conclusion === "success" ? "SUCCEEDED" : "FAILED";
  return {
    id: runInfo.id, status: runInfo.status, conclusion: runInfo.conclusion, commit: runInfo.head_sha,
    url: runInfo.html_url, createdAt: runInfo.created_at, jobs: normalizedJobs, failedJobs,
    pendingEnvironments: pendingDeployments.map((row) => row.environment?.name).filter(Boolean),
    state, healthy: state !== "FAILED",
  };
}

export function summarizeRunner(app, replicas = [], githubRunners = [], secretNames = []) {
  const containers = replicas.flatMap((replica) => replica.properties?.containers ?? []);
  const matched = githubRunners.filter((runner) => runner.labels?.some((label) => label.name === "crypto-remote-migration"));
  const checks = {
    secretConfigured: secretNames.includes("GH_RUNNER_PAT"),
    provisioned: app.properties?.provisioningState === "Succeeded",
    running: app.properties?.runningStatus === "Running",
    replicasReady: containers.length > 0 && containers.every((container) => container.ready && container.runningState === "Running"),
    githubOnline: matched.some((runner) => runner.status === "online"),
  };
  return {
    healthy: Object.values(checks).every(Boolean), checks, revision: app.properties?.latestRevisionName,
    replicas: replicas.length, readyContainers: containers.filter((container) => container.ready).length,
    restarts: containers.reduce((sum, container) => sum + Number(container.restartCount ?? 0), 0),
    github: matched.map((runner) => ({ name: runner.name, status: runner.status, busy: runner.busy })),
  };
}

export function parseArgs(argv) {
  const args = [...argv];
  const options = { command: "report", minutes: 15, json: false, details: false, expectedMode: null, since: null, sinceLast: false, runId: null, instrument: null, request: false };
  if (["report", "snapshot", "activity", "blocks", "deploy", "runner", "trade", "positions"].includes(args[0])) options.command = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--details") options.details = true;
    else if (arg === "--request") options.request = true;
    else if (arg === "--since-last") options.sinceLast = true;
    else if (arg === "--since") {
      const value = args[++index]; if (!value || Number.isNaN(Date.parse(value))) throw new Error("--since requires an ISO timestamp");
      options.since = new Date(value).toISOString();
    }
    else if (["--minutes", "--resource-group", "--app", "--app-insights", "--expect-mode", "--run-id", "--instrument"].includes(arg)) {
      const value = args[++index]; if (!value) throw new Error(`${arg} requires a value`);
      const key = { "--minutes": "minutes", "--resource-group": "resourceGroup", "--app": "app", "--app-insights": "appInsights", "--expect-mode": "expectedMode", "--run-id": "runId", "--instrument": "instrument" }[arg];
      options[key] = ["--minutes", "--run-id"].includes(arg) ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.minutes) || options.minutes < 1 || options.minutes > 1440) throw new Error("--minutes must be an integer from 1 to 1440");
  if (options.expectedMode && !["OFF", "FULL", "EXIT_ONLY"].includes(options.expectedMode)) throw new Error("--expect-mode must be OFF, FULL, or EXIT_ONLY");
  if (options.runId !== null && (!Number.isSafeInteger(options.runId) || options.runId < 1)) throw new Error("--run-id must be a positive integer");
  if (options.since && options.sinceLast) throw new Error("Use only one of --since or --since-last");
  if (["trade", "positions"].includes(options.command)) {
    if (options.command === "positions") {
      if (options.instrument) throw new Error("--instrument is only valid with trade");
      if (options.request === Boolean(options.runId)) throw new Error("positions requires exactly one of --request or --run-id");
      return options;
    }
    if (!options.instrument || !/^[A-Z0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)?$/.test(options.instrument)) throw new Error("trade requires --instrument with an exact uppercase OKX instrument");
    if (options.request === Boolean(options.runId)) throw new Error("trade requires exactly one of --request or --run-id");
  } else if (options.instrument || options.request) throw new Error("--instrument and --request are only valid with trade");
  return options;
}

export async function runTradeCommand(options, { command = run, json = runJson, fs = { mkdtemp, readFile, rm }, tempDir = tmpdir() } = {}) {
  const repository = command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (options.request) {
    const branch = command("gh", ["api", `repos/${repository}`, "--jq", ".default_branch"]);
    command("gh", ["workflow", "run", "production-ops-read.yml", "--repo", repository, "--ref", branch, "-f", `instrument=${options.instrument}`]);
    return { command: "trade", requested: true, instrument: options.instrument, repository, branch };
  }
  const runInfo = json("gh", ["api", `repos/${repository}/actions/runs/${options.runId}`]);
  if (!runInfo || !String(runInfo.path ?? "").endsWith("/production-ops-read.yml")) throw new Error(`Run ${options.runId} is not a production instrument timeline run`);
  const directory = await fs.mkdtemp(join(tempDir, "crypto-remote-timeline-"));
  try {
    command("gh", ["run", "download", String(options.runId), "--repo", repository, "--name", "instrument-timeline", "--dir", directory]);
    const artifact = JSON.parse(await fs.readFile(join(directory, "instrument-timeline.json"), "utf8"));
    if (artifact?.instrument !== options.instrument || !Array.isArray(artifact?.timeline)) throw new Error("Timeline artifact does not match the requested instrument");
    const allowed = ["eventTime", "eventType", "recordKind", "stateObservedAt", "attemptRef", "intent", "state", "reservationState", "executionMode", "executionRoute", "plannedSize", "reservedExposureUsd", "reservedBaseSize", "executionLimitPrice", "fillSize", "disposedSize", "fillPrice", "sellTime", "forceSellTime", "protectionPrice", "sellState", "sellTriggerReason", "allocationState"];
    const timeline = artifact.timeline.map((row) => Object.fromEntries(allowed.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]])));
    const summary = artifact?.summary && typeof artifact.summary === "object" ? {
      attemptSnapshots: artifact.summary.attemptSnapshots, fills: artifact.summary.fills,
      protectionSnapshots: artifact.summary.protectionSnapshots, attemptStates: artifact.summary.attemptStates,
    } : undefined;
    return { command: "trade", requested: false, runId: options.runId, instrument: artifact.instrument, attemptRefScope: artifact.attemptRefScope === "QUERY_SNAPSHOT" ? artifact.attemptRefScope : undefined, summary, timeline };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export function parseManagedPositionsLog(text) {
  const prefix = "MANAGED_POSITIONS_JSON:";
  const line = String(text).split(/\r?\n/).map((row) => row.trim()).find((row) => row.includes(prefix));
  if (!line) throw new Error("Managed-positions job log is missing the redacted JSON marker");
  return JSON.parse(line.slice(line.indexOf(prefix) + prefix.length));
}

export function redactPositionsArtifact(artifact) {
  if (!artifact?.summary || !Array.isArray(artifact?.positions)) throw new Error("Managed-positions artifact is invalid");
  const allowed = ["instrument", "remainingCostUsd", "openFills", "sellStates", "nextSellTime", "nextForceSellTime", "protectedFills", "dustPendingFills"];
  const positions = artifact.positions.map((row) => Object.fromEntries(allowed.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]])));
  const summary = { instruments: Number(artifact.summary.instruments), openFills: Number(artifact.summary.openFills) };
  if (!Number.isSafeInteger(summary.instruments) || summary.instruments < 0 || !Number.isSafeInteger(summary.openFills) || summary.openFills < 0 || summary.instruments !== positions.length) throw new Error("Managed-positions artifact summary is invalid");
  return { summary, positions };
}

export function positionsReadJobName(appName) {
  return appName.endsWith("-engine") ? `${appName.slice(0, -"-engine".length)}-positions-read` : `${appName}-positions-read`;
}

function jobExecutionName(started) {
  const name = started?.name;
  if (typeof name === "string" && name && !name.includes("/")) return name;
  const id = String(started?.id ?? "");
  const marker = "/executions/";
  const index = id.toLowerCase().lastIndexOf(marker);
  if (index >= 0) return decodeURIComponent(id.slice(index + marker.length));
  throw new Error("Managed-positions job start did not return an execution name");
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPositionsCommand(options, { command = run, json = runJson, fs = { mkdtemp, readFile, rm }, tempDir = tmpdir(), sleep = sleepMs, now = Date.now, timeoutMs = 60_000 } = {}) {
  if (options.request) {
    const resourceGroup = options.resourceGroup ?? command("gh", ["variable", "get", "AZURE_RESOURCE_GROUP"]);
    const appName = options.app ?? command("gh", ["variable", "get", "CONTAINER_APP_NAME"]);
    const jobName = positionsReadJobName(appName);
    const started = json("az", ["containerapp", "job", "start", "--name", jobName, "--resource-group", resourceGroup, "--only-show-errors", "--output", "json"]);
    const executionName = jobExecutionName(started);
    let status = "Running";
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const execution = json("az", ["containerapp", "job", "execution", "show", "--name", jobName, "--resource-group", resourceGroup, "--job-execution-name", executionName, "--only-show-errors", "--output", "json"]);
      status = execution?.properties?.status ?? execution?.status ?? "Unknown";
      if (status === "Succeeded") break;
      if (status === "Failed" || status === "Cancelled") throw new Error(`Managed-positions job ${executionName} ${status}`);
      await sleep(2000);
    }
    if (status !== "Succeeded") throw new Error(`Managed-positions job ${executionName} timed out`);
    let logs = "";
    while (now() < deadline) {
      logs = command("az", ["containerapp", "job", "logs", "show", "--name", jobName, "--resource-group", resourceGroup, "--container", "positions-read", "--execution", executionName, "--only-show-errors"]);
      try {
        const { summary, positions } = redactPositionsArtifact(parseManagedPositionsLog(logs));
        return { command: "positions", requested: false, job: jobName, execution: executionName, summary, positions };
      } catch (error) {
        if (!/missing the redacted JSON marker/.test(error.message)) throw error;
        await sleep(2000);
      }
    }
    throw new Error(`Managed-positions job ${executionName} log is missing the redacted JSON marker`);
  }
  const repository = command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const runInfo = json("gh", ["api", `repos/${repository}/actions/runs/${options.runId}`]);
  if (!runInfo || !String(runInfo.path ?? "").endsWith("/production-positions-read.yml")) throw new Error(`Run ${options.runId} is not a production managed-positions run`);
  const directory = await fs.mkdtemp(join(tempDir, "crypto-remote-positions-"));
  try {
    command("gh", ["run", "download", String(options.runId), "--repo", repository, "--name", "managed-positions", "--dir", directory]);
    const artifact = JSON.parse(await fs.readFile(join(directory, "managed-positions.json"), "utf8"));
    const { summary, positions } = redactPositionsArtifact(artifact);
    return { command: "positions", requested: false, runId: options.runId, summary, positions };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function azJson(args) { return runJson("az", [...args, "--only-show-errors", "--output", "json"]); }

function appInsightsQuery(resourceGroup, appInsights, query) {
  return queryRows(azJson(["monitor", "app-insights", "query", "--resource-group", resourceGroup, "--app", appInsights, "--analytics-query", query]));
}

function compactDigest(image = "") { return image.includes("@sha256:") ? `sha256:${image.split("@sha256:")[1].slice(0, 12)}` : image; }

function collectProductionRuntime(resourceGroup, appName) {
  const app = azJson(["containerapp", "show", "--resource-group", resourceGroup, "--name", appName]);
  const active = azJson(["containerapp", "revision", "list", "--resource-group", resourceGroup, "--name", appName]).filter((revision) => revision.properties?.active);
  const revision = active[0]; const revisionName = revision?.name;
  const replicas = revisionName ? azJson(["containerapp", "replica", "list", "--resource-group", resourceGroup, "--name", appName, "--revision", revisionName]) : [];
  const traffic = azJson(["containerapp", "ingress", "traffic", "show", "--resource-group", resourceGroup, "--name", appName]);
  const containers = replicas.flatMap((replica) => replica.properties?.containers ?? []); const container = revision?.properties?.template?.containers?.[0];
  const checks = {
    provisioned: app.properties?.provisioningState === "Succeeded", running: app.properties?.runningStatus === "Running", singleActiveRevision: active.length === 1,
    revisionHealthy: revision?.properties?.healthState === "Healthy" && revision?.properties?.runningState === "RunningAtMaxScale",
    traffic: traffic.reduce((sum, row) => sum + Number(row.weight ?? 0), 0) === 100,
    replicasReady: containers.length > 0 && containers.every((row) => row.ready && row.runningState === "Running"),
  };
  return {
    healthy: Object.values(checks).every(Boolean), checks, revision: revisionName,
    mode: container?.env?.find((row) => row.name === "TRADING_MODE")?.value, image: compactDigest(container?.image),
    trafficWeight: traffic.reduce((sum, row) => sum + Number(row.weight ?? 0), 0), replicas: replicas.length,
    readyContainers: containers.filter((row) => row.ready).length, restarts: containers.reduce((sum, row) => sum + Number(row.restartCount ?? 0), 0),
  };
}

function collectRunnerSummary(resourceGroup, appName, repository) {
  const runnerName = appName.endsWith("-engine") ? `${appName.slice(0, -"-engine".length)}-github-runner` : `${appName}-github-runner`;
  const app = azJson(["containerapp", "show", "--resource-group", resourceGroup, "--name", runnerName]);
  const revision = app.properties?.latestRevisionName;
  const replicas = revision ? azJson(["containerapp", "replica", "list", "--resource-group", resourceGroup, "--name", runnerName, "--revision", revision]) : [];
  const githubRunners = runJson("gh", ["api", `repos/${repository}/actions/runners?per_page=100`])?.runners ?? [];
  const secretNames = (runJson("gh", ["secret", "list", "--repo", repository, "--json", "name"]) ?? []).map((row) => row.name);
  return { name: runnerName, ...summarizeRunner(app, replicas, githubRunners, secretNames) };
}

function failedLogExcerpt(repository, runId) {
  const lines = run("gh", ["run", "view", String(runId), "--repo", repository, "--log-failed"]).split("\n").map((line) => line.trim()).filter(Boolean);
  const diagnostic = lines.filter((line) => /error|failed|failure|exit code|not found|denied|unauthori[sz]ed/i.test(line));
  return (diagnostic.length ? diagnostic : lines).slice(-12);
}

async function runInfrastructureCommand(options, resourceGroup, appName) {
  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const runnerName = appName.endsWith("-engine") ? `${appName.slice(0, -"-engine".length)}-github-runner` : `${appName}-github-runner`;
  let runner;
  try { runner = collectRunnerSummary(resourceGroup, appName, repository); }
  catch (error) {
    runner = { name: runnerName, healthy: false, error: error.message, checks: { secretConfigured: false, provisioned: false, running: false, replicasReady: false, githubOnline: false }, revision: null, replicas: 0, readyContainers: 0, restarts: 0, github: [] };
  }
  if (options.command === "runner") {
    const summary = { command: "runner", healthy: runner.healthy, target: { resourceGroup, app: runner.name, repository }, runner };
    if (options.json) console.log(JSON.stringify(summary));
    else {
      const github = runner.github.map((row) => `${row.status}${row.busy ? "/busy" : "/idle"}`).join(",") || "missing";
      console.log(`Runner: ${summary.healthy ? "HEALTHY" : "UNHEALTHY"} | azure=${runner.checks.provisioned && runner.checks.running ? "running" : "not-ready"} github=${github}`);
      console.log(`Revision: ${runner.revision} | replicas=${runner.replicas} ready=${runner.readyContainers} restarts=${runner.restarts} secret=${runner.checks.secretConfigured ? "configured" : "missing"}`);
      if (runner.error) console.log(`Error: ${runner.error}`);
    }
    if (!summary.healthy) process.exitCode = 2;
    return summary;
  }

  const latest = runJson("gh", ["api", `repos/${repository}/actions/workflows/production-deploy.yml/runs?event=workflow_dispatch&per_page=1`])?.workflow_runs?.[0];
  const runInfo = options.runId ? runJson("gh", ["api", `repos/${repository}/actions/runs/${options.runId}`]) : latest;
  if (!runInfo) throw new Error("No production deployment run found");
  if (runInfo.name !== "Production deploy" && !String(runInfo.path ?? "").endsWith("/production-deploy.yml")) throw new Error(`Run ${runInfo.id} is not a production deployment`);
  const jobs = runJson("gh", ["api", `repos/${repository}/actions/runs/${runInfo.id}/jobs?per_page=100`])?.jobs ?? [];
  const pending = runInfo.status === "completed" ? [] : runJson("gh", ["api", `repos/${repository}/actions/runs/${runInfo.id}/pending_deployments`]) ?? [];
  const deployment = summarizeDeployment(runInfo, jobs, pending);
  let runtime;
  try { runtime = collectProductionRuntime(resourceGroup, appName); }
  catch (error) { runtime = { healthy: false, error: error.message, revision: null, mode: null, image: null, trafficWeight: 0, replicas: 0, readyContainers: 0, restarts: 0 }; }
  const summary = { command: "deploy", healthy: deployment.healthy && runtime.healthy && runner.healthy, target: { resourceGroup, app: appName, repository }, deployment, runtime, runner };
  if (options.details && deployment.failedJobs.length) summary.failedLogExcerpt = failedLogExcerpt(repository, runInfo.id);
  if (options.json) console.log(JSON.stringify(summary));
  else {
    console.log(`Deployment: run=${deployment.id} result=${deployment.state} commit=${deployment.commit?.slice(0, 7)} overall_healthy=${summary.healthy}`);
    console.log(`Jobs: ${deployment.jobs.map((job) => `${job.name}=${job.status}/${job.conclusion ?? "pending"}${job.runner ? `@${job.runner}` : ""}`).join(" ") || "none"}`);
    console.log(`Pending approvals: ${deployment.pendingEnvironments.join(",") || "none"}`);
    console.log(`Production: ${runtime.revision} | ${runtime.mode} | traffic=${runtime.trafficWeight}% replicas=${runtime.replicas} ready=${runtime.readyContainers} restarts=${runtime.restarts} image=${runtime.image}`);
    if (runtime.error) console.log(`Production error: ${runtime.error}`);
    console.log(`Runner: ${runner.healthy ? "healthy" : "unhealthy"} | github=${runner.github.map((row) => row.status).join(",") || "missing"} busy=${runner.github.some((row) => row.busy)}`);
    if (runner.error) console.log(`Runner error: ${runner.error}`);
    if (deployment.failedJobs.length) console.log(`Failures: ${deployment.failedJobs.map((job) => `${job.name}[${job.failedSteps.join(",") || "unknown step"}]`).join(" ")}`);
    if (summary.failedLogExcerpt?.length) console.log(`Failed log: ${summary.failedLogExcerpt.join(" | ")}`);
    console.log(`URL: ${deployment.url}`);
  }
  if (!summary.healthy) process.exitCode = 2;
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "trade") {
    const summary = await runTradeCommand(options);
    if (options.json) console.log(JSON.stringify(summary));
    else if (summary.requested) console.log(`Requested redacted instrument timeline for ${summary.instrument} on ${summary.branch}`);
    else console.log(`Instrument timeline: ${summary.instrument} | events=${summary.timeline.length} | run=${summary.runId}`);
    return summary;
  }
  if (options.command === "positions") {
    const summary = await runPositionsCommand(options);
    if (options.json) console.log(JSON.stringify(summary));
    else if (summary.requested) console.log(`Requested redacted managed-position summary on ${summary.branch}`);
    else {
      const source = summary.execution ? `job=${summary.job} execution=${summary.execution}` : `run=${summary.runId}`;
      console.log(`Managed positions: instruments=${summary.summary.instruments} open_fills=${summary.summary.openFills} | ${source}`);
    }
    return summary;
  }
  const queryStartedAt = new Date().toISOString();
  const checkpointPath = run("git", ["rev-parse", "--git-path", "azure-ops-last-check.json"]);
  const resourceGroup = options.resourceGroup ?? run("gh", ["variable", "get", "AZURE_RESOURCE_GROUP"]);
  const appName = options.app ?? run("gh", ["variable", "get", "CONTAINER_APP_NAME"]);
  if (["deploy", "runner"].includes(options.command)) return runInfrastructureCommand(options, resourceGroup, appName);
  let checkpointFallback = false;
  if (options.sinceLast) {
    const checkpoint = await readFile(checkpointPath, "utf8").then(JSON.parse).catch(() => null);
    checkpointFallback = !checkpoint?.checkedAt;
    options.since = checkpoint?.checkedAt ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
  }
  const timeFilter = options.since ? `timestamp >= datetime(${options.since})` : `timestamp > ago(${options.minutes}m)`;
  const windowLabel = options.since ? `since ${options.since}` : `${options.minutes}m`;
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
  const observabilityQuery = `traces | where ${timeFilter} | where message startswith 'fill_reconciliation FILL_BATCH_COMMITTED' or message startswith 'sell_watch_loaded SELL_WATCH_SNAPSHOT' | project timestamp, message, customDimensions | order by timestamp desc | take 1000`;
  const blockQuery = `traces | where ${timeFilter} | where message startswith 'block_evidence ' | project timestamp, message, customDimensions | order by timestamp desc | take 5000`;
  const errorQuery = `traces | where ${timeFilter} | where severityLevel >= 3 | project timestamp, message, cloudRoleInstance=cloud_RoleInstance, tradingMode=tostring(customDimensions.tradingMode) | order by timestamp desc | take 10`;
  const metric = appInsightsQuery(resourceGroup, appInsights, metricQuery)[0] ?? null;
  const needDecisions = options.command !== "snapshot";
  const needCurrentDecisions = options.command === "report" || options.command === "blocks";
  const needLifecycle = options.command === "report" || options.command === "activity";
  const needErrors = options.command === "report" || options.command === "snapshot";
  const decisionEvents = needDecisions ? traceEvents(appInsightsQuery(resourceGroup, appInsights, decisionQuery)) : [];
  const currentDecisionEvents = needCurrentDecisions ? traceEvents(appInsightsQuery(resourceGroup, appInsights, currentDecisionQuery)) : [];
  const lifecycleEvents = needLifecycle ? traceEvents(appInsightsQuery(resourceGroup, appInsights, lifecycleQuery)) : [];
  const observabilityEvents = needLifecycle ? traceEvents(appInsightsQuery(resourceGroup, appInsights, observabilityQuery)) : [];
  const blockEvents = needDecisions ? traceEvents(appInsightsQuery(resourceGroup, appInsights, blockQuery)) : [];
  const groupedDecisions = new Map();
  for (const event of decisionEvents) {
    const key = `${event.reason}:${event.instId}`; const current = groupedDecisions.get(key) ?? { reason: event.reason, instId: event.instId, decisions: 0, latest: event.timestamp };
    current.decisions += 1; if (event.timestamp > current.latest) current.latest = event.timestamp; groupedDecisions.set(key, current);
  }
  const decisions = summarizeDecisions([...groupedDecisions.values()]);
  const errors = needErrors ? appInsightsQuery(resourceGroup, appInsights, errorQuery) : [];
  const artifact = JSON.parse(await readFile(new URL("../infrastructure/config/p5-enabled-instruments.json", import.meta.url), "utf8"));
  const routeByInst = new Map([...(artifact.routes?.margin ?? []).map((instId) => [instId, "margin"]), ...(artifact.routes?.spot ?? []).map((instId) => [instId, "spot"])]);
  const trading = summarizeTrading(decisionEvents, lifecycleEvents, routeByInst, currentDecisionEvents, blockEvents, observabilityEvents);
  const assessment = assessRuntime({ app, active, replicas, traffic, metric, expectedMode: options.expectedMode });
  const revision = active[0]; const container = revision?.properties?.template?.containers?.[0];
  const severe = classifySevereTraces(errors, revision?.name);
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
    severeTraces: severe.traces, currentSevereTraces: severe.current, inactiveSevereTraces: severe.inactive, transitionTraces: severe.transitions,
    riskSignals: [...severe.current, ...severe.inactive].filter((row) => /HALT|READY_FALSE|WATCHDOG|UNKNOWN|OWNER_LOST|STALE/i.test(row.message ?? "")),
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
      console.log(`Trading telemetry: opportunities=${trading.events.queued} prepared=${trading.events.prepared} submitted=${trading.events.submitted} settled=${trading.events.settled} ledger_confirmed=${trading.events.ledgerConfirmed} coverage=${trading.observability.lifecycleCoverage}`);
      console.log(`Durable recovery confirmation: coverage=${trading.observability.reconciliationCoverage} inserted=${trading.observability.recoveredInserted} linked=${trading.observability.recoveredLinked}`);
      console.log(`Current states: waiting=${trading.currentStates.waiting} policy=${trading.currentStates.policy} blocked=${trading.currentStates.blocked} opportunity=${trading.currentStates.opportunity}`);
      console.log(`Severe traces: current=${severe.current.length} inactive=${severe.inactive.length} expected_transition=${severe.transitions.length}${severe.current.length || severe.inactive.length ? ` | ${[...severe.current, ...severe.inactive].slice(0, 3).map((row) => row.message).join("; ")}` : ""}`);
    } else if (options.command === "snapshot") {
      console.log(`Azure production: ${summary.healthy ? "HEALTHY" : "UNHEALTHY"}`);
      console.log(`Revision: ${summary.runtime.revision} | ${summary.runtime.mode} | ${summary.runtime.runningState}/${summary.runtime.healthState}`);
      console.log(`Runtime: traffic=${summary.runtime.trafficWeight}% replicas=${summary.runtime.replicas} ready=${summary.runtime.readyContainers} restarts=${summary.runtime.restarts} image=${summary.runtime.image}`);
      console.log(`Signals: ready=${metric?.ready ?? "missing"} source_lag_p99=${metric?.sourceLagP99 ?? "?"}ms severe_current=${severe.current.length} inactive_severe=${severe.inactive.length} expected_transition=${severe.transitions.length} risk_signals=${summary.riskSignals.length} exit_backlog=${metric?.exitBacklog ?? "?"}`);
    } else if (options.command === "activity") {
      console.log(`Activity telemetry: opportunities=${trading.events.queued} prepared=${trading.events.prepared} submitted=${trading.events.submitted} settled=${trading.events.settled} ledger_confirmed=${trading.events.ledgerConfirmed} unknown=${trading.events.unknown} not_created=${trading.events.notCreated}`);
      console.log(`Durable recovery confirmation: coverage=${trading.observability.reconciliationCoverage} inserted=${trading.observability.recoveredInserted} linked=${trading.observability.recoveredLinked}`);
      console.log(`Decision activity: instruments=${decisions.instruments}/${artifact.enabled_count} | ${topReasons}`);
    } else {
      const blockReasons = Object.entries(trading.blockedReasons).map(([reason, count]) => `${reason}=${count}`).join(", ") || "none";
      console.log(`Blocks: safety_events=${trading.blocked.length} current_safety=${trading.currentStates.blocked} current_policy=${trading.currentStates.policy}`);
      console.log(`Block reasons: ${blockReasons}`);
      console.log(`Optimization: recoverable=${trading.blockClasses.LIKELY_RECOVERABLE} market_moved=${trading.blockClasses.MARKET_MOVED} safety_boundary=${trading.blockClasses.SAFETY_BOUNDARY}`);
      console.log(`Stage coverage: ${Object.entries(trading.blockStages).map(([stage, count]) => `${stage}=${count}`).join(", ") || "none"}`);
      console.log(`Minimum capacity gap: ${trading.minimumCapacityGap ?? "n/a"}`);
    }
    const evidence = (row) => [
      row.decisionId && `decision=${row.decisionId}`, row.clOrdId && `order=${row.clOrdId}`, row.stage && `stage=${row.stage}`,
      row.last && `last=${row.last}`, row.askPx && `ask=${row.askPx}`, row.breakoutPrice && `breakout=${row.breakoutPrice}`, row.dailyLimitPrice && `limit=${row.dailyLimitPrice}`,
      row.breakoutGap !== undefined && `breakout_gap=${row.breakoutGap}`, row.priceLimitGap !== undefined && `price_limit_gap=${row.priceLimitGap}`, row.limitHeadroom !== undefined && `limit_headroom=${row.limitHeadroom}`,
      row.quoteAgeMs !== undefined && `quote_age_ms=${row.quoteAgeMs}`, row.candleAgeMs !== undefined && `candle_age_ms=${row.candleAgeMs}`,
      row.availBuy !== undefined && `avail_buy=${row.availBuy}`, row.remainingCapacity !== undefined && `remaining_capacity=${row.remainingCapacity}`,
      row.availableCapacity !== undefined && `available_capacity=${row.availableCapacity}`, row.minimumCapacity !== undefined && `minimum_capacity=${row.minimumCapacity}`, row.capacityGap !== undefined && `capacity_gap=${row.capacityGap}`,
      row.plannedSize !== undefined && `planned_size=${row.plannedSize}`, row.minSize !== undefined && `min_size=${row.minSize}`,
      row.adjustedEquity !== undefined && `equity=${row.adjustedEquity}`, row.managedExposure !== undefined && `exposure=${row.managedExposure}`, row.leverage !== undefined && `effective_leverage=${row.leverage}`,
      row.exposureScope && `exposure_scope=${row.exposureScope}`, row.equityBasis && `equity_basis=${row.equityBasis}`, row.riskVersion !== undefined && `risk_version=${row.riskVersion}`,
      `class=${row.optimizationClass}`, `boundary=${row.apiBoundary}`,
    ].filter(Boolean).join(" ");
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
      console.log("Attempt timelines:");
      if (!trading.attemptTimelines.length) console.log("  none");
      else for (const attempt of trading.attemptTimelines.slice(0, 100)) {
        console.log(`  ${attempt.instId ?? "?"} route=${attempt.route ?? "?"} decisionId=${attempt.decisionId} clOrdId=${attempt.clOrdId ?? "?"} outcome=${attempt.outcome ?? "?"}`);
        for (const event of attempt.timeline) console.log(`    ${event.timestamp} ${event.stage} ${event.reason}${event.exchangeReason ? ` exchange=${event.exchangeReason}` : ""}`);
      }
      if (trading.attemptTimelines.length > 100) console.log(`  ... ${trading.attemptTimelines.length - 100} more; use --json for all`);
      console.log("Execution details:");
      if (!trading.executions.length) console.log("  none");
      else for (const row of trading.executions.slice(0, 100)) console.log(`  ${row.timestamp} ${row.instId ?? "?"} route=${row.route ?? "?"} ${row.reason} boundary=${row.apiBoundary} decisionId=${row.decisionId ?? "?"} clOrdId=${row.clOrdId ?? "?"}${row.exchangeReason ? ` exchange=${row.exchangeReason}` : ""}`);
      if (trading.executions.length > 100) console.log(`  ... ${trading.executions.length - 100} more; use --json for all`);
    }
  }
  if (options.command === "report" && options.since) await writeFile(checkpointPath, `${JSON.stringify({ checkedAt: queryStartedAt })}\n`, "utf8");
  if (!summary.healthy) process.exitCode = 2;
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
