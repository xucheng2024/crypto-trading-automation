CREATE TABLE IF NOT EXISTS daily_limit_cache (
  inst_id text NOT NULL,
  strategy_day date NOT NULL,
  status text NOT NULL,
  daily_limit_price numeric,
  input_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inst_id, strategy_day),
  CHECK (daily_limit_price IS NULL OR daily_limit_price > 0)
);

CREATE TABLE IF NOT EXISTS instrument_protection (
  inst_id text PRIMARY KEY,
  base_ccy text NOT NULL,
  state text NOT NULL CHECK (state IN ('BLACKLISTED','EXITING','EXITED','DELIST_DUST')),
  reason text NOT NULL,
  announcement_url text,
  announcement_time bigint,
  instrument_exp_time bigint,
  last_error text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS filled_orders (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  inst_id text NOT NULL,
  base_ccy text NOT NULL,
  trade_id text NOT NULL,
  bill_id text,
  source text NOT NULL CHECK (source IN ('SYSTEM','ACCOUNT')),
  side text NOT NULL CHECK (side IN ('BUY','SELL')),
  fill_size numeric NOT NULL CHECK (fill_size > 0),
  disposed_size numeric NOT NULL DEFAULT 0 CHECK (disposed_size >= 0 AND disposed_size <= fill_size),
  allocated_size numeric NOT NULL DEFAULT 0 CHECK (allocated_size >= 0 AND allocated_size <= fill_size),
  fill_time bigint NOT NULL,
  hold_hours numeric CHECK (hold_hours IS NULL OR hold_hours > 0),
  strategy_config_hash text,
  sell_time bigint,
  protection_price numeric CHECK (protection_price IS NULL OR protection_price > 0),
  sell_state text CHECK (sell_state IS NULL OR sell_state IN ('WAITING','SELL_TRIGGERED','SOLD','DUST_PENDING')),
  allocation_state text CHECK (allocation_state IS NULL OR allocation_state IN ('PENDING','APPLIED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inst_id, trade_id),
  CHECK (side <> 'BUY' OR allocated_size = 0),
  CHECK (side <> 'SELL' OR disposed_size = 0)
);

CREATE TABLE IF NOT EXISTS order_attempts (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('BUY','SELL','DELIST')),
  inst_id text NOT NULL,
  base_ccy text NOT NULL,
  cl_ord_id text NOT NULL UNIQUE,
  ord_id text,
  payload_hash text NOT NULL,
  source_buy_trade_id text,
  strategy_day date,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  planned_size numeric CHECK (planned_size IS NULL OR planned_size > 0),
  state text NOT NULL CHECK (state IN ('PREPARED','SUBMITTED','UNKNOWN','NOT_CREATED','SETTLED')),
  exchange_state text,
  error_code text,
  error_message text,
  failure_fingerprint text,
  reserved_exposure_usd numeric,
  reserved_base_size numeric,
  reservation_state text NOT NULL DEFAULT 'ACTIVE' CHECK (reservation_state IN ('ACTIVE','RELEASED','CONVERTED')),
  frozen_target_usd numeric,
  decision_quote_ts bigint,
  decision_quote_hash text,
  decision_candle_ts bigint,
  decision_candle_hash text,
  decision_market_key text,
  execution_limit_price numeric,
  instrument_version text,
  hold_hours numeric,
  strategy_config_hash text,
  admission_equity numeric,
  admission_exposure numeric,
  account_snapshot_version text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (intent = 'BUY' AND reserved_exposure_usd IS NOT NULL AND reserved_exposure_usd > 0 AND reserved_base_size IS NULL)
    OR
    (intent IN ('SELL','DELIST') AND reserved_base_size IS NOT NULL AND reserved_base_size > 0 AND reserved_exposure_usd IS NULL)
  ),
  CHECK ((intent = 'BUY' AND strategy_day IS NOT NULL AND source_buy_trade_id IS NULL)
    OR (intent IN ('SELL','DELIST') AND source_buy_trade_id IS NOT NULL)),
  CHECK (frozen_target_usd IS NULL OR frozen_target_usd > 0),
  CHECK (execution_limit_price IS NULL OR execution_limit_price > 0),
  CHECK (hold_hours IS NULL OR hold_hours > 0),
  CHECK (
    (state IN ('PREPARED','SUBMITTED','UNKNOWN') AND reservation_state = 'ACTIVE')
    OR (state = 'NOT_CREATED' AND reservation_state = 'RELEASED')
    OR (state = 'SETTLED' AND reservation_state IN ('RELEASED','CONVERTED'))
  ),
  CHECK (intent <> 'BUY' OR (
    frozen_target_usd IS NOT NULL AND decision_quote_ts IS NOT NULL AND decision_quote_hash IS NOT NULL
    AND decision_candle_ts IS NOT NULL AND decision_candle_hash IS NOT NULL AND decision_market_key IS NOT NULL
    AND execution_limit_price IS NOT NULL AND instrument_version IS NOT NULL AND hold_hours IS NOT NULL
    AND strategy_config_hash IS NOT NULL AND admission_equity IS NOT NULL AND admission_equity > 0
    AND admission_exposure IS NOT NULL AND admission_exposure >= 0 AND account_snapshot_version IS NOT NULL
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS order_attempts_buy_generation_uq
  ON order_attempts(account_id,inst_id,strategy_day,generation) WHERE intent='BUY';
CREATE UNIQUE INDEX IF NOT EXISTS order_attempts_active_buy_uq
  ON order_attempts(account_id,inst_id) WHERE intent='BUY' AND state IN ('PREPARED','SUBMITTED','UNKNOWN');
CREATE UNIQUE INDEX IF NOT EXISTS order_attempts_exit_generation_uq
  ON order_attempts(source_buy_trade_id,intent,generation) WHERE intent IN ('SELL','DELIST');
CREATE UNIQUE INDEX IF NOT EXISTS order_attempts_active_exit_source_uq
  ON order_attempts(source_buy_trade_id) WHERE intent IN ('SELL','DELIST') AND state IN ('PREPARED','SUBMITTED','UNKNOWN');
CREATE UNIQUE INDEX IF NOT EXISTS order_attempts_active_exit_base_uq
  ON order_attempts(account_id,base_ccy) WHERE intent IN ('SELL','DELIST') AND state IN ('PREPARED','SUBMITTED','UNKNOWN');

CREATE TABLE IF NOT EXISTS sync_watermarks (
  account_id text NOT NULL,
  inst_type text NOT NULL CHECK (inst_type IN ('SPOT','MARGIN')),
  endpoint text NOT NULL,
  watermark bigint,
  overlap_begin bigint,
  managed_fill_start_time bigint,
  healthy boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,inst_type,endpoint)
);
