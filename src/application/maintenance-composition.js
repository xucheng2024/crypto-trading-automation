import { retainTerminalAttemptsAsMaintenance } from '../infrastructure/postgres/retention.js';

export async function runMaintenanceCycle({ tx, management = {}, telemetry = () => {}, now = () => Date.now(), retentionBefore, retentionLimit = 500, interrupted = () => false } = {}) {
  if (!tx) throw new TypeError('maintenance requires PostgreSQL transaction');
  const safely = async (name, fn) => { try { return await fn(); } catch { void Promise.resolve().then(() => telemetry({ reason: `${name}_FAILED` })).catch(() => {}); return { ok: false }; } };
  if (interrupted()) return { interrupted: true };
  const retention = await retainTerminalAttemptsAsMaintenance(tx, { before: retentionBefore ?? new Date(now() - 90 * 86400000), limit: retentionLimit });
  if (interrupted()) return { interrupted: true, retention };
  const [postgres, appInsights, keyVault, nat] = await Promise.all([
    safely('POSTGRES_CAPACITY', () => management.postgresCapacity?.() ?? { ok: true }), safely('APPINSIGHTS_CAP', () => management.appInsightsCap?.() ?? { ok: true }), safely('KEYVAULT_EXPIRY', () => management.keyVaultExpiry?.() ?? { ok: true }), safely('NAT_IP', () => management.natIp?.() ?? { ok: true }),
  ]);
  // Announcement polling and reconciliation require OKX and are Engine timers,
  // never a credential-free maintenance Job concern.
  return { retention: retention.rowCount ?? 0, postgres, appInsights, keyVault, nat };
}
