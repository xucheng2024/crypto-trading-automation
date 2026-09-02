import { OwnerGuard } from "../../azure/owner-guard.js";

export class PostgresOwnerGuard extends OwnerGuard {
  #client;
  #held = false;
  #key;
  #telemetry;
  #nowMs;
  #acquiredAtMs = null;
  #lossListeners = new Set();

  constructor(client, key = "azure-trading-owner", telemetry = () => {}, nowMs = () => Date.now()) {
    super();
    this.#client = client;
    this.#key = key;
    this.#telemetry = telemetry;
    this.#nowMs = nowMs;
    const lost = (restartClass) => () => {
      if (!this.#held) return;
      const sessionHeldMs = this.#acquiredAtMs == null ? 0 : Math.max(0, this.#nowMs() - this.#acquiredAtMs);
      this.#held = false;
      this.#acquiredAtMs = null;
      try { this.#telemetry({ type: "owner_lost", reason: "SESSION_ADVISORY_LOCK_LOST", restartClass, sessionHeldMs }); } catch { /* loss must fail closed even if telemetry throws */ }
      for (const listener of this.#lossListeners) listener();
    };
    client.on?.("error", lost("db_connection_reset"));
    client.on?.("end", lost("db_lock_lost"));
  }

  isHeld() {
    return this.#held;
  }

  onLost(listener) {
    this.#lossListeners.add(listener);
    return () => this.#lossListeners.delete(listener);
  }

  async acquire() {
    if (this.#held) return true;
    const result = await this.#client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS held",
      [this.#key],
    );
    this.#held = result.rows[0].held === true;
    this.#acquiredAtMs = this.#held ? this.#nowMs() : null;
    return this.#held;
  }

  async release() {
    try {
      if (this.#held) {
        await this.#client.query("SELECT pg_advisory_unlock(hashtext($1))", [this.#key]);
      }
    } finally {
      this.#held = false;
      this.#acquiredAtMs = null;
    }
  }
}
