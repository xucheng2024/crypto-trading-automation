import { ManagedIdentityCredential } from "@azure/identity";
import { EntraPostgresPool } from "../../infrastructure/postgres/entra-pool.js";

// Credential-free with respect to OKX: this adapter obtains only an Entra
// PostgreSQL token for the maintenance identity and exposes no mutation port.
export async function createMaintenanceDependencies(env = process.env) {
  if (!env.POSTGRES_URL) throw new Error("POSTGRES_URL_REQUIRED");
  const pool = new EntraPostgresPool({ connectionString: env.POSTGRES_URL, credential: new ManagedIdentityCredential(), max: 2 });
  return { tx: { query: (...args) => pool.query(...args) }, close: () => pool.end() };
}
