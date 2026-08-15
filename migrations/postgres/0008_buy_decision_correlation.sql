ALTER TABLE order_attempts
  ADD COLUMN IF NOT EXISTS decision_id text;

CREATE UNIQUE INDEX IF NOT EXISTS order_attempts_decision_id_uq
  ON order_attempts(decision_id) WHERE decision_id IS NOT NULL;
