const TERMINAL = new Set(["NOT_CREATED", "SETTLED"]);

// The private orders stream is the primary terminal signal.  This short-lived
// read-only loop covers the gap when that stream is delayed or briefly absent;
// the normal five-minute reconciliation remains the restart-safe backstop.
export class ExitSubmissionReconciler {
  constructor({ orders, reconciliation, transaction = async (fn) => fn(null), timers = globalThis, telemetry = () => {}, delaysMs = [250, 500, 1_000, 2_000, 5_000, 5_000, 5_000, 5_000, 5_000] } = {}) {
    if (!orders || !reconciliation) throw new TypeError("orders and reconciliation are required");
    if (!delaysMs.every((delay) => Number.isSafeInteger(delay) && delay > 0)) throw new TypeError("delaysMs must contain positive integers");
    Object.assign(this, { orders, reconciliation, transaction, timers, telemetry, delaysMs });
    this.pending = new Map(); this.running = new Set(); this.stopped = false;
  }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* telemetry cannot block exits */ } }
  schedule(attempt) {
    const clOrdId = attempt?.cl_ord_id ?? attempt?.clOrdId;
    const intent = attempt?.intent;
    if (this.stopped || !clOrdId || !["SELL", "DELIST"].includes(intent) || this.pending.has(clOrdId)) return false;
    const task = { clOrdId, index: 0, handle: null, running: false };
    this.pending.set(clOrdId, task); this._arm(task); return true;
  }
  async schedulePending(accountId) {
    const attempts = await this.transaction((tx) => this.orders.listNonTerminal?.(tx, accountId) ?? []);
    return this.scheduleAttempts(attempts);
  }
  scheduleAttempts(attempts = []) { return attempts.filter((attempt) => ["SELL", "DELIST"].includes(attempt.intent) && ["SUBMITTED", "UNKNOWN"].includes(attempt.state)).filter((attempt) => this.schedule(attempt)).length; }
  _arm(task) {
    if (this.stopped || !this.pending.has(task.clOrdId)) return;
    const delay = this.delaysMs[task.index++];
    if (delay === undefined) { this.pending.delete(task.clOrdId); this._emit({ type: "exit_confirmation", reason: "SHORT_WINDOW_EXHAUSTED", clOrdId: task.clOrdId }); return; }
    task.handle = this.timers.setTimeout(() => {
      const running = this._confirm(task); this.running.add(running);
      void running.finally(() => this.running.delete(running));
    }, delay);
  }
  async _confirm(task) {
    if (this.stopped || !this.pending.has(task.clOrdId) || task.running) return;
    task.running = true;
    try {
      const attempt = await this.transaction((tx) => this.orders.findByClOrdId?.(tx, task.clOrdId));
      if (!attempt || TERMINAL.has(attempt.state)) { this.pending.delete(task.clOrdId); return; }
      const result = await this.reconciliation.reconcileAttempt(attempt);
      this._emit({ type: "exit_confirmation", reason: "READ_ONLY_RECONCILE", clOrdId: task.clOrdId, outcome: result?.outcome });
      if (result?.outcome === "TERMINAL_SETTLED") { this.pending.delete(task.clOrdId); return; }
    } catch (error) {
      this._emit({ type: "exit_confirmation", reason: "READ_ONLY_RECONCILE_FAILED", clOrdId: task.clOrdId, error: error?.message });
    } finally {
      task.running = false;
    }
    this._arm(task);
  }
  async stop() {
    this.stopped = true;
    for (const task of this.pending.values()) if (task.handle) this.timers.clearTimeout(task.handle);
    this.pending.clear();
    await Promise.allSettled([...this.running]);
  }
}
