-- P3 exit ledger. 0001 is intentionally immutable; these constraints make the
-- fill-level exit invariants durable for databases upgraded from the P2 base.
CREATE INDEX IF NOT EXISTS filled_orders_managed_buy_exit_idx
  ON filled_orders(account_id, base_ccy, fill_time, bill_id, trade_id)
  WHERE side='BUY' AND sell_state IN ('WAITING','SELL_TRIGGERED','DUST_PENDING');

CREATE INDEX IF NOT EXISTS filled_orders_pending_account_sell_idx
  ON filled_orders(account_id, base_ccy, fill_time, bill_id, trade_id)
  WHERE side='SELL' AND source='ACCOUNT' AND allocation_state='PENDING';

-- Generation belongs solely to order_attempts.  A source fill can have one
-- attempt per generation and the existing partial unique indexes prevent an
-- active replacement for either SELL or DELIST.
CREATE UNIQUE INDEX IF NOT EXISTS order_attempts_exit_source_generation_p3_uq
  ON order_attempts(account_id, source_buy_trade_id, intent, generation)
  WHERE intent IN ('SELL','DELIST');

CREATE TABLE IF NOT EXISTS announcement_receipts (
  title text NOT NULL,
  published_at bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(title,published_at)
);

-- Fixed maintenance statement, intentionally not a repository-owned generic
-- operation: terminal attempts may be retained separately by the D+1 job.
-- DELETE FROM order_attempts WHERE state IN ('NOT_CREATED','SETTLED') AND updated_at < $1 LIMIT $2;
