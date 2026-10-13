import { readFile } from "node:fs/promises";
import pg from "pg";

const pool = new pg.Pool({ host: process.env.OBSERVATION_POSTGRES_HOST, database: "observation", user: "observeradmin", password: process.env.OBSERVATION_POSTGRES_PASSWORD, ssl: { rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: 15_000 });
try {
  await pool.query(await readFile(new URL("../migrations/observation/0001_market_observations.sql", import.meta.url), "utf8"));
  console.log("Market observation schema initialized inside the VNet");
} finally { await pool.end(); }
