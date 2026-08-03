export async function configuredPairs(db) {
  const { results } = await db.prepare("SELECT * FROM crypto_limits ORDER BY inst_id").all();
  return results || [];
}

export async function blacklistedSymbols(db) {
  const { results } = await db.prepare("SELECT crypto_symbol, reason, blacklist_type FROM blacklist WHERE is_active = 1").all();
  return new Map((results || []).map((row) => [String(row.crypto_symbol).toUpperCase(), row]));
}

export async function acquireTrade(db, tradeId) {
  const result = await db.prepare("UPDATE filled_orders SET sold_status = 'PROCESSING', updated_at = CURRENT_TIMESTAMP WHERE tradeid = ? AND sold_status IS NULL").bind(tradeId).run();
  return result.meta.changes === 1;
}

export async function releaseTrade(db, tradeId) {
  await db.prepare("UPDATE filled_orders SET sold_status = NULL, sell_order_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE tradeid = ? AND sold_status IN ('PROCESSING','SELL_SUBMITTED')").bind(tradeId).run();
}

export async function dueTrades(db, now = Date.now()) {
  const sgt = new Date(now + 8 * 60 * 60 * 1000);
  const todayStartSgtAsUtc = Date.UTC(sgt.getUTCFullYear(), sgt.getUTCMonth(), sgt.getUTCDate()) - 8 * 60 * 60 * 1000;
  const { results } = await db.prepare(`
    SELECT instid, ordid, tradeid, fillsz, side, ts, sell_time, fillpx, sold_status, sell_order_id
    FROM filled_orders
    WHERE (sold_status IS NULL OR sold_status IN ('PROCESSING','SELL_SUBMITTED')) AND side = 'buy'
      AND ((sell_time != '' AND sell_time NOT GLOB '*[^0-9]*' AND CAST(sell_time AS INTEGER) <= ?)
        OR ((sell_time IS NULL OR sell_time = '') AND ts != '' AND ts NOT GLOB '*[^0-9]*' AND CAST(ts AS INTEGER) < ?))
    ORDER BY CAST(COALESCE(NULLIF(sell_time,''), NULLIF(ts,'')) AS INTEGER)
  `).bind(now, todayStartSgtAsUtc).all();
  return results || [];
}

export async function saveBuyFills(db, fills) {
  const statements = fills.filter((fill) => fill.instId && fill.tradeId && fill.fillPx && fill.fillSz && fill.side === "buy").map((fill) => {
    const sellTime = /^\d+$/.test(fill.ts || "") ? String(Number(fill.ts) + 86_400_000) : null;
    return db.prepare(`
      INSERT INTO filled_orders
      (instid,ordid,tradeid,billid,fillpx,fillsz,side,ts,subtype,exectype,fee,feeccy,feerate,filltime,posside,clordid,tag,sell_time)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tradeid) DO UPDATE SET fillpx=excluded.fillpx,fillsz=excluded.fillsz,fee=excluded.fee,
        feeccy=excluded.feeccy,feerate=excluded.feerate,filltime=excluded.filltime,exectype=excluded.exectype,
        updated_at=CURRENT_TIMESTAMP
    `).bind(fill.instId, fill.ordId || "", fill.tradeId, fill.billId || "", fill.fillPx, fill.fillSz, fill.side, fill.ts || "",
      fill.subType || "", fill.execType || "", fill.fee || "", fill.feeCcy || "", fill.feeRate || "", fill.fillTime || "",
      fill.posSide || "", fill.clOrdId || "", fill.tag || "", sellTime);
  });
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  return statements.length;
}

export async function logRun(db, runId, task, status, message = null) {
  await db.prepare(`INSERT INTO task_runs(run_id,task,status,message,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(run_id,task) DO UPDATE SET status=excluded.status,message=excluded.message,updated_at=CURRENT_TIMESTAMP`)
    .bind(runId, task, status, message).run();
}
