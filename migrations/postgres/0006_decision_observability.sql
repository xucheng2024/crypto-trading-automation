ALTER TABLE daily_limit_cache
  ADD COLUMN IF NOT EXISTS today_candle_ts bigint,
  ADD COLUMN IF NOT EXISTS today_open numeric,
  ADD COLUMN IF NOT EXISTS yesterday_candle_ts bigint,
  ADD COLUMN IF NOT EXISTS yesterday_open numeric,
  ADD COLUMN IF NOT EXISTS yesterday_close numeric,
  ADD COLUMN IF NOT EXISTS best_limit numeric,
  ADD COLUMN IF NOT EXISTS tick_sz numeric,
  ADD COLUMN IF NOT EXISTS strategy_config_hash text;

ALTER TABLE filled_orders
  ADD COLUMN IF NOT EXISTS source_attempt_cl_ord_id text,
  ADD COLUMN IF NOT EXISTS fill_price numeric,
  ADD COLUMN IF NOT EXISTS fee numeric,
  ADD COLUMN IF NOT EXISTS fee_ccy text,
  ADD COLUMN IF NOT EXISTS min_price_after_fill numeric,
  ADD COLUMN IF NOT EXISTS max_adverse_pct numeric;

ALTER TABLE filled_orders
  DROP CONSTRAINT IF EXISTS filled_orders_fill_price_check,
  ADD CONSTRAINT filled_orders_fill_price_check CHECK (fill_price IS NULL OR fill_price > 0),
  DROP CONSTRAINT IF EXISTS filled_orders_min_price_after_fill_check,
  ADD CONSTRAINT filled_orders_min_price_after_fill_check CHECK (min_price_after_fill IS NULL OR min_price_after_fill > 0),
  DROP CONSTRAINT IF EXISTS filled_orders_max_adverse_pct_check,
  ADD CONSTRAINT filled_orders_max_adverse_pct_check CHECK (max_adverse_pct IS NULL OR max_adverse_pct >= 0);

ALTER TABLE order_attempts
  ADD COLUMN IF NOT EXISTS decision_trigger_price numeric,
  ADD COLUMN IF NOT EXISTS decision_reference_price numeric,
  ADD COLUMN IF NOT EXISTS decision_reason text;

ALTER TABLE order_attempts
  DROP CONSTRAINT IF EXISTS order_attempts_decision_trigger_price_check,
  ADD CONSTRAINT order_attempts_decision_trigger_price_check CHECK (decision_trigger_price IS NULL OR decision_trigger_price > 0),
  DROP CONSTRAINT IF EXISTS order_attempts_decision_reference_price_check,
  ADD CONSTRAINT order_attempts_decision_reference_price_check CHECK (decision_reference_price IS NULL OR decision_reference_price > 0);

CREATE INDEX IF NOT EXISTS filled_orders_source_attempt_idx
  ON filled_orders(source_attempt_cl_ord_id) WHERE source_attempt_cl_ord_id IS NOT NULL;
