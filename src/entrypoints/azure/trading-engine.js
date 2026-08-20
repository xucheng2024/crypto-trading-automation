import { createAzureRuntime } from "../../azure/runtime.js";
import { composeProductionRuntime } from "../../application/production-composition.js";
import { createApplicationInsightsTelemetry } from "../../infrastructure/azure/application-insights-telemetry.js";
import http from "node:http";

// Production composition root. Exchange mutations remain behind the sole Coordinator.
export async function startTradingEngine(env = process.env, dependencies = {}) {
  const telemetry = dependencies.telemetry ?? createApplicationInsightsTelemetry({
    connectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    serviceName: "trading-engine",
    environment: env.DEPLOYMENT_ENVIRONMENT ?? "p5",
    tradingMode: String(env.TRADING_MODE ?? "OFF").toUpperCase(),
  });
  // Bring liveness up before remote baseline work. Readiness remains false
  // until the fully composed runtime has completed recovery and baselines.
  let healthDelegate = null; let healthServer = null;
  if (dependencies.health?.enabled) healthServer = createHealthServer({ liveness: () => true, readiness: () => healthDelegate?.readiness?.() ?? false, readinessDetails: () => healthDelegate?.readinessDetails?.() ?? { ready: false, bootstrap: true } }, dependencies.health);
  // `lifecycle` remains a narrow test seam.  The normal command constructs
  // its own production graph instead of requiring an externally injected one.
  let composed;
  try { composed = dependencies.lifecycle ? { runtime: createAzureRuntime(env, dependencies), ...(dependencies.composed ?? {}) } : await composeProductionRuntime(env, { ...dependencies, telemetry }); }
  catch (error) { if (healthServer) await new Promise((resolve) => healthServer.close(resolve)); throw error; }
  const runtime = composed.runtime; const lifecycle = dependencies.lifecycle ?? composed;
  const exitProcess = dependencies.exitProcess ?? ((code) => process.exit(code));
  let stopping = false; let shutdownPromise = null; let ownerLossUnsubscribe = null;
  const shutdown = (signal = "SIGTERM") => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    ownerLossUnsubscribe?.(); ownerLossUnsubscribe = null;
    // Ordered boundary: intake/timers, new mutations, WS, in-flight HTTP,
    // owner unlock, database, health server (the caller owns the last step).
    shutdownPromise = (async () => {
      const failures = [];
      const close = async (operation) => { try { await operation?.(); } catch (error) { failures.push(error); } };
      await close(() => lifecycle.stopIntake?.(signal));
      await close(() => lifecycle.stopTimers?.());
      await close(() => lifecycle.stopNewMutations?.());
      await close(() => lifecycle.closeWebSockets?.());
      await close(() => lifecycle.finishInFlight?.());
      await close(() => lifecycle.releaseOwner?.());
      await close(() => lifecycle.closeDatabase?.());
      await close(() => lifecycle.closeHealthServer?.());
      if (healthServer) await close(() => new Promise((resolve) => healthServer.close(resolve)));
      await close(() => lifecycle.stop?.());
      await close(() => telemetry.flush?.());
      await close(() => telemetry.shutdown?.());
      if (failures.length) try { telemetry({ type: "runtime_shutdown", reason: "CLEANUP_FAILED", failedSteps: failures.length }); } catch { /* shutdown remains best effort */ }
    })();
    return shutdownPromise;
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  ownerLossUnsubscribe = lifecycle.onOwnerLost?.(() => {
    if (stopping) return;
    try { telemetry({ type: "owner_recovery", reason: "OWNER_SESSION_LOST_RESTARTING" }); } catch { /* loss recovery must not depend on telemetry */ }
    // The dedicated PostgreSQL session owns the advisory lock. Rebuilding the
    // entire process is deliberate: startup obtains a new session and reruns
    // durable reconciliation plus every market/account baseline before READY.
    void shutdown("OWNER_SESSION_LOST").then(() => exitProcess(1), () => exitProcess(1));
  }) ?? null;
  await lifecycle.acquireOwnerAndRecover?.(); // legacy injected test seam
  try { await lifecycle.start?.(runtime); }
  catch (error) { if (healthServer) await new Promise((resolve) => healthServer.close(resolve)); throw error; }
  const engine = {
    runtime, composed, shutdown, startupDegraded: null,
    liveness: () => true,
    readiness: () => composed.readyGate?.ready ?? runtime.recoveryState.isReady(),
    readinessDetails: () => composed.readyGate?.snapshot?.() ?? { ready: runtime.recoveryState.isReady() },
  };
  healthDelegate = engine;
  return Object.freeze(engine);
}

export function createHealthServer(engine, { port = Number(process.env.PORT ?? 8080) } = {}) {
  return http.createServer((request, response) => {
    if (request.url === "/health/live") { response.writeHead(engine.liveness() ? 200 : 503); return response.end("live"); }
    if (request.url === "/health/ready") {
      const ready = engine.readiness(); response.writeHead(ready ? 200 : 503, { "Content-Type": ready ? "text/plain" : "application/json" });
      return response.end(ready ? "ready" : JSON.stringify(engine.readinessDetails?.() ?? { ready: false }));
    }
    response.writeHead(404); return response.end();
  }).listen(port, "0.0.0.0");
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await startTradingEngine(process.env, { health: { enabled: true } });
}
