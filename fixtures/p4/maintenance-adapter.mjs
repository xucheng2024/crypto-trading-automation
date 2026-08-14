export async function createMaintenanceDependencies() {
  return {
    tx: { query: async () => ({ rowCount: 0 }) },
    before: new Date(0),
    checks: { postgres_capacity: async () => ({ ok: true }), nat_ip: async () => ({ ok: true }) },
    reconciliation: async () => ({ ok: true, mode: 'fixture' }),
  };
}
