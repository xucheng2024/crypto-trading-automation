import { createAzureRuntime } from "../../azure/runtime.js";
import { composeProductionRuntime } from "../../application/production-composition.js";
import { createApplicationInsightsTelemetry } from "../../infrastructure/azure/application-insights-telemetry.js";
import http from "node:http";

// Composition root only. Legacy Worker/D1 modules must never be imported here.
export async function startTradingEngine(env = process.env, dependencies = {}) {
  const telemetry = dependencies.telemetry ?? createApplicationInsightsTelemetry({
    connectionString: env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    serviceName: "trading-engine",
    environment: env.DEPLOYMENT_ENVIRONMENT ?? "p5",
    tradingMode: String(env.TRADING_MODE ?? "OFF").toUpperCase(),
  });
  // `lifecycle` remains a narrow test seam.  The normal command constructs
  // its own production graph instead of requiring an externally injected one.
  const composed = dependencies.lifecycle ? { runtime: createAzureRuntime(env, dependencies), ...(dependencies.composed ?? {}) } : await composeProductionRuntime(env, { ...dependencies, telemetry });
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
    await telemetry.flush?.();
    await telemetry.shutdown?.();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  await lifecycle.acquireOwnerAndRecover?.(); // legacy injected test seam
  let offSafeDegraded = null;
  try { await lifecycle.start?.(runtime); }
  catch (error) {
    // An OFF deployment may remain operational when the account has not yet
    // been switched to the profile required for future trading.  The
    // production lifecycle has already released ownership before this error,
    // and OFF still prevents every mutation path.
    if (runtime.config.tradingMode !== "OFF" || error?.message !== "OKX_BASELINE_ACCOUNT_PROFILE") throw error;
    offSafeDegraded = error.message;
    telemetry({ event: "OFF_SAFE_DEGRADED", reason: offSafeDegraded });
  }
  const engine = { runtime, composed, shutdown, startupDegraded: offSafeDegraded, liveness: () => true, readiness: () => Boolean(offSafeDegraded) || (composed.readyGate?.ready ?? runtime.recoveryState.isReady()) };
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
