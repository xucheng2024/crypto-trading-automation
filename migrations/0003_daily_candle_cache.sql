CREATE TABLE IF NOT EXISTS daily_candle_cache (
  day_sgt TEXT NOT NULL,
  inst_id TEXT NOT NULL,
  today_open TEXT NOT NULL,
  yesterday_open TEXT NOT NULL,
  yesterday_close TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day_sgt, inst_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_candle_cache_day
  ON daily_candle_cache(day_sgt);
