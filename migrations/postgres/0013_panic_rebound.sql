-- Panic-rebound strategy day state.  One row per (UTC+8 day, instrument):
-- the day's open and derived prices, plus the first 82% touch that ranks the
-- instrument in the day's count and the first 72% touch that made it buyable.
CREATE TABLE IF NOT EXISTS panic_daily_instruments (
  strategy_day date NOT NULL,
  inst_id text NOT NULL,
  open_price numeric NOT NULL CHECK (open_price > 0),
  open_ts bigint NOT NULL,
  open_source text NOT NULL CHECK (open_source IN ('TICKER_SOD_UTC8','CANDLE_1D')),
  tick_sz numeric NOT NULL CHECK (tick_sz > 0),
  count_price numeric NOT NULL CHECK (count_price > 0),
  buy_price numeric NOT NULL CHECK (buy_price > 0 AND buy_price < count_price),
  count_hit_at bigint,
  count_hit_price numeric CHECK (count_hit_price IS NULL OR count_hit_price > 0),
  count_hit_source text CHECK (count_hit_source IS NULL OR count_hit_source IN ('LIVE','BACKFILL')),
  buy_hit_at bigint,
  buy_hit_price numeric CHECK (buy_hit_price IS NULL OR buy_hit_price > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_day, inst_id),
  CHECK ((count_hit_at IS NULL) = (count_hit_price IS NULL) AND (count_hit_at IS NULL) = (count_hit_source IS NULL)),
  CHECK ((buy_hit_at IS NULL) = (buy_hit_price IS NULL)),
  CHECK (buy_hit_at IS NULL OR count_hit_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS panic_daily_instruments_count_hit_idx
  ON panic_daily_instruments(strategy_day, count_hit_at, inst_id) WHERE count_hit_at IS NOT NULL;

ALTER TABLE filled_orders
  DROP CONSTRAINT IF EXISTS filled_orders_sell_trigger_reason_check;

ALTER TABLE filled_orders
  ADD CONSTRAINT filled_orders_sell_trigger_reason_check
  CHECK (sell_trigger_reason IS NULL OR sell_trigger_reason IN ('PRICE_BREAKDOWN','MAX_HOLD_EXPIRED','DELIST','TAKE_PROFIT','SCHEDULED_CLOSE'))
  NOT VALID;

ALTER TABLE filled_orders
  VALIDATE CONSTRAINT filled_orders_sell_trigger_reason_check;
