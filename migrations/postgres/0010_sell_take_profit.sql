ALTER TABLE filled_orders
  DROP CONSTRAINT IF EXISTS filled_orders_sell_trigger_reason_check;

ALTER TABLE filled_orders
  ADD CONSTRAINT filled_orders_sell_trigger_reason_check
  CHECK (sell_trigger_reason IS NULL OR sell_trigger_reason IN ('PRICE_BREAKDOWN','MAX_HOLD_EXPIRED','DELIST','TAKE_PROFIT'))
  NOT VALID;

ALTER TABLE filled_orders
  VALIDATE CONSTRAINT filled_orders_sell_trigger_reason_check;
