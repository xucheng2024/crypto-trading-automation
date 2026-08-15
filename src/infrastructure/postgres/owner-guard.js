import { OwnerGuard } from "../../azure/owner-guard.js";

export class PostgresOwnerGuard extends OwnerGuard {
  #client;
  #held = false;
  #key;
  #lossListeners = new Set();

  constructor(client, key = "azure-trading-owner") {
    super();
    this.#client = client;
    this.#key = key;
    const lost = () => {
      if (!this.#held) return;
      this.#held = false; for (const listener of this.#lossListeners) listener();
    };
    client.on?.("error", lost);
    client.on?.("end", lost);
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
    return this.#held;
  }

  async release() {
    try {
      if (this.#held) {
        await this.#client.query("SELECT pg_advisory_unlock(hashtext($1))", [this.#key]);
      }
    } finally {
      this.#held = false;
    }
  }
}
