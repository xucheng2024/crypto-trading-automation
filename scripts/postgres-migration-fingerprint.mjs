import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { postgresMigrations } from "./postgres-migration-manifest.mjs";

const migrationDirectory = new URL("../migrations/postgres/", import.meta.url);
const actualMigrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
if (JSON.stringify(actualMigrations) !== JSON.stringify([...postgresMigrations].sort())) {
  throw new Error("PostgreSQL migration manifest does not exactly match migrations/postgres/*.sql");
}

const hash = createHash("sha256");
for (const name of postgresMigrations) {
  hash.update(name).update("\0");
  hash.update(await readFile(new URL(name, migrationDirectory)));
  hash.update("\0");
}
process.stdout.write(`${hash.digest("hex")}\n`);
