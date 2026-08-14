export class TradingStateRepository {
  async listProtection(tx) { return (await tx.query("SELECT * FROM instrument_protection ORDER BY inst_id")).rows; }
  async listDaily(tx) { return (await tx.query("SELECT * FROM daily_limit_cache ORDER BY inst_id,strategy_day")).rows; }
  async listManagedFills(tx, accountId) { return (await tx.query("SELECT * FROM filled_orders WHERE account_id=$1 ORDER BY fill_time,bill_id,trade_id", [accountId])).rows; }
  async insertFill(tx, fill) {
    return tx.query(`INSERT INTO filled_orders(
      account_id,inst_id,base_ccy,trade_id,bill_id,source,side,fill_size,fill_time,
      hold_hours,strategy_config_hash,sell_time,protection_price,sell_state,allocation_state
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT(inst_id,trade_id) DO NOTHING`, [
      fill.accountId, fill.instId, fill.baseCcy, fill.tradeId, fill.billId ?? null,
      fill.source, fill.side, fill.fillSize, fill.fillTime, fill.holdHours ?? null,
      fill.strategyConfigHash ?? null, fill.sellTime ?? null, fill.protectionPrice ?? null,
      fill.sellState ?? null, fill.allocationState ?? null,
    ]);
  }

  async compareAndSetFill(tx, id, version, disposedSize) {
    return tx.query(
      "UPDATE filled_orders SET disposed_size=$1,version=version+1 WHERE id=$2 AND version=$3",
      [disposedSize, id, version],
    );
  }
}

export class OrderRepository {
  async findByClOrdId(tx, clOrdId) {
    return (await tx.query("SELECT * FROM order_attempts WHERE cl_ord_id=$1", [clOrdId])).rows[0] ?? null;
  }
  async listNonTerminal(tx, accountId) { return (await tx.query("SELECT * FROM order_attempts WHERE account_id=$1 AND state IN ('PREPARED','SUBMITTED','UNKNOWN') ORDER BY id", [accountId])).rows; }
  async listTodayBuys(tx, accountId, strategyDay) { return (await tx.query("SELECT * FROM order_attempts WHERE account_id=$1 AND intent='BUY' AND ($2::date IS NULL OR strategy_day=$2::date) ORDER BY inst_id,generation", [accountId, strategyDay ?? null])).rows; }
  async listWatermarks(tx, accountId) { return (await tx.query("SELECT * FROM sync_watermarks WHERE account_id=$1 ORDER BY inst_type,endpoint", [accountId])).rows; }
  async upsertWatermark(tx, { accountId, instType, endpoint, watermark, overlapBegin, managedFillStartTime = null, healthy }) {
    return tx.query(`INSERT INTO sync_watermarks(account_id,inst_type,endpoint,watermark,overlap_begin,managed_fill_start_time,healthy)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(account_id,inst_type,endpoint) DO UPDATE SET watermark=EXCLUDED.watermark,overlap_begin=EXCLUDED.overlap_begin,
      managed_fill_start_time=COALESCE(sync_watermarks.managed_fill_start_time,EXCLUDED.managed_fill_start_time),healthy=EXCLUDED.healthy,updated_at=now()`,
    [accountId, instType, endpoint, watermark, overlapBegin, managedFillStartTime, healthy]);
  }
  async reserveBuy(tx, attempt, { managedExposure, maxExposure }) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`buy:${attempt.accountId}`]);
    const decision = await tx.query(`SELECT
      (COALESCE(sum(reserved_exposure_usd) FILTER (
        WHERE intent='BUY' AND state IN ('PREPARED','SUBMITTED','UNKNOWN') AND reservation_state='ACTIVE'
      ), 0::numeric) + $2::numeric)::text AS committed_exposure,
      ($2::numeric >= 0 AND $3::numeric > 0 AND $4::numeric > 0 AND
      COALESCE(sum(reserved_exposure_usd) FILTER (
        WHERE intent='BUY' AND state IN ('PREPARED','SUBMITTED','UNKNOWN') AND reservation_state='ACTIVE'
      ), 0::numeric) + $2::numeric + $3::numeric <= $4::numeric) AS authorized
    FROM order_attempts WHERE account_id=$1`, [attempt.accountId, managedExposure, attempt.reservedExposureUsd, maxExposure]);
    if (decision.rows[0].authorized !== true) return { authorized: false, reason: "EXPOSURE_LIMIT" };
    await this.insertAttempt(tx, { ...attempt, admissionExposure: decision.rows[0].committed_exposure });
    return { authorized: true };
  }

  async reserveExit(tx, attempt) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`exit:${attempt.accountId}:${attempt.baseCcy}`]);
    await this.insertAttempt(tx, attempt);
  }

  async insertAttempt(tx, attempt) {
    return tx.query(`INSERT INTO order_attempts(
      account_id,intent,inst_id,base_ccy,cl_ord_id,payload_hash,source_buy_trade_id,
      strategy_day,generation,planned_size,state,reserved_exposure_usd,reserved_base_size,
      reservation_state,frozen_target_usd,decision_quote_ts,decision_quote_hash,
      decision_candle_ts,decision_candle_hash,decision_market_key,execution_limit_price,
      instrument_version,hold_hours,strategy_config_hash,admission_equity,
      admission_exposure,account_snapshot_version
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARED',$11,$12,'ACTIVE',$13,$14,$15,$16,$17,
      $18,$19,$20,$21,$22,$23,$24,$25
    )`, [
      attempt.accountId, attempt.intent, attempt.instId, attempt.baseCcy, attempt.clOrdId,
      attempt.payloadHash, attempt.sourceBuyTradeId ?? null, attempt.strategyDay ?? null,
      attempt.generation ?? 0, attempt.plannedSize ?? null,
      attempt.reservedExposureUsd ?? null, attempt.reservedBaseSize ?? null,
      attempt.frozenTargetUsd ?? null, attempt.decisionQuoteTs ?? null,
      attempt.decisionQuoteHash ?? null, attempt.decisionCandleTs ?? null,
      attempt.decisionCandleHash ?? null, attempt.decisionMarketKey ?? null,
      attempt.executionLimitPrice ?? null, attempt.instrumentVersion ?? null,
      attempt.holdHours ?? null, attempt.strategyConfigHash ?? null,
      attempt.admissionEquity ?? null, attempt.admissionExposure ?? null,
      attempt.accountSnapshotVersion ?? null,
    ]);
  }

  async markSubmitted(tx, clOrdId, ordId) {
    return tx.query("UPDATE order_attempts SET state='SUBMITTED',ord_id=$2,updated_at=now(),version=version+1 WHERE cl_ord_id=$1 AND state='PREPARED'", [clOrdId, ordId ?? null]);
  }

  async markUnknown(tx, clOrdId, reason) {
    return tx.query("UPDATE order_attempts SET state='UNKNOWN',error_message=$2,updated_at=now(),version=version+1 WHERE cl_ord_id=$1 AND state IN ('PREPARED','SUBMITTED','UNKNOWN')", [clOrdId, reason ?? null]);
  }

  async markNotCreated(tx, clOrdId, reason) {
    return tx.query("UPDATE order_attempts SET state='NOT_CREATED',reservation_state='RELEASED',error_message=$2,updated_at=now(),version=version+1 WHERE cl_ord_id=$1 AND state='PREPARED'", [clOrdId, reason ?? null]);
  }

  async markSettled(tx, clOrdId, exchangeState, reservationState = "RELEASED") {
    return tx.query("UPDATE order_attempts SET state='SETTLED',reservation_state=$2,exchange_state=$3,updated_at=now(),version=version+1 WHERE cl_ord_id=$1 AND state IN ('SUBMITTED','UNKNOWN')", [clOrdId, reservationState, exchangeState ?? null]);
  }
}
