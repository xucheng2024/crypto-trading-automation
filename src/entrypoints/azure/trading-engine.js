import { createAzureRuntime } from "../../azure/runtime.js";
import { composeProductionRuntime } from "../../application/production-composition.js";
import http from "node:http";

// Composition root only. Legacy Worker/D1 modules must never be imported here.
export async function startTradingEngine(env = process.env, dependencies = {}) {
  // `lifecycle` remains a narrow test seam.  The normal command constructs
  // its own production graph instead of requiring an externally injected one.
  const composed = dependencies.lifecycle ? { runtime: createAzureRuntime(env, dependencies), ...(dependencies.composed ?? {}) } : await composeProductionRuntime(env, dependencies);
  const runtime = composed.runtime; const lifecycle = dependencies.lifecycle ?? composed; let healthServer = null;
  let stopping = false;
  const shutdown = async (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    // Ordered boundary: intake/timers, new mutations, WS, in-flight HTTP,
    // owner unlock, database, health server (the caller owns the last step).
    await lifecycle.stopIntake?.(signal);
    await lifecycle.stopTimers?.();
    await lifecycle.stopNewMutations?.();
    await lifecycle.closeWebSockets?.();
    await lifecycle.finishInFlight?.();
    await lifecycle.releaseOwner?.();
    await lifecycle.closeDatabase?.();
    await lifecycle.closeHealthServer?.();
    if (healthServer) await new Promise((resolve) => healthServer.close(resolve));
    await lifecycle.stop?.();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  await lifecycle.acquireOwnerAndRecover?.(); // legacy injected test seam
  await lifecycle.start?.(runtime);
  const engine = { runtime, composed, shutdown, liveness: () => true, readiness: () => composed.readyGate?.ready ?? runtime.recoveryState.isReady() };
  if (dependencies.health?.enabled) healthServer = createHealthServer(engine, dependencies.health);
  return Object.freeze(engine);
}

export function createHealthServer(engine, { port = Number(process.env.PORT ?? 8080) } = {}) {
  return http.createServer((request, response) => {
    if (request.url === "/health/live") { response.writeHead(engine.liveness() ? 200 : 503); return response.end("live"); }
    if (request.url === "/health/ready") { response.writeHead(engine.readiness() ? 200 : 503); return response.end("ready"); }
    response.writeHead(404); return response.end();
  }).listen(port, "0.0.0.0");
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await startTradingEngine(process.env, { health: { enabled: true } });
}
