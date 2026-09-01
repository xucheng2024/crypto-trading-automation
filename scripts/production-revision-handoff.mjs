import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TERMINAL_FAILURES = new Set(["ActivationFailed", "Degraded", "Failed"]);
const TRANSIENT_AZURE_FAILURE = /(?:429|5\d\d|TooManyRequests|temporar(?:y|ily)|timed? ?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)/i;
const ALREADY_REQUESTED = /RevisionAlreadyInRequestedState/;

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseHandoffArgs(argv) {
  const options = { execute: false, emergency: false, timeoutMs: 240_000, pollMs: 5_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--emergency") options.emergency = true;
    else if (["--resource-group", "--app", "--target-revision", "--expect-mode", "--timeout-seconds", "--poll-seconds"].includes(arg)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      const key = {
        "--resource-group": "resourceGroup",
        "--app": "app",
        "--target-revision": "targetRevision",
        "--expect-mode": "expectedMode",
      }[arg];
      if (key) options[key] = value;
      else if (arg === "--timeout-seconds") options.timeoutMs = positiveInteger(value, arg) * 1_000;
      else options.pollMs = positiveInteger(value, arg) * 1_000;
    } else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.help) return options;
  required(options.resourceGroup, "--resource-group");
  required(options.app, "--app");
  required(options.targetRevision, "--target-revision");
  required(options.expectedMode, "--expect-mode");
  if (!["OFF", "FULL"].includes(options.expectedMode)) throw new Error("--expect-mode must be OFF or FULL");
  return options;
}

export function createAzureClient({ resourceGroup, app }, exec = execFileSync, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const common = ["--resource-group", resourceGroup, "--name", app, "--only-show-errors", "--output", "json"];
  const az = async (args) => {
    const output = await exec("az", [...args, ...common], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return output.trim() ? JSON.parse(output) : null;
  };
  const read = async (args) => {
    let failure;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await az(args); }
      catch (error) {
        failure = error;
        if (attempt === 2 || !TRANSIENT_AZURE_FAILURE.test(`${error?.message ?? ""}\n${error?.stderr ?? ""}`)) throw error;
        await sleep(250 * (2 ** attempt));
      }
    }
    throw failure;
  };
  return {
    app: () => read(["containerapp", "show", "--query", "{provisioningState:properties.provisioningState,runningStatus:properties.runningStatus,revisionMode:properties.configuration.activeRevisionsMode}"]),
    revision: (revision) => read(["containerapp", "revision", "show", "--revision", revision, "--query", "{name:name,active:properties.active,healthState:properties.healthState,runningState:properties.runningState,image:properties.template.containers[0].image,mode:properties.template.containers[0].env[?name=='TRADING_MODE'].value|[0]}"]),
    activeRevisions: () => read(["containerapp", "revision", "list", "--query", "[?properties.active].{name:name,healthState:properties.healthState,runningState:properties.runningState}"]),
    replicas: async (revision) => await read(["containerapp", "replica", "list", "--revision", revision, "--query", "[].{containers:properties.containers[].{ready:ready,restartCount:restartCount,runningState:runningState}}"]) ?? [],
    traffic: () => read(["containerapp", "ingress", "traffic", "show"]),
    setTraffic: (revision) => az(["containerapp", "ingress", "traffic", "set", "--revision-weight", `${revision}=100`]),
    activate: (revision) => az(["containerapp", "revision", "activate", "--revision", revision]),
    deactivate: (revision) => az(["containerapp", "revision", "deactivate", "--revision", revision]),
  };
}

function revisionReady(revision, replicas) {
  const containers = replicas.flatMap((replica) => replica.containers ?? []);
  return revision.active === true
    && revision.healthState === "Healthy"
    && revision.runningState === "RunningAtMaxScale"
    && replicas.length === 1
    && containers.length > 0
    && containers.every((container) => container.ready === true && container.runningState === "Running" && Number(container.restartCount ?? 0) === 0);
}

async function waitFor(label, check, { timeoutMs, pollMs, sleep, now, log }) {
  const deadline = now() + timeoutMs;
  let last;
  while (now() <= deadline) {
    last = await check();
    if (last.done) return last.value;
    if (last.failed) throw new Error(`${label} failed: ${last.detail}`);
    log(`${label}: ${last.detail}`);
    await sleep(pollMs);
  }
  throw new Error(`${label} timed out: ${last?.detail ?? "no status"}`);
}

async function waitStopped(client, revision, wait) {
  return waitFor(`stop ${revision}`, async () => {
    const [state, replicas] = await Promise.all([client.revision(revision), client.replicas(revision)]);
    return { done: state.active === false && replicas.length === 0, detail: `active=${state.active} replicas=${replicas.length}` };
  }, wait);
}

async function waitReady(client, revisionName, wait) {
  return waitFor(`ready ${revisionName}`, async () => {
    const [revision, replicas] = await Promise.all([client.revision(revisionName), client.replicas(revisionName)]);
    const detail = `${revision.runningState}/${revision.healthState} replicas=${replicas.length}`;
    return { done: revisionReady(revision, replicas), failed: TERMINAL_FAILURES.has(revision.runningState), detail, value: { revision, replicas } };
  }, wait);
}

async function verifyFinal(client, targetRevision, expectedMode, revisionMode) {
  const [app, active, target, replicas, traffic] = await Promise.all([
    client.app(), client.activeRevisions(), client.revision(targetRevision), client.replicas(targetRevision), client.traffic(),
  ]);
  const totalTraffic = traffic.reduce((sum, row) => sum + Number(row?.weight ?? 0), 0);
  const targetTraffic = totalTraffic === 100 && (revisionMode === "Single" || (traffic.length === 1 && traffic[0]?.revisionName === targetRevision));
  const checks = {
    appHealthy: app.provisioningState === "Succeeded" && app.runningStatus === "Running",
    singleActiveTarget: active.length === 1 && active[0]?.name === targetRevision,
    targetReady: revisionReady(target, replicas),
    expectedMode: target.mode === expectedMode,
    targetTraffic,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`FINAL_VERIFICATION_FAILED ${JSON.stringify(checks)}`);
  return checks;
}

async function snapshot(client, targetRevision, stage) {
  const [app, active, target, replicas, traffic] = await Promise.all([
    client.app(), client.activeRevisions(), client.revision(targetRevision), client.replicas(targetRevision), client.traffic(),
  ]);
  const containers = replicas.flatMap((replica) => replica.containers ?? []);
  return {
    stage,
    revisionMode: app.revisionMode,
    activeRevisions: active.length,
    sourceRevisions: active.filter((revision) => revision.name !== targetRevision).length,
    target: { active: target.active === true, mode: target.mode ?? null, runningState: target.runningState ?? null, healthState: target.healthState ?? null, replicas: replicas.length, readyReplicas: containers.some((container) => container.ready === true) ? replicas.length : 0 },
    traffic: { totalWeight: traffic.reduce((sum, row) => sum + Number(row?.weight ?? 0), 0), targetWeight: traffic.filter((row) => row?.revisionName === targetRevision).reduce((sum, row) => sum + Number(row?.weight ?? 0), 0) },
  };
}

async function idempotentWrite(label, operation, log) {
  try { return await operation(); }
  catch (error) {
    if (!ALREADY_REQUESTED.test(`${error?.message ?? ""}\n${error?.stderr ?? ""}`)) throw error;
    log(`${label}: RevisionAlreadyInRequestedState`);
    return null;
  }
}

async function deactivateAndWait(client, revision, wait, log) {
  await idempotentWrite(`deactivate ${revision}`, () => client.deactivate(revision), log);
  await waitStopped(client, revision, wait);
}

async function activateAndWait(client, revision, wait, log) {
  await idempotentWrite(`activate ${revision}`, () => client.activate(revision), log);
  await waitReady(client, revision, wait);
}

export async function handoffRevision(options, dependencies = {}) {
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const client = dependencies.client ?? createAzureClient(options, dependencies.exec, sleep);
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? ((message) => console.error(message));
  const wait = { timeoutMs: options.timeoutMs ?? 240_000, pollMs: options.pollMs ?? 5_000, sleep, now, log };
  const app = await client.app();
  if (!options.emergency && (app.provisioningState !== "Succeeded" || app.runningStatus !== "Running")) throw new Error("SOURCE_APP_NOT_HEALTHY");
  if (!["Single", "Multiple"].includes(app.revisionMode)) throw new Error(`UNSUPPORTED_REVISION_MODE ${app.revisionMode ?? "missing"}`);
  const target = await client.revision(options.targetRevision);
  if (target.mode !== options.expectedMode) throw new Error(`TARGET_MODE_MISMATCH expected=${options.expectedMode} actual=${target.mode ?? "missing"}`);
  if (!target.image?.includes("@sha256:")) throw new Error("TARGET_IMAGE_MUST_USE_DIGEST");

  const active = await client.activeRevisions();
  const sources = active.filter((revision) => revision.name !== options.targetRevision);
  if (sources.length > 1 && !options.emergency) throw new Error(`MULTIPLE_SOURCE_REVISIONS ${sources.map((revision) => revision.name).join(",")}`);
  const source = sources[0] ?? null;
  if (source && !options.emergency) {
    const sourceReplicas = await client.replicas(source.name);
    if (!revisionReady({ ...source, active: true }, sourceReplicas)) throw new Error(`SOURCE_NOT_HEALTHY ${source.name}`);
  }

  const plan = { targetRevision: options.targetRevision, sourceRevision: source?.name ?? null, sourceRevisions: sources.map((revision) => revision.name), expectedMode: options.expectedMode, revisionMode: app.revisionMode, emergency: options.emergency === true };
  const snapshots = [];
  const recordSnapshot = async (stage) => {
    const value = await snapshot(client, options.targetRevision, stage);
    snapshots.push(value); log(`handoff_snapshot ${JSON.stringify(value)}`);
    return value;
  };
  await recordSnapshot("PRECHECK");
  if (!options.execute) return { status: "DRY_RUN", plan, snapshots };

  let mutated = false;
  try {
    const targetReplicas = await client.replicas(options.targetRevision);
    if (revisionReady(target, targetReplicas)) {
      await recordSnapshot("TARGET_READY");
      if (app.revisionMode === "Multiple") { mutated = true; await client.setTraffic(options.targetRevision); }
      for (const sourceRevision of sources) { mutated = true; await deactivateAndWait(client, sourceRevision.name, wait, log); }
    } else {
      if (app.revisionMode === "Multiple" && source && source.healthState === "Healthy" && source.runningState === "RunningAtMaxScale") { mutated = true; await client.setTraffic(source.name); }
      if (target.active) { mutated = true; await deactivateAndWait(client, options.targetRevision, wait, log); }
      for (const sourceRevision of sources) { mutated = true; await deactivateAndWait(client, sourceRevision.name, wait, log); }
      await recordSnapshot("SOURCES_STOPPED");
      mutated = true; await activateAndWait(client, options.targetRevision, wait, log);
      await recordSnapshot("TARGET_READY_AFTER_START");
      if (app.revisionMode === "Multiple") await client.setTraffic(options.targetRevision);
    }
    const checks = await verifyFinal(client, options.targetRevision, options.expectedMode, app.revisionMode);
    await recordSnapshot("FINAL");
    return { status: "COMPLETE", plan, checks, snapshots };
  } catch (error) {
    try { await recordSnapshot("FAILURE"); } catch (snapshotError) { log(`handoff_snapshot_unavailable ${snapshotError.message}`); }
    if (!mutated || !source) throw error;
    let rollback = "FAILED";
    try {
      const currentTarget = await client.revision(options.targetRevision);
      if (currentTarget.active) await deactivateAndWait(client, options.targetRevision, wait, log);
      await activateAndWait(client, source.name, wait, log);
      if (app.revisionMode === "Multiple") await client.setTraffic(source.name);
      rollback = "COMPLETE";
      await recordSnapshot("ROLLBACK_COMPLETE");
    } catch (rollbackError) {
      rollback = `FAILED:${rollbackError.message}`;
    }
    throw new Error(`HANDOFF_FAILED ${error.message} rollback=${rollback}`);
  }
}

function usage() {
  return [
    "Usage: npm run ops:handoff -- --resource-group RG --app APP --target-revision REV --expect-mode OFF|FULL [--execute] [--emergency]",
    "Without --execute the command performs validation and prints the planned handoff.",
    "Use --emergency only with explicit operator authorization when the current source revision is unhealthy.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseHandoffArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else console.log(JSON.stringify(await handoffRevision(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
