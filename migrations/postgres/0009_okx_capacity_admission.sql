DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'order_attempts'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%frozen_target_usd IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE order_attempts DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'order_attempts'::regclass AND conname = 'order_attempts_buy_decision_evidence_ck') THEN
    ALTER TABLE order_attempts ADD CONSTRAINT order_attempts_buy_decision_evidence_ck CHECK (
      intent <> 'BUY' OR (
        decision_quote_ts IS NOT NULL AND decision_quote_hash IS NOT NULL
        AND decision_candle_ts IS NOT NULL AND decision_candle_hash IS NOT NULL AND decision_market_key IS NOT NULL
        AND execution_limit_price IS NOT NULL AND instrument_version IS NOT NULL AND hold_hours IS NOT NULL
        AND strategy_config_hash IS NOT NULL AND account_snapshot_version IS NOT NULL
      )
    );
  END IF;
END $$;
