export const CRON_TASKS = new Map([
  ["1,6,11,16,21,26,31,36,41,46,51,56 * * * *", ["monitor_delist", "cancel_pending_limits", "fetch_filled_orders"]],
  ["0,15,30,45 * * * *", ["auto_sell_orders"]],
  ["10 16 * * *", ["fetch_filled_orders"]],
  // 23:55 SGT = 15:55 UTC, 00:05 SGT = 16:05 UTC
  ["55 15 * * *", ["dispatch_reconcile_triggers_cancel"]],
  ["5 16 * * *", ["dispatch_reconcile_triggers_rebuild"]],
]);

export const ALLOWED_TASKS = new Set([
  "monitor_delist",
  "cancel_pending_limits",
  "fetch_filled_orders",
  "auto_sell_orders",
  "dispatch_reconcile_triggers_cancel",
  "dispatch_reconcile_triggers_rebuild",
]);

export const MAX_ACTIVE_POSITIONS = 3;
export const POSITION_GATE_USD = 1;
export const CASH_CURRENCIES = new Set(["USDT", "USDC"]);

export function flagsForCron(cron) {
  return {
    forceDbFetch: cron === "10 16 * * *",
  };
}

export function tradingEnabled(env) {
  return String(env.TRADING_ENABLED || "false").toLowerCase() === "true";
}
