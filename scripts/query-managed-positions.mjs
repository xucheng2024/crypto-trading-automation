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
      count(*) FILTER (WHERE sell_state='DUST_PENDING')::int AS dust_pending_fills
    FROM open_buys
    GROUP BY inst_id
  )
  SELECT positions.*, scope.account_count
  FROM positions CROSS JOIN scope
  ORDER BY inst_id`;

export function redactManagedPositions(rows) {
  if (rows.some((row) => Number(row.account_count) > 1)) throw new Error("Managed position scope is ambiguous across accounts");
  const positions = rows.map((row) => ({
    instrument: row.inst_id,
    remainingCostUsd: row.remaining_cost_usd,
    openFills: Number(row.open_fills),
    sellStates: row.sell_states ?? [],
    nextSellTime: row.next_sell_time,
    nextForceSellTime: row.next_force_sell_time,
    protectedFills: Number(row.protected_fills),
    dustPendingFills: Number(row.dust_pending_fills),
  }));
  return { summary: { instruments: positions.length, openFills: positions.reduce((total, row) => total + row.openFills, 0) }, positions };
}

export async function queryManagedPositions({ connectionString = process.env.POSTGRES_URL, credential = new DefaultAzureCredential(), Pool, logger = () => {} } = {}) {
  const pool = new EntraPostgresPool({ connectionString, credential, Pool, logger, max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    return redactManagedPositions((await client.query(MANAGED_POSITIONS_SQL)).rows);
  } finally {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
    await pool.end();
  }
}

export function parseArgs(argv) {
  if (argv.length) throw new Error("managed positions does not accept arguments");
  return {};
}

export async function main(argv = process.argv.slice(2)) {
  const result = await queryManagedPositions(parseArgs(argv));
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
