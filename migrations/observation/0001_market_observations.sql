CREATE TABLE IF NOT EXISTS market_observations (
  inst_id text NOT NULL,
  sampled_at timestamptz NOT NULL,
  price numeric NOT NULL CHECK (price > 0),
  open_24h numeric NOT NULL CHECK (open_24h > 0),
  change_pct numeric NOT NULL,
  PRIMARY KEY (inst_id, sampled_at)
);
CREATE INDEX IF NOT EXISTS market_observations_latest
  ON market_observations (inst_id, sampled_at DESC);
