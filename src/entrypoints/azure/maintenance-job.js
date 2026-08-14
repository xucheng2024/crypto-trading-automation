import { retainTerminalAttemptsAsMaintenance } from "../../infrastructure/postgres/retention.js";

/** Maintenance deliberately has no OKX credential or mutation dependency. */
export async function runMaintenance({ tx, before, limit = 500, checks = {} } = {}) {
  if (!tx) throw new TypeError("maintenance requires a PostgreSQL transaction");
  const retention = await retainTerminalAttemptsAsMaintenance(tx, { before: before ?? new Date(Date.now() - 90 * 86400000), limit });
  const health = {};
  for (const [name, check] of Object.entries(checks)) {
    try { health[name] = await check(); } catch { health[name] = { ok: false, reason: "CHECK_FAILED" }; }
  }
  // The caller controls the calendar; a missed daily Job can safely replay this.
  return { retentionCount: retention.rowCount ?? retention.rows?.length ?? 0, health };
}
