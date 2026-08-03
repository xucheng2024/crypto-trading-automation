CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crypto_symbol TEXT NOT NULL UNIQUE,
  reason TEXT,
  blacklist_type TEXT DEFAULT 'manual',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  is_active INTEGER DEFAULT 1,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS crypto_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inst_id TEXT NOT NULL UNIQUE,
  best_limit TEXT NOT NULL,
  best_duration TEXT,
  max_returns TEXT,
  trade_count TEXT,
  trades_per_month TEXT,
  avg_return_per_trade TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  win_rate TEXT,
  median_earn TEXT
);
CREATE TABLE IF NOT EXISTS filled_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instid TEXT NOT NULL,
  ordid TEXT,
  tradeid TEXT NOT NULL UNIQUE,
  billid TEXT,
  fillpx TEXT NOT NULL,
  fillsz TEXT NOT NULL,
  side TEXT NOT NULL,
  ts TEXT NOT NULL,
  subtype TEXT,
  exectype TEXT,
  fee TEXT,
  feeccy TEXT,
  feerate TEXT,
  filltime TEXT,
  posside TEXT,
  clordid TEXT,
  tag TEXT,
  sell_time TEXT,
  sold_status TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  sell_order_id TEXT,
  trigger_rebuild_pending INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS processed_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  url TEXT,
  p_time INTEGER,
  processed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  announcement_type TEXT DEFAULT 'delist',
  affected_cryptos TEXT,
  protection_executed INTEGER DEFAULT 0,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, task)
);
CREATE INDEX IF NOT EXISTS idx_blacklist_active ON blacklist(is_active);
CREATE INDEX IF NOT EXISTS idx_filled_orders_sell_time ON filled_orders(sell_time);
CREATE INDEX IF NOT EXISTS idx_filled_orders_status ON filled_orders(sold_status);
CREATE INDEX IF NOT EXISTS idx_filled_orders_ts ON filled_orders(ts);
CREATE INDEX IF NOT EXISTS idx_task_runs_updated ON task_runs(updated_at DESC);
