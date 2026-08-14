import assert from 'node:assert/strict';
import test from 'node:test';
import { percentile, VirtualSloMetrics } from '../src/application/slo-metrics.js';
import { TradingEngine } from '../src/application/trading-engine.js';
test('P4 SLO uses virtual monotonic time and rejects empty or abnormal samples', () => { assert.equal(percentile([], .99), null); assert.equal(percentile([1, NaN, 3], .5), 1); const c = { n: 0, nowMs() { return this.n; } }; const m = new VirtualSloMetrics(c); for (const [name, value] of [['event_enqueue', 20], ['signal_post', 500], ['prepared_post', 20]]) m.observe(name, value); assert.equal(m.assertSlo().signalPostP95, 500); assert.throws(() => new VirtualSloMetrics(c).assertSlo(), /SLO_VIOLATION/); });
test('P4 SLO enforces real Coordinator batch and mutation-concurrency invariants', () => { const m = new VirtualSloMetrics(); m.observe('batch_size', 5); m.observe('mutation_concurrency', 1); m.increment('unknown_count', 2); assert.deepEqual(m.assertInvariants(), { maxBatchSize: 5, maxMutationConcurrency: 1, unknownCount: 2 }); m.observe('batch_size', 6); assert.throws(() => m.assertInvariants(), /SLO_INVARIANT_VIOLATION/); });
test('P4 SLO hooks observe actual WS projection and bounded latest-ticker queue', () => {
  const clock = { n: 0, nowMs() { return this.n; } }; const slo = new VirtualSloMetrics(clock); const engine = new TradingEngine({ clock, slo });
  for (let i = 1; i <= 100; i += 1) { clock.n += 1; engine.receiveTicker({ instId: 'Q-USDT', ts: i, last: String(i), askPx: String(i) }); }
  assert.equal(engine.projection.ticker('Q-USDT').ts, 100); assert.equal(engine.queue.size, 1); assert.equal(percentile(slo.samples.get('event_enqueue'), .99), 0); assert.equal(percentile(slo.samples.get('ws_projection_enqueue'), .99), 0); assert.equal(percentile(slo.samples.get('queue_depth'), 1), 1);
});
