import appInsights from "applicationinsights";

const SECRET_KEY = /(secret|password|token|passphrase|api.?key|connection)/i;
const IMPORTANT = /(FAILED|ERROR|UNKNOWN|LOST|HALT|DEGRADED|SHORTFALL|STALE|BLOCKED|DEFERRED|EXITING|SUBMITTED|RECOVER|READY_FALSE)/;

function safeProperties(event) {
  const properties = {};
  for (const [key, value] of Object.entries(event ?? {})) {
    if (SECRET_KEY.test(key) || value === undefined || value === null || typeof value === "object") continue;
    properties[key] = String(value).slice(0, 512);
  }
  return properties;
}

function messageFor(event) {
  const signals = [event?.reason, ...(Array.isArray(event?.reasons) ? event.reasons : []), event?.outcome].filter(Boolean);
  return [event?.event ?? event?.type ?? "TRADING_EVENT", ...signals].join(" ").slice(0, 2048);
}

export function isImportantTelemetry(event) {
  if (!event || typeof event !== "object") return false;
  if (event.error || event.event === "OFF_SAFE_DEGRADED" || event?.event?.startsWith("MAINTENANCE_") || event.type === "recovery_loaded") return true;
  return IMPORTANT.test([event.reason, event.outcome, ...(event.reasons ?? [])].filter(Boolean).join(" "));
}

export function createApplicationInsightsTelemetry({
  connectionString,
  serviceName = "trading-engine",
  environment = "p5",
  tradingMode = "OFF",
  Client = appInsights.TelemetryClient,
  client,
  fallback = (event) => console.error(JSON.stringify(event)),
} = {}) {
  const telemetryClient = client ?? (connectionString ? new Client(connectionString, { useGlobalProviders: false }) : null);
  if (telemetryClient) {
    telemetryClient.config.samplingPercentage = 100;
    Object.assign(telemetryClient.commonProperties, { service: serviceName, environment, tradingMode });
  }
  const telemetry = (event) => {
    if (!isImportantTelemetry(event)) return;
    try {
      if (!telemetryClient) return fallback(event);
      const message = messageFor(event);
      const severe = Boolean(event.error) || /(FAILED|ERROR|UNKNOWN|LOST|HALT|SHORTFALL)/.test(message);
      telemetryClient.trackTrace({ message, severity: severe ? 3 : 2, properties: safeProperties(event) });
    } catch { /* telemetry must never change trading behavior */ }
  };
  telemetry.flush = async () => { try { await telemetryClient?.flush?.(); } catch {} };
  telemetry.shutdown = async () => { try { await telemetryClient?.shutdown?.(); } catch {} };
  return telemetry;
}
