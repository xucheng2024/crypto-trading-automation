import assert from 'node:assert/strict';
import test from 'node:test';
import { P4SystemHarness } from '../src/application/p4-replay-harness.js';
import { TradingEngine, ReadyGate } from '../src/application/trading-engine.js';
import { evaluateWatchdog } from '../src/application/operations-watchdog.js';

test('P4 system harness rejects a matrix assertion which did not execute', async () => {
  await assert.rejects(new P4SystemHarness().run({ id: 'missing', assertionId: 'A', execute: () => {} }), /NOT_EXECUTED/);
});

test('P4 system harness recreates process and scripts PostgreSQL lifecycle ports', async () => {
  const events = []; let generation = 0;
  const harness = new P4SystemHarness({ postgres: { stop: async () => events.push('pg-stop'), start: async () => events.push('pg-start'), exhaust: async () => events.push('pg-exhaust') }, runtime: { shutdown: async () => events.push('shutdown') }, createRuntime: async () => ({ generation: ++generation }) });
  await harness.stopPostgres(); await harness.startPostgres(); await harness.exhaustPool(); const next = await harness.restart();
  assert.deepEqual(events, ['pg-stop', 'pg-start', 'pg-exhaust', 'shutdown']); assert.equal(next.generation, 1);
});

test('P4 scenario actual runtime coalesces q2 through q100 before replay assertion', async () => {
  let now = 0; const engine = new TradingEngine({ clock: { nowMs: () => now } });
  for (let i = 2; i <= 100; i += 1) { now += 1; engine.receiveTicker({ instId: 'Q-USDT', ts: i, last: String(i), askPx: String(i) }); }
  const harness = new P4SystemHarness({ runtime: engine });
  await harness.run({ id: 'COALESCE_100', assertionId: 'COALESCE_LATEST', execute: (h) => { h.assert('COALESCE_LATEST', engine.projection.ticker('Q-USDT').ts === 100 && engine.queue.size === 1); } });
});

test('P4 scenario actual READY and watchdog remain fail-closed after owner loss', async () => {
  const gate = new ReadyGate(['owner', 'public', 'private', 'business']);
  for (const key of ['owner', 'public', 'private', 'business']) gate.set(key, true);
  gate.set('owner', false);
  const verdict = evaluateWatchdog({ ready: gate.ready, owner: false, ws: { public: true, private: true, business: true } });
  const harness = new P4SystemHarness();
  await harness.run({ id: 'OWNER_LOSS', assertionId: 'OWNER_FAIL_CLOSED', execute: (h) => h.assert('OWNER_FAIL_CLOSED', gate.ready === false && /OWNER_LOST/.test(verdict.reasons.join(','))) });
});
