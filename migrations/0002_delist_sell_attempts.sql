CREATE TABLE IF NOT EXISTS delist_sell_attempts (
  announcement_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  cl_ord_id TEXT NOT NULL UNIQUE,
  ord_id TEXT,
  state TEXT NOT NULL DEFAULT 'PREPARED',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (announcement_id, symbol, attempt)
);

CREATE INDEX IF NOT EXISTS idx_delist_sell_attempts_latest
  ON delist_sell_attempts(announcement_id, symbol, attempt DESC);
