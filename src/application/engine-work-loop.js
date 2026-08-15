// Two independently scheduled consumers so a slow Coordinator REST round trip
// (max-avail-size, batch-orders) can never freeze projection-event evaluation.
// Bounded per turn so ticker pressure cannot starve WS callbacks.
export class EngineWorkLoop {
  constructor({ engine, coordinator, timers = globalThis, intervalMs = 10, maxEvents = 100, maxBatches = 20, telemetry = () => {} } = {}) {
    Object.assign(this, { engine, coordinator, timers, intervalMs, maxEvents, maxBatches, telemetry });
    this.eventTimer = null; this.mutationTimer = null; this.runningEvents = false; this.runningMutations = false; this.marketChains = new Map();
  }
  start() {
    if (!this.eventTimer) this.eventTimer = this.timers.setInterval(() => void this.runEvents(), this.intervalMs);
    if (!this.mutationTimer) this.mutationTimer = this.timers.setInterval(() => void this.runMutations(), this.intervalMs);
  }
  stop() {
    if (this.eventTimer) this.timers.clearInterval(this.eventTimer); this.eventTimer = null;
    if (this.mutationTimer) this.timers.clearInterval(this.mutationTimer); this.mutationTimer = null;
  }
  async runEvents() {
    if (this.runningEvents) return { skipped: true };
    this.runningEvents = true;
    try {
      // Newer engines expose dequeue/dispatch so only market decisions may run
      // concurrently.  A chain per instrument preserves ticker/recheck order;
      // orders and exit events retain their existing serialized handling.
      if (typeof this.engine.takeOne !== "function" || typeof this.engine.dispatch !== "function") {
        let events = 0; while (events < this.maxEvents && await this.engine.consumeOne()) events += 1;
        return { events };
      }
      let events = 0;
      while (events < this.maxEvents) {
        const event = this.engine.takeOne(); if (!event) break;
        events += 1;
        if (event.type === "ticker" || event.type === "market-recheck") this._scheduleMarket(event);
        else await this.engine.dispatch(event);
      }
      return { events };
    } catch (error) { try { await this.telemetry({ type: "engine_loop", reason: "ENGINE_EVENTS_FAILED", error: error?.message }); } catch {} return { error: true }; }
    finally { this.runningEvents = false; }
  }
  _scheduleMarket(event) {
    const key = event.instId;
    const previous = this.marketChains.get(key) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(() => this.engine.dispatch(event)).catch(async (error) => {
      try { await this.telemetry({ type: "engine_loop", reason: "ENGINE_MARKET_EVENT_FAILED", instId: key, error: error?.message }); } catch {}
    });
    this.marketChains.set(key, running);
    void running.then(() => { if (this.marketChains.get(key) === running) this.marketChains.delete(key); });
  }
  async runMutations() {
    if (this.runningMutations) return { skipped: true };
    this.runningMutations = true;
    try {
      let batches = 0; while (batches < this.maxBatches) { const result = await this.coordinator.drainOnce(); if (!result.submitted && !["PREEMPTED", "FINAL_GUARD"].includes(result.reason)) break; batches += 1; }
      return { batches };
    } catch (error) { try { await this.telemetry({ type: "engine_loop", reason: "ENGINE_MUTATIONS_FAILED", error: error?.message }); } catch {} return { error: true }; }
    finally { this.runningMutations = false; }
  }
}
