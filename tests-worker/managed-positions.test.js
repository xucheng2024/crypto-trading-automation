import assert from "node:assert/strict";
import test from "node:test";
import { MANAGED_POSITIONS_JSON_PREFIX, MANAGED_POSITIONS_SQL, extractManagedPositionsJson, parseArgs, queryManagedPositions, redactManagedPositions } from "../scripts/query-managed-positions.mjs";

test("managed-position summary is a read-only redacted aggregate", async () => {
  const calls = []; let ended = 0; let released = 0;
  class Pool { on() {} async connect() { return { query: async (...args) => { calls.push(args); return args[0] === MANAGED_POSITIONS_SQL ? { rows: [{ inst_id: "BTC-USDT", remaining_size: "0.01", remaining_cost_usd: "1.25", open_fills: "1", sell_states: ["WAITING"], next_sell_time: 1, next_force_sell_time: 2, protected_fills: "1", unprotected_waiting_fills: "0", next_protection_anchor_time: null, anchor_due_unprotected_fills: "0", dust_pending_fills: "0", account_count: 1 }] } : {}; }, release: () => { released += 1; } }; } async end() { ended += 1; } }
  const result = await queryManagedPositions({ connectionString: "postgresql://user@host/db", credential: { getToken: async () => ({ token: "token", expiresOnTimestamp: Date.now() + 10_000 }) }, Pool });
  assert.deepEqual(calls.slice(0, 3).map(([sql]) => sql), ["BEGIN READ ONLY", "SET LOCAL statement_timeout = '5000ms'", "SET LOCAL lock_timeout = '1000ms'"]);
  assert.equal(calls[3][0], MANAGED_POSITIONS_SQL); assert.equal(calls.at(-1)[0], "ROLLBACK"); assert.equal(released, 1); assert.equal(ended, 1);
  assert.deepEqual(result, { summary: { instruments: 1, openFills: 1 }, positions: [{ instrument: "BTC-USDT", remainingCostUsd: "1.25", openFills: 1, sellStates: ["WAITING"], nextSellTime: 1, nextForceSellTime: 2, protectedFills: 1, unprotectedWaitingFills: 0, nextProtectionAnchorTime: null, anchorDueUnprotectedFills: 0, dustPendingFills: 0 }] });
  assert.match(MANAGED_POSITIONS_SQL, /^\s*(WITH|SELECT)/i); assert.doesNotMatch(MANAGED_POSITIONS_SQL, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.match(MANAGED_POSITIONS_SQL, /fill_price/);
  assert.throws(() => redactManagedPositions([{ account_count: 2 }]), /ambiguous across accounts/);
  assert.deepEqual(parseArgs([]), {}); assert.deepEqual(parseArgs([""]), {}); assert.throws(() => parseArgs(["--bad"]), /does not accept/);
  assert.deepEqual(extractManagedPositionsJson(`noise\n${MANAGED_POSITIONS_JSON_PREFIX}${JSON.stringify(result)}\n`), result);
  assert.throws(() => extractManagedPositionsJson("no marker"), /missing the redacted JSON marker/);
});
