ALTER TABLE daily_limit_cache
  ADD COLUMN IF NOT EXISTS ma20 numeric;
