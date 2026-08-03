export const CRON_TASKS = new Map([
  ["1,6,11,16,21,26,31,36,41,46,51,56 * * * *", ["monitor_delist", "cancel_pending_limits", "fetch_filled_orders"]],
  ["0,15,30,45 * * * *", ["auto_sell_orders"]],
  ["55 15 * * *", ["auto_sell_orders", "cancel_pending_triggers"]],
  ["5 16 * * *", ["create_algo_triggers"]],
  ["10 16 * * *", ["fetch_filled_orders"]],
]);

export const ALLOWED_TASKS = new Set([
  "monitor_delist",
  "cancel_pending_limits",
  "fetch_filled_orders",
  "auto_sell_orders",
  "cancel_pending_triggers",
  "create_algo_triggers",
]);

export const MAX_ACTIVE_POSITIONS = 3;
export const POSITION_GATE_USD = 1;

export function flagsForCron(cron) {
  return {
    forceDbFetch: cron === "10 16 * * *",
    verifyDailyClose: cron === "55 15 * * *",
  };
}

export function tradingEnabled(env) {
  return String(env.TRADING_ENABLED || "false").toLowerCase() === "true";
}
