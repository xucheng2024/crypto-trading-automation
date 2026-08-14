import pg from "pg";

export const AZURE_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

function redacted(value) { return String(value ?? "").replace(/:\/\/[^@]+@/, "://***@"); }

// Token authentication is requested for every newly-created connection.  No
// password is kept in config, process environment, telemetry, or database.
export class EntraPostgresPool {
  constructor({ connectionString, credential, Pool = pg.Pool, logger = () => {}, onUnavailable = () => {}, max = 10, ssl = { rejectUnauthorized: true } } = {}) {
    if (!connectionString?.startsWith("postgres")) throw new Error("POSTGRES_URL is required");
    const parsed = new URL(connectionString);
    if (parsed.password) throw new Error("POSTGRES_URL must not contain a password; Entra token is the only authentication secret");
    if (!credential?.getToken) throw new TypeError("PostgreSQL TokenCredential is required");
    if (ssl?.rejectUnauthorized !== true) throw new Error("PostgreSQL TLS certificate verification is required");
    this.credential = credential; this.logger = logger; this.onUnavailable = onUnavailable; this.closed = false;
    this.pool = new Pool({ connectionString, max, ssl, password: async () => {
      try { const token = await credential.getToken(AZURE_POSTGRES_SCOPE); if (!token?.token || token.expiresOnTimestamp <= Date.now()) throw new Error("expired"); return token.token; }
      catch { logger({ reason: "POSTGRES_TOKEN_UNAVAILABLE", connection: redacted(connectionString) }); throw new Error("POSTGRES_TOKEN_UNAVAILABLE"); }
    } });
    this.pool.on?.("error", () => { this.onUnavailable("POSTGRES_POOL_ERROR"); logger({ reason: "POSTGRES_POOL_ERROR", connection: redacted(connectionString) }); });
  }
  async connect() { if (this.closed) throw new Error("POSTGRES_POOL_CLOSED"); try { return await this.pool.connect(); } catch (error) { this.onUnavailable("POSTGRES_POOL_UNAVAILABLE"); this.logger({ reason: "POSTGRES_POOL_UNAVAILABLE" }); throw error; } }
  async query(...args) { const client = await this.connect(); try { return await client.query(...args); } finally { client.release(); } }
  async transaction(fn) { const client = await this.connect(); try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); } }
  async end() { this.closed = true; await this.pool.end(); }
}
