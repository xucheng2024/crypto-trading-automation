import { DefaultAzureCredential } from "@azure/identity";
import { EntraPostgresPool } from "../src/infrastructure/postgres/entra-pool.js";

const connectionString = process.env.POSTGRES_URL;
const principalName = process.env.POSITIONS_READ_MI_NAME;
const principalOid = process.env.POSITIONS_READ_MI_OBJECT_ID;
if (!connectionString) throw new Error("POSTGRES_URL is required");
if (!principalName || !/^[a-z0-9-]+$/.test(principalName)) throw new Error("POSITIONS_READ_MI_NAME is invalid");
if (!principalOid || !/^[0-9a-f-]{36}$/i.test(principalOid)) throw new Error("POSITIONS_READ_MI_OBJECT_ID is invalid");

const tradingUrl = new URL(connectionString);
if (tradingUrl.password) throw new Error("POSTGRES_URL must not contain a password");
const database = decodeURIComponent(tradingUrl.pathname.slice(1) || "trading");
if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error("database name is invalid");
const postgresUrl = new URL(tradingUrl);
postgresUrl.pathname = "/postgres";
const quoted = `"${principalName}"`;
const credential = new DefaultAzureCredential();

async function withPool(url, fn) {
  const pool = new EntraPostgresPool({ connectionString: url.toString(), credential, max: 1 });
  try { return await fn(pool); } finally { await pool.end(); }
}

await withPool(postgresUrl, async (pool) => {
  const existing = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [principalName]);
  if (!existing.rowCount) {
    await pool.query("SELECT * FROM pgaadauth_create_principal_with_oid($1, $2, 'service', false, false)", [principalName, principalOid]);
    console.log("positions-read principal created");
  } else console.log("positions-read principal exists");
  await pool.query(`GRANT CONNECT ON DATABASE "${database}" TO ${quoted}`);
});
await withPool(tradingUrl, async (pool) => {
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
  await pool.query(`GRANT SELECT ON TABLE filled_orders TO ${quoted}`);
  console.log("positions-read SELECT grant applied");
});
