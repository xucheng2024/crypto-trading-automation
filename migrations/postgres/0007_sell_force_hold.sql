ALTER TABLE filled_orders
  ADD COLUMN IF NOT EXISTS max_hold_hours numeric,
  ADD COLUMN IF NOT EXISTS force_sell_time bigint,
  ADD COLUMN IF NOT EXISTS sell_trigger_reason text;

ALTER TABLE filled_orders
  DROP CONSTRAINT IF EXISTS filled_orders_max_hold_hours_check,
  ADD CONSTRAINT filled_orders_max_hold_hours_check CHECK (max_hold_hours IS NULL OR max_hold_hours > 0),
  DROP CONSTRAINT IF EXISTS filled_orders_sell_trigger_reason_check,
  ADD CONSTRAINT filled_orders_sell_trigger_reason_check CHECK (sell_trigger_reason IS NULL OR sell_trigger_reason IN ('PRICE_BREAKDOWN','MAX_HOLD_EXPIRED','DELIST'));

ALTER TABLE order_attempts
  ADD COLUMN IF NOT EXISTS max_hold_hours numeric;

ALTER TABLE order_attempts
  DROP CONSTRAINT IF EXISTS order_attempts_max_hold_hours_check,
  ADD CONSTRAINT order_attempts_max_hold_hours_check CHECK (max_hold_hours IS NULL OR max_hold_hours > 0);
