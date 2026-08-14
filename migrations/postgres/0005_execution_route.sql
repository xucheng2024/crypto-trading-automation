ALTER TABLE filled_orders
  ADD COLUMN IF NOT EXISTS execution_route text NOT NULL DEFAULT 'margin';

ALTER TABLE order_attempts
  ADD COLUMN IF NOT EXISTS execution_route text NOT NULL DEFAULT 'margin';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'filled_orders_execution_route_check') THEN
    ALTER TABLE filled_orders ADD CONSTRAINT filled_orders_execution_route_check CHECK (execution_route IN ('margin','spot'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_attempts_execution_route_check') THEN
    ALTER TABLE order_attempts ADD CONSTRAINT order_attempts_execution_route_check CHECK (execution_route IN ('margin','spot'));
  END IF;
END $$;
