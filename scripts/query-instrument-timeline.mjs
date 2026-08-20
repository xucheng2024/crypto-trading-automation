import { DefaultAzureCredential } from "@azure/identity";
import { fileURLToPath } from "node:url";
import { EntraPostgresPool } from "../src/infrastructure/postgres/entra-pool.js";

export const INSTRUMENT_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)?$/;
export const INSTRUMENT_TIMELINE_JSON_PREFIX = "INSTRUMENT_TIMELINE_JSON:";

// This statement deliberately selects only the redacted operational timeline.
// Do not add account, trade, order, decision, hash, fee, configuration, or
// error columns: this command's output is retained as a support artifact.
export const INSTRUMENT_TIMELINE_SQL = `
  WITH account_scope AS (
    SELECT account_id FROM order_attempts WHERE inst_id = $1
    UNION
    SELECT account_id FROM filled_orders WHERE inst_id = $1
  ), attempts AS (
    SELECT id,cl_ord_id,created_at,updated_at,intent,state,reservation_state,execution_mode,execution_route,
      planned_size,reserved_exposure_usd,reserved_base_size,execution_limit_price,
      concat('A',row_number() OVER (ORDER BY created_at,id)) AS attempt_ref
    FROM order_attempts WHERE inst_id = $1
  ), timeline AS (
    SELECT event_time, event_type, record_kind, state_observed_at, attempt_ref, intent, state, reservation_state,
    execution_mode, execution_route, planned_size, reserved_exposure_usd,
    reserved_base_size, execution_limit_price, fill_size, disposed_size,
    fill_price, sell_time, force_sell_time, protection_price, sell_state,
    sell_trigger_reason, allocation_state
    FROM (
      SELECT created_at AS event_time, 'ORDER_ATTEMPT'::text AS event_type,
      'CURRENT_STATE_SNAPSHOT'::text AS record_kind, updated_at AS state_observed_at, attempt_ref,
      intent, state, reservation_state, execution_mode, execution_route,
      planned_size::text, reserved_exposure_usd::text, reserved_base_size::text,
      execution_limit_price::text, NULL::text AS fill_size, NULL::text AS disposed_size,
      NULL::text AS fill_price, NULL::bigint AS sell_time, NULL::bigint AS force_sell_time,
      NULL::text AS protection_price, NULL::text AS sell_state, NULL::text AS sell_trigger_reason,
      NULL::text AS allocation_state
      FROM attempts
      UNION ALL
      SELECT to_timestamp(f.fill_time / 1000.0), 'FILL'::text,
      'DURABLE_EVENT'::text, to_timestamp(f.fill_time / 1000.0), a.attempt_ref,
      f.side, f.source, NULL::text, f.execution_mode, f.execution_route,
      NULL::text, NULL::text, NULL::text, NULL::text,
      f.fill_size::text, f.disposed_size::text, f.fill_price::text, f.sell_time, f.force_sell_time,
      f.protection_price::text, f.sell_state, f.sell_trigger_reason, f.allocation_state
      FROM filled_orders f LEFT JOIN attempts a ON a.cl_ord_id=f.source_attempt_cl_ord_id
      WHERE f.inst_id = $1
      UNION ALL
      SELECT updated_at, 'PROTECTION'::text,
      'CURRENT_STATE_SNAPSHOT'::text, updated_at, NULL::text,
      NULL::text, state, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bigint,
      NULL::text, NULL::text, NULL::text, NULL::text
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
  const timeline = rows.map((row) => ({
    eventTime: row.event_time instanceof Date ? row.event_time.toISOString() : row.event_time,
    eventType: row.event_type, recordKind: row.record_kind, stateObservedAt: row.state_observed_at instanceof Date ? row.state_observed_at.toISOString() : row.state_observed_at,
    attemptRef: row.attempt_ref, intent: row.intent, state: row.state,
    reservationState: row.reservation_state, executionMode: row.execution_mode,
    executionRoute: row.execution_route, plannedSize: row.planned_size,
    reservedExposureUsd: row.reserved_exposure_usd, reservedBaseSize: row.reserved_base_size,
    executionLimitPrice: row.execution_limit_price, fillSize: row.fill_size,
    disposedSize: row.disposed_size, fillPrice: row.fill_price, sellTime: row.sell_time,
    forceSellTime: row.force_sell_time, protectionPrice: row.protection_price,
    sellState: row.sell_state, sellTriggerReason: row.sell_trigger_reason,
    allocationState: row.allocation_state,
  }));
  return {
    instrument: validateInstrument(instrument),
    attemptRefScope: "QUERY_SNAPSHOT",
    summary: {
      attemptSnapshots: timeline.filter((row) => row.eventType === "ORDER_ATTEMPT").length,
      fills: timeline.filter((row) => row.eventType === "FILL").length,
      protectionSnapshots: timeline.filter((row) => row.eventType === "PROTECTION").length,
      attemptStates: Object.fromEntries(timeline.filter((row) => row.eventType === "ORDER_ATTEMPT").reduce((counts, row) => counts.set(row.state, (counts.get(row.state) ?? 0) + 1), new Map())),
    },
    timeline,
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

export function parseArgs(argv, { instrument: defaultInstrument = process.env.INSTRUMENT } = {}) {
  const args = [...argv]; let instrument = defaultInstrument;
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
  console.log(`${INSTRUMENT_TIMELINE_JSON_PREFIX}${JSON.stringify(result)}`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
