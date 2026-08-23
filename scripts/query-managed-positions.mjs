import { DefaultAzureCredential } from "@azure/identity";
import { fileURLToPath } from "node:url";
import { EntraPostgresPool } from "../src/infrastructure/postgres/entra-pool.js";

// This statement intentionally returns a redacted account-level summary only.
// Do not add account, trade, order, decision, fee, configuration, or error fields.
export const MANAGED_POSITIONS_SQL = `
  WITH open_buys AS (
    SELECT account_id,inst_id,fill_size,disposed_size,fill_price,sell_time,force_sell_time,
      protection_price,sell_state
    FROM filled_orders
    WHERE side='BUY' AND disposed_size < fill_size
  ), scope AS (
    SELECT count(DISTINCT account_id)::int AS account_count FROM open_buys
  ), positions AS (
    SELECT inst_id,
      sum(fill_size-disposed_size)::text AS remaining_size,
      CASE WHEN count(*) FILTER (WHERE fill_price IS NULL) > 0 THEN NULL
        ELSE sum((fill_size-disposed_size)*fill_price)::text END AS remaining_cost_usd,
      count(*)::int AS open_fills,
      array_agg(DISTINCT sell_state ORDER BY sell_state) FILTER (WHERE sell_state IS NOT NULL) AS sell_states,
      min(sell_time) AS next_sell_time,
      min(force_sell_time) AS next_force_sell_time,
      count(*) FILTER (WHERE protection_price IS NOT NULL)::int AS protected_fills,
      count(*) FILTER (WHERE sell_state='WAITING' AND protection_price IS NULL)::int AS unprotected_waiting_fills,
      min((CEIL(sell_time::numeric / 180000) * 180000)::bigint) FILTER (WHERE sell_state='WAITING' AND protection_price IS NULL AND sell_time IS NOT NULL) AS next_protection_anchor_time,
      count(*) FILTER (WHERE sell_state='WAITING' AND protection_price IS NULL AND sell_time IS NOT NULL AND (CEIL(sell_time::numeric / 180000) * 180000) <= EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::int AS anchor_due_unprotected_fills,
      count(*) FILTER (WHERE sell_state='DUST_PENDING')::int AS dust_pending_fills
    FROM open_buys
    GROUP BY inst_id
  )
  SELECT positions.*, scope.account_count
  FROM positions CROSS JOIN scope
  ORDER BY inst_id`;

// Realized trading PnL deliberately reuses the durable disposal/allocation
// result.  It never reconstructs FIFO from raw exchange history or estimates
// fees from a configured rate.
export const REALIZED_PNL_SQL = `
  WITH scoped AS (
    SELECT count(DISTINCT account_id)::int AS account_count FROM filled_orders
  ), buy AS (
    SELECT inst_id, base_ccy, sum(disposed_size) AS realized_size,
      sum(disposed_size * fill_price) AS cost_basis_usd,
      sum(CASE WHEN fee=0 THEN 0 WHEN fee_ccy='USDT' THEN fee*disposed_size/fill_size
        WHEN fee_ccy=base_ccy THEN fee*disposed_size/fill_size*fill_price END) AS buy_fees_usd,
      count(*) FILTER (WHERE disposed_size > 0 AND (fill_price IS NULL OR fee IS NULL OR (fee <> 0 AND (fee_ccy IS NULL OR fee_ccy NOT IN ('USDT', base_ccy)))))::int AS buy_gaps
    FROM filled_orders WHERE side='BUY' AND disposed_size > 0 GROUP BY inst_id,base_ccy
  ), sell AS (
    SELECT inst_id, base_ccy,
      sum(CASE WHEN source='ACCOUNT' THEN allocated_size ELSE fill_size END) AS realized_size,
      sum((CASE WHEN source='ACCOUNT' THEN allocated_size ELSE fill_size END) * fill_price) AS proceeds_usd,
      sum(CASE WHEN fee=0 THEN 0 WHEN fee_ccy='USDT' THEN fee*(CASE WHEN source='ACCOUNT' THEN allocated_size ELSE fill_size END)/fill_size
        WHEN fee_ccy=base_ccy THEN fee*(CASE WHEN source='ACCOUNT' THEN allocated_size ELSE fill_size END)/fill_size*fill_price END) AS sell_fees_usd,
      count(*) FILTER (WHERE (CASE WHEN source='ACCOUNT' THEN allocated_size ELSE fill_size END) > 0 AND (fill_price IS NULL OR fee IS NULL OR (fee <> 0 AND (fee_ccy IS NULL OR fee_ccy NOT IN ('USDT', base_ccy)))))::int AS sell_gaps
    FROM filled_orders WHERE side='SELL' AND allocation_state='APPLIED' GROUP BY inst_id,base_ccy
  ), merged AS (
    SELECT COALESCE(buy.inst_id,sell.inst_id) AS inst_id, COALESCE(buy.realized_size,0) AS buy_size, COALESCE(sell.realized_size,0) AS sell_size,
      buy.cost_basis_usd, sell.proceeds_usd, buy.buy_fees_usd, sell.sell_fees_usd, COALESCE(buy.buy_gaps,0)+COALESCE(sell.sell_gaps,0) AS fee_gaps
    FROM buy FULL JOIN sell USING (inst_id,base_ccy)
  )
  SELECT inst_id, sell_size::text AS realized_size, cost_basis_usd::text, proceeds_usd::text, buy_fees_usd::text, sell_fees_usd::text,
    CASE WHEN split_part(inst_id,'-',2)='USDT' AND buy_size=sell_size AND fee_gaps=0 THEN (proceeds_usd-cost_basis_usd+buy_fees_usd+sell_fees_usd)::text END AS net_pnl_usd,
    CASE WHEN split_part(inst_id,'-',2)='USDT' AND buy_size=sell_size AND fee_gaps=0 THEN 'COMPLETE' ELSE 'INCOMPLETE' END AS completeness,
    (fee_gaps + CASE WHEN buy_size=sell_size THEN 0 ELSE 1 END + CASE WHEN split_part(inst_id,'-',2)='USDT' THEN 0 ELSE 1 END)::int AS gap_count,
    scoped.account_count
  FROM merged CROSS JOIN scoped ORDER BY inst_id`;

export function redactManagedPositions(rows, realizedRows = []) {
  if ([...rows, ...realizedRows].some((row) => Number(row.account_count) > 1)) throw new Error("Managed position scope is ambiguous across accounts");
  const positions = rows.map((row) => ({
    instrument: row.inst_id,
    remainingCostUsd: row.remaining_cost_usd,
    openFills: Number(row.open_fills),
    sellStates: row.sell_states ?? [],
    nextSellTime: row.next_sell_time,
    nextForceSellTime: row.next_force_sell_time,
    protectedFills: Number(row.protected_fills),
    unprotectedWaitingFills: Number(row.unprotected_waiting_fills),
    nextProtectionAnchorTime: row.next_protection_anchor_time,
    anchorDueUnprotectedFills: Number(row.anchor_due_unprotected_fills),
    dustPendingFills: Number(row.dust_pending_fills),
  }));
  const realized = realizedRows.map((row) => ({ instrument: row.inst_id, realizedSize: row.realized_size, costBasisUsd: row.cost_basis_usd, proceedsUsd: row.proceeds_usd, buyFeesUsd: row.buy_fees_usd, sellFeesUsd: row.sell_fees_usd, netPnlUsd: row.net_pnl_usd, completeness: row.completeness, gapCount: Number(row.gap_count) }));
  return { summary: { instruments: positions.length, openFills: positions.reduce((total, row) => total + row.openFills, 0) }, positions, realizedSummary: { instruments: realized.length, complete: realized.filter((row) => row.completeness === "COMPLETE").length }, realized };
}

export async function queryManagedPositions({ connectionString = process.env.POSTGRES_URL, credential = new DefaultAzureCredential(), Pool, logger = () => {} } = {}) {
  const pool = new EntraPostgresPool({ connectionString, credential, Pool, logger, max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const positions = await client.query(MANAGED_POSITIONS_SQL);
    const realized = await client.query(REALIZED_PNL_SQL);
    return redactManagedPositions(positions.rows, realized.rows);
  } finally {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
    await pool.end();
  }
}

export function parseArgs(argv) {
  const leftover = argv.filter((row) => row && row !== "scripts/query-managed-positions.mjs");
  if (leftover.length) throw new Error("managed positions does not accept arguments");
  return {};
}

export const MANAGED_POSITIONS_JSON_PREFIX = "MANAGED_POSITIONS_JSON:";

export function extractManagedPositionsJson(text) {
  const line = String(text).split(/\r?\n/).map((row) => row.trim()).find((row) => row.includes(MANAGED_POSITIONS_JSON_PREFIX));
  if (!line) throw new Error("Managed-positions output is missing the redacted JSON marker");
  return JSON.parse(line.slice(line.indexOf(MANAGED_POSITIONS_JSON_PREFIX) + MANAGED_POSITIONS_JSON_PREFIX.length));
}

export async function main(argv = process.argv.slice(2)) {
  const result = await queryManagedPositions(parseArgs(argv));
  console.log(`${MANAGED_POSITIONS_JSON_PREFIX}${JSON.stringify(result)}`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
