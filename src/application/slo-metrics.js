export function percentile(samples, p) {
  const values = samples.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
}
export class VirtualSloMetrics {
  constructor(clock = { nowMs: () => 0 }) { this.clock = clock; this.samples = new Map(); this.counters = new Map(); }
  record(name, startedAt) { const value = this.clock.nowMs() - startedAt; if (Number.isFinite(value) && value >= 0) (this.samples.get(name) ?? this.samples.set(name, []).get(name)).push(value); return value; }
  observe(name, value) { if (Number.isFinite(value) && value >= 0) (this.samples.get(name) ?? this.samples.set(name, []).get(name)).push(value); }
  increment(name, value = 1) { this.counters.set(name, (this.counters.get(name) ?? 0) + value); return this.counters.get(name); }
  maximum(name, value) { this.counters.set(name, Math.max(this.counters.get(name) ?? 0, value)); return this.counters.get(name); }
  snapshot({ reset = false } = {}) {
    const result = {};
    for (const [name, values] of this.samples) {
      const finite = values.filter(Number.isFinite); if (!finite.length) continue;
      result[`${name}_count`] = finite.length; result[`${name}_p50_ms`] = percentile(finite, .5); result[`${name}_p95_ms`] = percentile(finite, .95); result[`${name}_p99_ms`] = percentile(finite, .99); result[`${name}_max_ms`] = Math.max(...finite);
    }
    for (const [name, value] of this.counters) result[name] = value;
    if (reset) { this.samples.clear(); this.counters.clear(); }
    return result;
  }
  assertInvariants() { const batch = Math.max(0, ...(this.samples.get("batch_size") ?? [])); const concurrency = Math.max(0, ...(this.samples.get("mutation_concurrency") ?? [])); if (batch > 5 || concurrency > 1) throw new Error("SLO_INVARIANT_VIOLATION"); return { maxBatchSize: batch, maxMutationConcurrency: concurrency, unknownCount: this.counters.get("unknown_count") ?? 0 }; }
  assertSlo() { const get = (name, p) => percentile(this.samples.get(name) ?? [], p); const e = get('event_enqueue', .99), s95 = get('signal_post', .95), s99 = get('signal_post', .99), prepared = get('prepared_post', .99); if ([e, s95, s99, prepared].some((x) => x === null) || e > 20 || s95 > 500 || s99 > 1000 || prepared > 20) throw new Error('SLO_VIOLATION'); return { eventEnqueueP99: e, signalPostP95: s95, signalPostP99: s99, preparedPostP99: prepared }; }
}
