import appInsights from "applicationinsights";

const SECRET_KEY = /(secret|password|token|passphrase|api.?key|connection)/i;
const IMPORTANT = /(FAILED|ERROR|UNKNOWN|LOST|HALT|DEGRADED|SHORTFALL|STALE|BLOCKED|DEFERRED|EXITING|SUBMITTED|RECOVER|READY_FALSE|UNAVAILABLE)/;
const REPEAT_WINDOW_MS = 15 * 60_000;
const REPEATED_DECISIONS = new Set(["ABOVE_COUNT_PRICE", "ABOVE_BUY_PRICE", "SKIPPED_FIRST_TWO", "DAILY_OPEN_PENDING", "QUOTE_STALE", "ASK_ABOVE_LIMIT"]);
const REPEATED_PROTECTION = new Set(["SELL_QUOTE_STALE", "SELL_CANDLE_PENDING", "SELL_CANDLE_STALE"]);

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
  if (["trading_decision", "block_evidence", "order_lifecycle", "trade_lifecycle", "sell_watch_armed", "sell_watch_loaded", "fill_reconciliation", "metric_snapshot", "strategy_baseline", "instrument_pipeline_coverage"].includes(event.type)) return true;
  if (event.type === "sell_protection") return /SELL_(CANDLE_(PENDING|MISSING|STALE)|QUOTE_STALE|PROTECTION_(UNARMED|MISSING)|ANCHOR_RECOVERY_FAILED|CLOCK_SYNC_STALE)/.test(event.reason ?? "");
  if (event.error || event?.event?.startsWith("MAINTENANCE_") || event.type === "recovery_loaded") return true;
  return IMPORTANT.test([event.reason, event.outcome, ...(event.reasons ?? [])].filter(Boolean).join(" "));
}

function repeatedState(event) {
  const reason = String(event?.reason ?? "");
  const repeated = event?.type === "trading_decision" ? REPEATED_DECISIONS.has(reason) : event?.type === "sell_protection" ? REPEATED_PROTECTION.has(reason) : false;
  if (!["trading_decision", "sell_protection"].includes(event?.type)) return null;
  return { key: `${event.type}:${event.instId ?? "global"}`, signature: reason, repeated };
}

export function createApplicationInsightsTelemetry({
  connectionString,
  serviceName = "trading-engine",
  environment = "p5",
  tradingMode = "OFF",
  Client = appInsights.TelemetryClient,
  client,
  fallback = (event) => console.error(JSON.stringify(event)),
  now = () => Date.now(),
  repeatWindowMs = REPEAT_WINDOW_MS,
} = {}) {
  if (!Number.isSafeInteger(repeatWindowMs) || repeatWindowMs < 0) throw new TypeError("repeatWindowMs must be a non-negative safe integer");
  const telemetryClient = client ?? (connectionString ? new Client(connectionString, { useGlobalProviders: false }) : null);
  if (telemetryClient) {
    telemetryClient.config.samplingPercentage = 100;
    Object.assign(telemetryClient.commonProperties, { service: serviceName, environment, tradingMode });
  }
  const lastRepeated = new Map();
  const telemetry = (event) => {
    if (!isImportantTelemetry(event)) return;
    try {
      if (!telemetryClient) return fallback(event);
      const state = repeatedState(event);
      if (state) {
        const timestamp = now(); const previous = lastRepeated.get(state.key);
        if (state.repeated && previous?.signature === state.signature && timestamp - previous.at < repeatWindowMs) return;
        if (state.repeated) lastRepeated.set(state.key, { signature: state.signature, at: timestamp });
        else lastRepeated.delete(state.key);
        if (lastRepeated.size > 4096) for (const [key, value] of lastRepeated) if (timestamp - value.at >= repeatWindowMs) lastRepeated.delete(key);
      }
      const message = messageFor(event);
      const severe = Boolean(event.error) || /(FAILED|ERROR|UNKNOWN|LOST|HALT|SHORTFALL)/.test(message);
      telemetryClient.trackTrace({ message, severity: severe ? 3 : 2, properties: safeProperties(event) });
      if (event.type === "metric_snapshot") for (const [name, value] of Object.entries(event)) if (name !== "type" && name !== "reason" && Number.isFinite(value)) telemetryClient.trackMetric?.({ name, value });
    } catch { /* telemetry must never change trading behavior */ }
  };
  telemetry.flush = async () => { try { await telemetryClient?.flush?.(); } catch {} };
  telemetry.shutdown = async () => { try { await telemetryClient?.shutdown?.(); } catch {} };
  return telemetry;
}
