// P3 retention is deliberately a small, versioned statement rather than an
// OperationsRepository. Its predicate can only remove terminal attempts; all
// fills, protection receipts and sync watermarks are durable ledger inputs.
export const P3_RETENTION_VERSION = "p3-retention-v1";
export const P3_DELETE_TERMINAL_ATTEMPTS_SQL = `
  DELETE FROM order_attempts
  WHERE id IN (
    SELECT id FROM order_attempts
    WHERE state IN ('NOT_CREATED','SETTLED')
      AND updated_at < $1
    ORDER BY id
    LIMIT $2
  )
  RETURNING id`;

export async function retainTerminalAttempts(tx, { before, limit }) {
  if (!(before instanceof Date) || !Number.isInteger(limit) || limit <= 0) throw new TypeError("fixed P3 retention arguments required");
  return tx.query(P3_DELETE_TERMINAL_ATTEMPTS_SQL, [before, limit]);
}
