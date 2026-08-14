ALTER TABLE filled_orders
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'cross';

ALTER TABLE order_attempts
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'cross';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'filled_orders_execution_mode_check') THEN
    ALTER TABLE filled_orders ADD CONSTRAINT filled_orders_execution_mode_check CHECK (execution_mode IN ('cross','cash'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_attempts_execution_mode_check') THEN
    ALTER TABLE order_attempts ADD CONSTRAINT order_attempts_execution_mode_check CHECK (execution_mode IN ('cross','cash'));
  END IF;
END $$;
