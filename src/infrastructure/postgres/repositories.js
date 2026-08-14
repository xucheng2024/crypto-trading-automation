export class TradingStateRepository {
  async claimAnnouncement(tx, { title, pTime }) {
    return tx.query("INSERT INTO announcement_receipts(title,published_at) VALUES($1,$2) ON CONFLICT DO NOTHING", [title, pTime]);
  }
  async listProtection(tx) { return (await tx.query("SELECT * FROM instrument_protection ORDER BY inst_id")).rows; }
  async upsertProtection(tx, row) {
    return tx.query(`INSERT INTO instrument_protection(inst_id,base_ccy,state,reason,announcement_url,announcement_time,instrument_exp_time)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(inst_id) DO UPDATE SET state='EXITING',reason=EXCLUDED.reason,
      announcement_url=COALESCE(EXCLUDED.announcement_url,instrument_protection.announcement_url),
      announcement_time=COALESCE(EXCLUDED.announcement_time,instrument_protection.announcement_time),
      instrument_exp_time=COALESCE(EXCLUDED.instrument_exp_time,instrument_protection.instrument_exp_time),
      version=instrument_protection.version+1,updated_at=now()`, [row.instId, row.baseCcy, row.state, row.reason, row.announcement?.url ?? null, row.announcement?.pTime ?? null, row.expTime ?? null]);
  }
  async listDaily(tx) { return (await tx.query("SELECT * FROM daily_limit_cache ORDER BY inst_id,strategy_day")).rows; }
  async findDaily(tx, instId, strategyDay) { return (await tx.query("SELECT * FROM daily_limit_cache WHERE inst_id=$1 AND strategy_day=$2", [instId, strategyDay])).rows[0] ?? null; }
  async claimDaily(tx, row) {
    await tx.query(`INSERT INTO daily_limit_cache(
      inst_id,strategy_day,status,daily_limit_price,input_hash,today_candle_ts,today_open,
      yesterday_candle_ts,yesterday_open,yesterday_close,best_limit,tick_sz,strategy_config_hash
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(inst_id,strategy_day) DO NOTHING`, [
      row.instId, row.strategyDay, row.status, row.dailyLimitPrice ?? null, row.inputHash,
      row.todayCandleTs, row.todayOpen, row.yesterdayCandleTs, row.yesterdayOpen,
      row.yesterdayClose, row.bestLimit, row.tickSz, row.strategyConfigHash,
    ]);
    return this.findDaily(tx, row.instId, row.strategyDay);
  }
  async listManagedFills(tx, accountId) { return (await tx.query("SELECT * FROM filled_orders WHERE account_id=$1 ORDER BY fill_time,bill_id,trade_id", [accountId])).rows; }
  async listDelistCandidates(tx, { accountId, instId }) {
    return (await tx.query(`SELECT f.*, (f.fill_size-f.disposed_size)::text AS remaining_size,
      COALESCE((SELECT max(a.generation)+1 FROM order_attempts a
        WHERE a.account_id=f.account_id AND a.source_buy_trade_id=f.trade_id AND a.intent='DELIST'),0)::int AS next_generation
      FROM filled_orders f JOIN instrument_protection p ON p.inst_id=f.inst_id
      WHERE f.account_id=$1 AND f.inst_id=$2 AND f.side='BUY' AND p.state IN ('EXITING','DELIST_DUST')
        AND f.disposed_size < f.fill_size
      ORDER BY f.fill_time,f.trade_id`, [accountId, instId])).rows;
  }
  async findManagedBuy(tx, { accountId, tradeId }) {
    return (await tx.query("SELECT *, (fill_size-disposed_size)::text AS remaining_size FROM filled_orders WHERE account_id=$1 AND trade_id=$2 AND side='BUY'", [accountId, tradeId])).rows[0] ?? null;
  }
  async convergeProtection(tx, { accountId, instId }) {
    const result = await tx.query(`SELECT count(*) FILTER (WHERE disposed_size < fill_size)::int AS remaining,
      count(*) FILTER (WHERE disposed_size < fill_size AND sell_state <> 'DUST_PENDING')::int AS tradable
      FROM filled_orders WHERE account_id=$1 AND inst_id=$2 AND side='BUY'`, [accountId, instId]);
    const row = result.rows[0]; const next = row.remaining === 0 ? "EXITED" : row.tradable === 0 ? "DELIST_DUST" : "EXITING";
    await tx.query("UPDATE instrument_protection SET state=$2,updated_at=now(),version=version+1 WHERE inst_id=$1 AND state IN ('EXITING','DELIST_DUST') AND state IS DISTINCT FROM $2", [instId, next]);
    return next;
  }
  async insertFill(tx, fill) {
    return tx.query(`INSERT INTO filled_orders(
      account_id,inst_id,base_ccy,trade_id,bill_id,source,side,fill_size,fill_time,
      hold_hours,max_hold_hours,strategy_config_hash,sell_time,force_sell_time,protection_price,sell_state,allocation_state,execution_mode,execution_route,
      source_attempt_cl_ord_id,fill_price,fee,fee_ccy,min_price_after_fill,max_adverse_pct
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    ON CONFLICT(inst_id,trade_id) DO NOTHING`, [
      fill.accountId, fill.instId, fill.baseCcy, fill.tradeId, fill.billId ?? null,
      fill.source, fill.side, fill.fillSize, fill.fillTime, fill.holdHours ?? null, fill.maxHoldHours ?? null,
      fill.strategyConfigHash ?? null, fill.sellTime ?? null, fill.forceSellTime ?? null, fill.protectionPrice ?? null,
      fill.sellState ?? null, fill.allocationState ?? null, fill.executionMode ?? "cross", fill.executionRoute ?? "margin",
      fill.sourceAttemptClOrdId ?? null, fill.fillPrice ?? null, fill.fee ?? null, fill.feeCcy ?? null,
      fill.fillPrice ?? null, fill.fillPrice ? "0" : null,
    ]);
  }

  async recordAdversePrice(tx, { accountId, instId, price }) {
    return tx.query(`UPDATE filled_orders SET
      min_price_after_fill=LEAST(COALESCE(min_price_after_fill,fill_price),$3::numeric),
      max_adverse_pct=GREATEST(COALESCE(max_adverse_pct,0),GREATEST(0,(fill_price-$3::numeric)/fill_price*100)),
      version=version+1
      WHERE account_id=$1 AND inst_id=$2 AND side='BUY' AND disposed_size<fill_size
        AND fill_price IS NOT NULL AND (min_price_after_fill IS NULL OR $3::numeric<min_price_after_fill)`, [accountId, instId, price]);
  }

  async compareAndSetFill(tx, id, version, disposedSize) {
    return tx.query(
      "UPDATE filled_orders SET disposed_size=$1,version=version+1 WHERE id=$2 AND version=$3",
      [disposedSize, id, version],
    );
  }

  async listExitCandidates(tx, { accountId, baseCcy, nowMs, intent }) {
    return (await tx.query(`SELECT *, (fill_size-disposed_size)::text AS remaining_size
      FROM filled_orders WHERE account_id=$1 AND side='BUY' AND base_ccy=$2
      AND sell_state IN ('WAITING','SELL_TRIGGERED','DUST_PENDING')
      AND ($3::text='DELIST' OR sell_time <= $4)
      ORDER BY sell_time,fill_time,trade_id FOR UPDATE`, [accountId, baseCcy, intent, nowMs])).rows;
  }

  async markSellTriggered(tx, { accountId, instId, tradeId, version, protectionPrice, sellTriggerReason }) {
    return tx.query(`UPDATE filled_orders SET sell_state='SELL_TRIGGERED',
      protection_price=$5::numeric,sell_trigger_reason=$6,version=version+1
      WHERE account_id=$1 AND inst_id=$2 AND trade_id=$3 AND side='BUY' AND version=$4
      AND sell_state IN ('WAITING','SELL_TRIGGERED','DUST_PENDING') RETURNING *`, [accountId, instId, tradeId, version, protectionPrice, sellTriggerReason]);
  }

  async raiseProtection(tx, { accountId, instId, tradeId, version, protectionPrice }) {
    return tx.query(`UPDATE filled_orders SET protection_price=GREATEST(COALESCE(protection_price,$5::numeric),$5::numeric),version=version+1
      WHERE account_id=$1 AND inst_id=$2 AND trade_id=$3 AND side='BUY' AND version=$4
      AND sell_state IN ('WAITING','SELL_TRIGGERED','DUST_PENDING') RETURNING *`, [accountId, instId, tradeId, version, protectionPrice]);
  }

  async markDust(tx, { accountId, instId, tradeId, version }) {
    return tx.query(`UPDATE filled_orders SET sell_state='DUST_PENDING',version=version+1
      WHERE account_id=$1 AND inst_id=$2 AND trade_id=$3 AND side='BUY' AND version=$4
      AND sell_state='SELL_TRIGGERED'`, [accountId, instId, tradeId, version]);
  }

  async applySystemSell(tx, { accountId, sourceBuyTradeId, fillSize }) {
    const row = (await tx.query(`UPDATE filled_orders SET disposed_size=disposed_size+$3::numeric,
      sell_state=CASE WHEN disposed_size+$3::numeric=fill_size THEN 'SOLD' ELSE 'SELL_TRIGGERED' END,
      version=version+1 WHERE account_id=$1 AND trade_id=$2 AND side='BUY'
      AND disposed_size+$3::numeric <= fill_size RETURNING *`, [accountId, sourceBuyTradeId, fillSize])).rows[0];
    if (!row) throw new Error("SYSTEM_SELL_DISPOSAL_OUT_OF_RANGE");
    return row;
  }

  async recordSystemSell(tx, { accountId, instId, baseCcy, tradeId, fillSize, fillTime, fillPrice, fee, feeCcy, sourceBuyTradeId, sourceAttemptClOrdId, executionMode = "cross", executionRoute = "margin" }) {
    const inserted = await this.insertFill(tx, { accountId, instId, baseCcy, tradeId, source: "SYSTEM", side: "SELL", fillSize, fillTime, fillPrice, fee, feeCcy, sourceAttemptClOrdId, allocationState: "APPLIED", executionMode, executionRoute });
    if (inserted.rowCount === 0) return { applied: false, reason: "DUPLICATE_TRADE" };
    const source = await this.applySystemSell(tx, { accountId, sourceBuyTradeId, fillSize });
    return { applied: true, source };
  }

  async allocatePendingAccountSells(tx, { accountId, baseCcy, watermark }) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`exit:${accountId}:${baseCcy}`]);
    const active = await tx.query(`SELECT 1 FROM order_attempts WHERE account_id=$1 AND base_ccy=$2
      AND intent IN ('SELL','DELIST') AND state IN ('PREPARED','SUBMITTED','UNKNOWN') LIMIT 1`, [accountId, baseCcy]);
    if (active.rowCount) return { allocated: 0, reason: "ACTIVE_SYSTEM_EXIT" };
    // A missing/non-numeric key makes chronological allocation unknowable. Do
    // not silently coerce it to zero; leave every affected SELL pending.
    const invalid = await tx.query(`SELECT 1 FROM filled_orders WHERE account_id=$1 AND base_ccy=$2
      AND ((side='SELL' AND source='ACCOUNT' AND allocation_state='PENDING') OR side='BUY')
      AND (bill_id IS NULL OR bill_id !~ '^[0-9]+$') LIMIT 1`, [accountId, baseCcy]);
    if (invalid.rowCount) return { allocated: 0, reason: "INVALID_BILL_ID" };
    const pending = (await tx.query(`SELECT * FROM filled_orders WHERE account_id=$1 AND base_ccy=$2
      AND side='SELL' AND source='ACCOUNT' AND allocation_state='PENDING'
      AND bill_id ~ '^[0-9]+$' AND fill_time <= $3 ORDER BY fill_time,bill_id::numeric,trade_id FOR UPDATE`, [accountId, baseCcy, watermark])).rows;
    for (const sell of pending) {
      let left = subtractDecimal(sell.fill_size, sell.allocated_size);
      const buys = (await tx.query(`SELECT * FROM filled_orders WHERE account_id=$1 AND base_ccy=$2 AND side='BUY'
        AND (fill_time,bill_id::numeric,trade_id) <= ($3,$4::numeric,$5)
        AND disposed_size < fill_size ORDER BY fill_time,bill_id::numeric,trade_id FOR UPDATE`, [accountId, baseCcy, sell.fill_time, sell.bill_id, sell.trade_id])).rows;
      let allocated = sell.allocated_size;
      for (const buy of buys) {
        if (compareDecimal(left, "0") <= 0) break;
        const remaining = subtractDecimal(buy.fill_size, buy.disposed_size);
        const part = compareDecimal(left, remaining) < 0 ? left : remaining;
        if (compareDecimal(part, "0") <= 0) continue;
        await this.applySystemSell(tx, { accountId, sourceBuyTradeId: buy.trade_id, fillSize: part });
        allocated = addDecimal(allocated, part); left = subtractDecimal(left, part);
      }
      // Do not turn an account/system race into an over-disposal.  A SELL
      // that cannot be completely matched remains an explicit quarantine for
      // reconciliation rather than becoming a partially-applied fiction.
      if (compareDecimal(left, "0") > 0) {
        await tx.query("UPDATE filled_orders SET allocated_size=$1,version=version+1 WHERE id=$2", [allocated, sell.id]);
        return { allocated: 0, reason: "ACCOUNT_SELL_SHORTFALL", tradeId: sell.trade_id };
      }
      await tx.query("UPDATE filled_orders SET allocated_size=$1,allocation_state='APPLIED',version=version+1 WHERE id=$2", [allocated, sell.id]);
    }
    return { allocated: pending.length };
  }
}

export class OrderRepository {
  async lockExitBase(tx, accountId, baseCcy) {
    return tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`exit:${accountId}:${baseCcy}`]);
  }
  async findByClOrdId(tx, clOrdId) {
    return (await tx.query("SELECT * FROM order_attempts WHERE cl_ord_id=$1", [clOrdId])).rows[0] ?? null;
  }
  async listNonTerminal(tx, accountId) { return (await tx.query("SELECT * FROM order_attempts WHERE account_id=$1 AND state IN ('PREPARED','SUBMITTED','UNKNOWN') ORDER BY id", [accountId])).rows; }
  async listTodayBuys(tx, accountId, strategyDay) { return (await tx.query("SELECT * FROM order_attempts WHERE account_id=$1 AND intent='BUY' AND ($2::date IS NULL OR strategy_day=$2::date) ORDER BY inst_id,generation", [accountId, strategyDay ?? null])).rows; }
  async listBuyCycle(tx, accountId, instId, strategyDay) {
    const attempts = (await tx.query("SELECT * FROM order_attempts WHERE account_id=$1 AND inst_id=$2 AND intent='BUY' AND strategy_day=$3 ORDER BY generation", [accountId, instId, strategyDay])).rows;
    if (!attempts.length) return { attempts, consumedUsd: "0" };
    const ids = attempts.map((row) => row.cl_ord_id);
    const consumed = await tx.query(`SELECT COALESCE(sum(fill_size*fill_price*1.0005),0)::text AS consumed
      FROM filled_orders WHERE account_id=$1 AND side='BUY' AND source='SYSTEM'
      AND source_attempt_cl_ord_id=ANY($2::text[])`, [accountId, ids]);
    return { attempts, consumedUsd: consumed.rows[0].consumed };
  }
  async listWatermarks(tx, accountId) { return (await tx.query("SELECT * FROM sync_watermarks WHERE account_id=$1 ORDER BY inst_type,endpoint", [accountId])).rows; }
  async listActiveExitForBase(tx, accountId, baseCcy) { return (await tx.query("SELECT * FROM order_attempts WHERE account_id=$1 AND base_ccy=$2 AND intent IN ('SELL','DELIST') AND state IN ('PREPARED','SUBMITTED','UNKNOWN')", [accountId, baseCcy])).rows; }
  async releasePreparedExitsForBase(tx, accountId, baseCcy, reason = "ACCOUNT_SELL_BEFORE_HTTP") {
    return tx.query(`UPDATE order_attempts SET state='NOT_CREATED',reservation_state='RELEASED',error_message=$3,updated_at=now(),version=version+1
      WHERE account_id=$1 AND base_ccy=$2 AND intent IN ('SELL','DELIST') AND state='PREPARED'`, [accountId, baseCcy, reason]);
  }
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
    await this.lockExitBase(tx, attempt.accountId, attempt.baseCcy);
    const pending = await tx.query("SELECT 1 FROM filled_orders WHERE account_id=$1 AND base_ccy=$2 AND side='SELL' AND source='ACCOUNT' AND allocation_state='PENDING' LIMIT 1", [attempt.accountId, attempt.baseCcy]);
    if (pending.rowCount) return { authorized: false, reason: "ACCOUNT_SELL_PENDING" };
    const source = await tx.query("SELECT (fill_size-disposed_size)::text AS remaining_size,version FROM filled_orders WHERE account_id=$1 AND trade_id=$2 AND side='BUY' FOR UPDATE", [attempt.accountId, attempt.sourceBuyTradeId]);
    if (!source.rowCount || compareDecimal(source.rows[0].remaining_size, "0") <= 0 || compareDecimal(attempt.reservedBaseSize, source.rows[0].remaining_size) > 0) return { authorized: false, reason: "EXIT_REMAINING_CHANGED" };
    await this.insertAttempt(tx, attempt);
    return { authorized: true, fillVersion: source.rows[0].version, remainingSize: source.rows[0].remaining_size };
  }

  async insertAttempt(tx, attempt) {
    return tx.query(`INSERT INTO order_attempts(
      account_id,intent,inst_id,base_ccy,cl_ord_id,payload_hash,source_buy_trade_id,
      strategy_day,generation,planned_size,state,reserved_exposure_usd,reserved_base_size,
      reservation_state,frozen_target_usd,decision_quote_ts,decision_quote_hash,
      decision_candle_ts,decision_candle_hash,decision_market_key,execution_limit_price,
      instrument_version,hold_hours,max_hold_hours,strategy_config_hash,admission_equity,
      admission_exposure,account_snapshot_version,execution_mode,execution_route,
      decision_trigger_price,decision_reference_price,decision_reason
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARED',$11,$12,'ACTIVE',$13,$14,$15,$16,$17,
      $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
    )`, [
      attempt.accountId, attempt.intent, attempt.instId, attempt.baseCcy, attempt.clOrdId,
      attempt.payloadHash, attempt.sourceBuyTradeId ?? null, attempt.strategyDay ?? null,
      attempt.generation ?? 0, attempt.plannedSize ?? null,
      attempt.reservedExposureUsd ?? null, attempt.reservedBaseSize ?? null,
      attempt.frozenTargetUsd ?? null, attempt.decisionQuoteTs ?? null,
      attempt.decisionQuoteHash ?? null, attempt.decisionCandleTs ?? null,
      attempt.decisionCandleHash ?? null, attempt.decisionMarketKey ?? null,
      attempt.executionLimitPrice ?? null, attempt.instrumentVersion ?? null,
      attempt.holdHours ?? null, attempt.maxHoldHours ?? null, attempt.strategyConfigHash ?? null,
      attempt.admissionEquity ?? null, attempt.admissionExposure ?? null,
      attempt.accountSnapshotVersion ?? null, attempt.executionMode ?? "cross", attempt.executionRoute ?? "margin",
      attempt.decisionTriggerPrice ?? null, attempt.decisionReferencePrice ?? null, attempt.decisionReason ?? null,
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
import { compareDecimal, subtractDecimal, addDecimal } from "../../decimal.js";
