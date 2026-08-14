// A scenario is executable code, not a label plus a pre-filled snapshot.  It
// must register assertions while it drives its injected ports; the runner
// rejects a matrix row whose named assertion was never executed.
export class P4SystemHarness {
  constructor({ clock = { nowMs: () => 0 }, fakeOkx = {}, postgres = {}, runtime = null, createRuntime = null } = {}) { Object.assign(this, { clock, fakeOkx, postgres, runtime, createRuntime }); this.executed = new Set(); }
  assert(id, condition, message = id) { this.executed.add(id); if (!condition) throw new Error(`P4_ASSERTION_FAILED:${message}`); }
  async restart() {
    await this.runtime?.shutdown?.("P4_RESTART");
    if (typeof this.createRuntime !== "function") throw new Error("P4_RUNTIME_RECREATE_UNAVAILABLE");
    this.runtime = await this.createRuntime();
    return this.runtime;
  }
  async stopPostgres() { if (typeof this.postgres.stop !== "function") throw new Error("P4_POSTGRES_STOP_UNAVAILABLE"); return this.postgres.stop(); }
  async startPostgres() { if (typeof this.postgres.start !== "function") throw new Error("P4_POSTGRES_START_UNAVAILABLE"); return this.postgres.start(); }
  async exhaustPool() { if (typeof this.postgres.exhaust !== "function") throw new Error("P4_POOL_EXHAUST_UNAVAILABLE"); return this.postgres.exhaust(); }
  async run({ id, assertionId, execute }) {
    if (typeof execute !== "function" || !assertionId) throw new TypeError("P4 scenario requires executable assertionId");
    const result = await execute(this);
    if (!this.executed.has(assertionId)) throw new Error(`P4_ASSERTION_NOT_EXECUTED:${id ?? assertionId}`);
    return result;
  }
}
export const P4ReplayHarness = P4SystemHarness;
