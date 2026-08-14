// Single-process consumer for projection events and the sole Coordinator.
// Work is bounded per turn so ticker pressure cannot starve WS callbacks.
export class EngineWorkLoop {
  constructor({ engine, coordinator, timers = globalThis, intervalMs = 10, maxEvents = 100, maxBatches = 20, telemetry = () => {} } = {}) {
    Object.assign(this, { engine, coordinator, timers, intervalMs, maxEvents, maxBatches, telemetry }); this.timer = null; this.running = false;
  }
  start() { if (!this.timer) this.timer = this.timers.setInterval(() => void this.run(), this.intervalMs); }
  stop() { if (this.timer) this.timers.clearInterval(this.timer); this.timer = null; }
  async run() {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      let events = 0; while (events < this.maxEvents && await this.engine.consumeOne()) events += 1;
      let batches = 0; while (batches < this.maxBatches) { const result = await this.coordinator.drainOnce(); if (!result.submitted && !["PREEMPTED", "FINAL_GUARD"].includes(result.reason)) break; batches += 1; }
      return { events, batches };
    } catch (error) { try { await this.telemetry({ type: "engine_loop", reason: "ENGINE_LOOP_FAILED", error: error?.message }); } catch {} return { error: true }; }
    finally { this.running = false; }
  }
}
