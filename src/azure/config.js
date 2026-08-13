export const TRADING_MODES = Object.freeze(["OFF", "EXIT_ONLY", "FULL"]);

export function loadAzureRuntimeConfig(env = {}) {
  const tradingMode = String(env.TRADING_MODE ?? "OFF").toUpperCase();
  if (!TRADING_MODES.includes(tradingMode)) {
    throw new Error(`Invalid TRADING_MODE: ${tradingMode}. Expected OFF, EXIT_ONLY, or FULL`);
  }
  return Object.freeze({ tradingMode });
}
