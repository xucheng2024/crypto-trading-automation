export const TRADING_MODES = Object.freeze(["OFF", "FULL"]);

const DEFAULTS = Object.freeze({
  QUOTE_MAX_AGE_MS: 1500,
  ACCOUNT_MAX_AGE_MS: 5000,
  ORDER_EXPIRY_MS: 3000,
  HTTP_TIMEOUT_MS: 2500,
  CLOCK_SKEW_ALLOWANCE_MS: 500,
  OWNER_SAFETY_WAIT_MS: 6000,
});

const FORBIDDEN_INLINE_SECRETS = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "POSTGRES_PASSWORD"];

function positiveInteger(env, key) {
  const value = Number(env[key] ?? DEFAULTS[key]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${key}: positive integer required`);
  return value;
}

function strategyConfig(raw) {
  if (!raw) return Object.freeze({ contentHash: null, rows: Object.freeze({}) });
  let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid STRATEGY_CONFIG_JSON"); }
  if (!/^[A-Fa-f0-9]{64}$/.test(parsed.content_hash ?? "") || !Array.isArray(parsed.config)) throw new Error("Invalid STRATEGY_CONFIG_JSON artifact");
  const rows = {};
  for (const row of parsed.config) {
    if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(row.inst_id ?? "") || !(Number(row.hold_hours) > 0) || !(Number(row.best_limit) > 0) || rows[row.inst_id]) throw new Error("Invalid STRATEGY_CONFIG_JSON row");
    if (row.max_hold_hours != null && !(Number(row.max_hold_hours) > Number(row.hold_hours))) throw new Error("Invalid STRATEGY_CONFIG_JSON row");
    rows[row.inst_id] = Object.freeze({ bestLimit: String(row.best_limit), holdHours: String(row.hold_hours), maxHoldHours: row.max_hold_hours != null ? String(row.max_hold_hours) : null });
  }
  return Object.freeze({ contentHash: parsed.content_hash.toLowerCase(), rows: Object.freeze(rows) });
}

export function loadAzureRuntimeConfig(env = {}) {
  const tradingMode = String(env.TRADING_MODE ?? "OFF").toUpperCase();
  if (!TRADING_MODES.includes(tradingMode)) {
    throw new Error(`Invalid TRADING_MODE: ${tradingMode}. Expected OFF or FULL`);
  }
  const values = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key.toLowerCase(), positiveInteger(env, key)]));
  if (values.owner_safety_wait_ms < values.order_expiry_ms + values.http_timeout_ms + values.clock_skew_allowance_ms) {
    throw new Error("OWNER_SAFETY_WAIT_MS must cover ORDER_EXPIRY_MS + HTTP_TIMEOUT_MS + CLOCK_SKEW_ALLOWANCE_MS");
  }
  if (env.POSTGRES_URL && !String(env.POSTGRES_URL).startsWith("postgresql://") && !String(env.POSTGRES_URL).startsWith("postgres://")) throw new Error("POSTGRES_URL must be a PostgreSQL connection string");
  for (const key of FORBIDDEN_INLINE_SECRETS) if (env[key]) throw new Error(`${key} is forbidden; use managed identity and Key Vault secret names`);
  const entityProfile = String(env.OKX_ENTITY_PROFILE ?? "GLOBAL").toUpperCase();
  if (entityProfile !== "GLOBAL") throw new Error(`Unsupported OKX_ENTITY_PROFILE: ${entityProfile}`);
  const secretNames = Object.freeze({ apiKey: env.OKX_API_KEY_SECRET_NAME ?? "okx-api-key", secretKey: env.OKX_SECRET_KEY_SECRET_NAME ?? "okx-secret-key", passphrase: env.OKX_PASSPHRASE_SECRET_NAME ?? "okx-passphrase" });
  for (const [key, value] of Object.entries(secretNames)) if (!/^[a-zA-Z0-9-]+$/.test(value)) throw new Error(`Invalid ${key} secret name`);
  const instrumentIds = Object.freeze([...new Set(String(env.OKX_INSTRUMENTS ?? "").split(",").map((value) => value.trim()).filter(Boolean))]);
  if (instrumentIds.some((instId) => !/^[A-Z0-9]+-[A-Z0-9]+$/.test(instId))) throw new Error("Invalid OKX_INSTRUMENTS");
  const managedFillStartMs = Number(env.MANAGED_FILL_START_MS ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(managedFillStartMs) || managedFillStartMs < 0) throw new Error("Invalid MANAGED_FILL_START_MS");
  return Object.freeze({ tradingMode, ...values, keyVaultUri: env.KEY_VAULT_URI, postgresUrl: env.POSTGRES_URL, accountId: env.OKX_ACCOUNT_ID ?? "default", entityProfile, strategyTag: env.OKX_STRATEGY_TAG ?? "azure", orderVersion: env.ORDER_VERSION ?? "v1", managedFillStartMs, strategyConfig: strategyConfig(env.STRATEGY_CONFIG_JSON), secretNames, instrumentIds });
}
