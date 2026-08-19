import { DefaultAzureCredential } from "@azure/identity";
import { fileURLToPath } from "node:url";
import { EntraPostgresPool } from "../src/infrastructure/postgres/entra-pool.js";

export const INSTRUMENT_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)?$/;

// This statement deliberately selects only the redacted operational timeline.
// Do not add account, trade, order, decision, hash, fee, configuration, or
// error columns: this command's output is retained as a support artifact.
export const INSTRUMENT_TIMELINE_SQL = `
  WITH account_scope AS (
    SELECT account_id FROM order_attempts WHERE inst_id = $1
    UNION
    SELECT account_id FROM filled_orders WHERE inst_id = $1
  ), timeline AS (
    SELECT event_time, event_type, intent, state, reservation_state,
    execution_mode, execution_route, planned_size, reserved_exposure_usd,
    reserved_base_size, execution_limit_price, fill_size, disposed_size,
    fill_price, sell_state, allocation_state
    FROM (
      SELECT created_at AS event_time, 'ORDER_ATTEMPT'::text AS event_type,
      intent, state, reservation_state, execution_mode, execution_route,
      planned_size::text, reserved_exposure_usd::text, reserved_base_size::text,
      execution_limit_price::text, NULL::text AS fill_size, NULL::text AS disposed_size,
      NULL::text AS fill_price, NULL::text AS sell_state, NULL::text AS allocation_state
      FROM order_attempts
      WHERE inst_id = $1
      UNION ALL
      SELECT to_timestamp(fill_time / 1000.0), 'FILL'::text,
      side, source, NULL::text, execution_mode, execution_route,
      NULL::text, NULL::text, NULL::text, NULL::text,
      fill_size::text, disposed_size::text, fill_price::text, sell_state, allocation_state
      FROM filled_orders
      WHERE inst_id = $1
      UNION ALL
      SELECT updated_at, 'PROTECTION'::text,
      NULL::text, state, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text, NULL::text
      FROM instrument_protection
      WHERE inst_id = $1
    ) events
  )
  SELECT timeline.*, (SELECT count(*)::int FROM account_scope) AS scope_account_count
  FROM timeline
  ORDER BY event_time ASC, event_type ASC`;

export function validateInstrument(instrument) {
  if (typeof instrument !== "string" || !INSTRUMENT_PATTERN.test(instrument)) {
    throw new Error("--instrument must be an exact uppercase OKX instrument, for example BTC-USDT");
  }
  return instrument;
}

export function redactTimeline(instrument, rows) {
  return {
    instrument: validateInstrument(instrument),
    timeline: rows.map((row) => ({
      eventTime: row.event_time instanceof Date ? row.event_time.toISOString() : row.event_time,
      eventType: row.event_type, intent: row.intent, state: row.state,
      reservationState: row.reservation_state, executionMode: row.execution_mode,
      executionRoute: row.execution_route, plannedSize: row.planned_size,
      reservedExposureUsd: row.reserved_exposure_usd, reservedBaseSize: row.reserved_base_size,
      executionLimitPrice: row.execution_limit_price, fillSize: row.fill_size,
      disposedSize: row.disposed_size, fillPrice: row.fill_price,
      sellState: row.sell_state, allocationState: row.allocation_state,
    })),
  };
}

export async function queryInstrumentTimeline({ instrument, connectionString = process.env.POSTGRES_URL, credential = new DefaultAzureCredential(), Pool, logger = () => {} } = {}) {
  const validatedInstrument = validateInstrument(instrument);
  const pool = new EntraPostgresPool({ connectionString, credential, Pool, logger, max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const result = await client.query(INSTRUMENT_TIMELINE_SQL, [validatedInstrument]);
    if (result.rows.some((row) => Number(row.scope_account_count) > 1)) throw new Error("Instrument timeline scope is ambiguous across accounts");
    return redactTimeline(validatedInstrument, result.rows);
  } finally {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
      client.release();
    }
    await pool.end();
  }
}

export function parseArgs(argv) {
  const args = [...argv]; let instrument;
  while (args.length) {
    const arg = args.shift();
    if (arg !== "--instrument") throw new Error(`Unknown argument: ${arg}`);
    if (instrument) throw new Error("--instrument may be supplied only once");
    instrument = validateInstrument(args.shift());
  }
  return { instrument: validateInstrument(instrument) };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await queryInstrumentTimeline(parseArgs(argv));
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
