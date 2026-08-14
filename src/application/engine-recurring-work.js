// Engine-only periodic work.  It is intentionally separate from the
// credential-free maintenance Job: these actions use the authenticated OKX
// read port but never the mutation transport.
export class EngineRecurringWork {
  constructor({ timers = globalThis, telemetry = () => {}, announcementMs = 60_000, reconcileMs = 300_000, routeMs = 3_600_000, weeklyMs = 7 * 86_400_000, metricsMs = 60_000, announcements = async () => {}, reconcile = async () => {}, refreshRoutes = async () => {}, weeklyReconcile = reconcile, reportMetrics = async () => {} } = {}) {
    Object.assign(this, { timers, telemetry, announcementMs, reconcileMs, routeMs, weeklyMs, metricsMs, announcements, reconcile, refreshRoutes, weeklyReconcile, reportMetrics });
    this.handles = []; this.busy = false;
  }
  _emit(event) { try { Promise.resolve(this.telemetry(event)).catch(() => {}); } catch { /* telemetry cannot alter scheduling */ } }
  async run(name, work) {
    if (this.busy) return { skipped: true, reason: "RECURRING_WORK_BUSY" };
    this.busy = true;
    try { await work(); return { ok: true }; }
    catch (error) { this._emit({ type: "recurring_work", reason: `${name}_FAILED`, error: error?.message }); return { ok: false }; }
    finally { this.busy = false; }
  }
  async runIndependent(name, work) {
    try { await work(); return { ok: true }; }
    catch (error) { this._emit({ type: "recurring_work", reason: `${name}_FAILED`, error: error?.message }); return { ok: false }; }
  }
  start() {
    if (this.handles.length) return;
    const add = (name, every, work, serialized = true) => {
      if (!Number.isSafeInteger(every) || every <= 0) throw new TypeError(`${name} interval must be a positive integer`);
      this.handles.push(this.timers.setInterval(() => serialized ? this.run(name, work) : this.runIndependent(name, work), every));
    };
    add("ANNOUNCEMENT", this.announcementMs, this.announcements);
    add("RECONCILE", this.reconcileMs, this.reconcile);
    add("ROUTE_REFRESH", this.routeMs, this.refreshRoutes);
    add("WEEKLY_RECONCILE", this.weeklyMs, this.weeklyReconcile);
    add("METRICS", this.metricsMs, this.reportMetrics, false);
  }
  stop() { for (const handle of this.handles.splice(0)) this.timers.clearInterval(handle); }
}
