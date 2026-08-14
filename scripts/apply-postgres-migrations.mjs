import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DefaultAzureCredential } from "@azure/identity";
import { EntraPostgresPool } from "../src/infrastructure/postgres/entra-pool.js";
import { postgresMigrations } from "./postgres-migration-manifest.mjs";

const connectionString = process.env.POSTGRES_MIGRATION_URL;
if (!connectionString) throw new Error("POSTGRES_MIGRATION_URL is required");
if (new URL(connectionString).password) throw new Error("POSTGRES_MIGRATION_URL must not contain a password");

const credential = new DefaultAzureCredential();
const pool = new EntraPostgresPool({ connectionString, credential, max: 1 });
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    content_hash text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("SELECT pg_advisory_lock(763489102349876123)");
  for (const name of postgresMigrations) {
    const sql = await readFile(new URL(`../migrations/postgres/${name}`, import.meta.url), "utf8");
    const contentHash = createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query("SELECT content_hash FROM schema_migrations WHERE name=$1", [name]);
    if (existing.rowCount) {
      if (existing.rows[0].content_hash !== contentHash) throw new Error(`MIGRATION_HASH_MISMATCH:${name}`);
      console.log(`migration already applied: ${name}`);
      continue;
    }
    await pool.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations(name, content_hash) VALUES($1,$2)", [name, contentHash]);
    });
    console.log(`migration applied: ${name}`);
  }
} finally {
  try { await pool.query("SELECT pg_advisory_unlock(763489102349876123)"); } catch {}
  await pool.end();
}
