import assert from "node:assert/strict";
import test from "node:test";
import { INSTRUMENT_TIMELINE_SQL, parseArgs as parseTimelineArgs, queryInstrumentTimeline, redactTimeline, validateInstrument } from "../scripts/query-instrument-timeline.mjs";
import { parseArgs, runTradeCommand } from "../scripts/azure-ops-summary.mjs";

test("instrument timeline rejects injection and ambiguous instruments", () => {
  for (const value of ["BTC-USDT; DELETE FROM filled_orders", "btc-usdt", "BTC USDT", "BTC-USDT' OR '1'='1", undefined]) assert.throws(() => validateInstrument(value), /exact uppercase OKX instrument/);
  assert.deepEqual(parseTimelineArgs(["--instrument", "BTC-USDT"]), { instrument: "BTC-USDT" });
  assert.throws(() => parseTimelineArgs(["--instrument", "BTC-USDT", "--instrument", "ETH-USDT"]), /only once/);
  assert.throws(() => parseArgs(["trade", "--instrument", "BTC-USDT"]), /exactly one/);
  assert.throws(() => parseArgs(["trade", "--instrument", "BTC-USDT", "--request", "--run-id", "7"]), /exactly one/);
});

test("instrument timeline uses a parameterized constant SELECT inside a read-only transaction", async () => {
  const calls = []; let ended = 0; let released = 0;
  class Pool { on() {} async connect() { return { query: async (...args) => { calls.push(args); return args[0] === INSTRUMENT_TIMELINE_SQL ? { rows: [{ event_time: new Date("2026-01-01T00:00:00Z"), event_type: "FILL", intent: "BUY", state: "SYSTEM", fill_size: "0.010", disposed_size: "0", fill_price: "100.25" }] } : {}; }, release: () => { released += 1; } }; } async end() { ended += 1; } }
  const result = await queryInstrumentTimeline({ instrument: "BTC-USDT", connectionString: "postgresql://user@host/db", credential: { getToken: async () => ({ token: "token", expiresOnTimestamp: Date.now() + 10_000 }) }, Pool });
  assert.deepEqual(calls.slice(0, 3).map(([sql]) => sql), ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '5000ms'", "SET LOCAL lock_timeout = '1000ms'"]);
  assert.equal(calls[3][0], INSTRUMENT_TIMELINE_SQL); assert.deepEqual(calls[3][1], ["BTC-USDT"]); assert.equal(calls.at(-1)[0], "ROLLBACK");
  assert.equal(released, 1); assert.equal(ended, 1); assert.equal(result.timeline[0].fillSize, "0.010"); assert.equal(result.timeline[0].fillPrice, "100.25");
  assert.match(INSTRUMENT_TIMELINE_SQL, /^\s*(WITH|SELECT)/i); assert.doesNotMatch(INSTRUMENT_TIMELINE_SQL, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  await assert.rejects(queryInstrumentTimeline({ instrument: "BTC-USDT", connectionString: "postgresql://user@host/db", credential: { getToken: async () => ({ token: "token", expiresOnTimestamp: Date.now() + 10_000 }) }, Pool: class { on() {} async connect() { return { query: async (sql) => sql === INSTRUMENT_TIMELINE_SQL ? { rows: [{ scope_account_count: 2 }] } : {}, release() {} }; } async end() {} } }), /ambiguous across accounts/);
});

test("instrument timeline output retains decimal and state fields while excluding secret ledger fields", () => {
  const output = redactTimeline("BTC-USDT", [{ event_time: "2026-01-01T00:00:00Z", event_type: "ORDER_ATTEMPT", record_kind: "CURRENT_STATE_SNAPSHOT", state_observed_at: "2026-01-01T01:00:00Z", attempt_ref: "A1", intent: "BUY", state: "PREPARED", reservation_state: "ACTIVE", execution_mode: "cross", execution_route: "margin", planned_size: "0.123456789", reserved_exposure_usd: "12.34", execution_limit_price: "99.99", sell_time: "1", force_sell_time: "2", protection_price: "98.5", sell_trigger_reason: "PRICE_BREAKDOWN", account_id: "forbidden", trade_id: "forbidden", cl_ord_id: "forbidden", decision_id: "forbidden", payload_hash: "forbidden", fee: "forbidden", strategy_config_hash: "forbidden", error_message: "forbidden" }]);
  const encoded = JSON.stringify(output); assert.match(encoded, /0.123456789/); assert.match(encoded, /PREPARED/); assert.match(encoded, /PRICE_BREAKDOWN/);
  assert.equal(output.attemptRefScope, "QUERY_SNAPSHOT"); assert.deepEqual(output.summary.attemptStates, { PREPARED: 1 }); assert.equal(output.timeline[0].stateObservedAt, "2026-01-01T01:00:00Z"); assert.equal(output.timeline[0].attemptRef, "A1");
  for (const forbidden of ["account_id", "trade_id", "cl_ord_id", "decision_id", "payload_hash", "fee", "strategy_config_hash", "error_message", "forbidden"]) assert.doesNotMatch(encoded, new RegExp(forbidden));
});

test("trade CLI dispatches only on explicit request and reads only a matching workflow artifact", async () => {
  const options = parseArgs(["trade", "--instrument", "BTC-USDT", "--request"]); const commands = [];
  const requested = await runTradeCommand(options, { command: (...args) => { commands.push(args); return args[0] === "gh" && args[1].includes(".default_branch") ? "main" : "owner/repo"; }, json: () => ({}) });
  assert.deepEqual(requested, { command: "trade", requested: true, instrument: "BTC-USDT", repository: "owner/repo", branch: "main" });
  assert.deepEqual(commands.at(-1), ["gh", ["workflow", "run", "production-ops-read.yml", "--repo", "owner/repo", "--ref", "main", "-f", "instrument=BTC-USDT"]]);
  await assert.rejects(runTradeCommand(parseArgs(["trade", "--instrument", "BTC-USDT", "--run-id", "8"]), { command: () => "owner/repo", json: () => ({ path: ".github/workflows/production-deploy.yml" }), fs: {} }), /not a production instrument timeline run/);
});

test("trade CLI preserves only the redacted timeline association and snapshot fields", async () => {
  const options = parseArgs(["trade", "--instrument", "BTC-USDT", "--run-id", "7"]);
  const result = await runTradeCommand(options, {
    command: () => "owner/repo",
    json: () => ({ path: ".github/workflows/production-ops-read.yml" }),
    fs: { mkdtemp: async () => "/tmp/timeline", rm: async () => {}, readFile: async () => JSON.stringify({ instrument: "BTC-USDT", attemptRefScope: "QUERY_SNAPSHOT", summary: { attemptSnapshots: 1, fills: 1, protectionSnapshots: 0, attemptStates: { SETTLED: 1 }, raw: "forbidden" }, timeline: [{ eventTime: "1", eventType: "FILL", recordKind: "DURABLE_EVENT", stateObservedAt: "1", attemptRef: "A1", tradeId: "forbidden" }] }) },
  });
  assert.equal(result.attemptRefScope, "QUERY_SNAPSHOT"); assert.deepEqual(result.summary, { attemptSnapshots: 1, fills: 1, protectionSnapshots: 0, attemptStates: { SETTLED: 1 } });
  assert.deepEqual(result.timeline, [{ eventTime: "1", eventType: "FILL", recordKind: "DURABLE_EVENT", stateObservedAt: "1", attemptRef: "A1" }]);
});
