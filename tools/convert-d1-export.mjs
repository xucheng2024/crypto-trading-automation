import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareDecimal } from "../src/decimal.js";
import { normalizeHoldHours } from "../src/domain/rules.js";

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`Input requires ${name} array`);
  return value;
}

function normalizeInstId(value, field) {
  const raw = String(value ?? "").trim().toUpperCase();
  const instId = raw.includes("-") ? raw : `${raw}-USDT`;
  if (!/^[A-Z0-9]+-USDT$/.test(instId)) throw new Error(`Invalid ${field}: ${value ?? "missing"}`);
  return instId;
}

function assertUnique(rows, label) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.inst_id)) throw new Error(`Duplicate ${label} inst_id: ${row.inst_id}`);
    seen.add(row.inst_id);
  }
}

export function convertD1Export(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
  const blacklist = requireArray(input.blacklist, "blacklist");
  const limits = requireArray(input.limits, "limits");
  const instrumentProtection = blacklist
    .filter((row) => row && row.is_active !== false)
    .map((row) => {
      const instId = normalizeInstId(row.crypto_symbol, "blacklist crypto_symbol");
      return {
        inst_id: instId,
        base_ccy: instId.slice(0, -5),
        state: "BLACKLISTED",
        reason: String(row.reason || "legacy blacklist"),
      };
    })
    .sort((left, right) => left.inst_id.localeCompare(right.inst_id));
  const config = limits
    .map((row) => {
      if (!row || typeof row !== "object") throw new Error("Invalid limit row");
      const bestLimit = String(row.best_limit ?? "").trim();
      if (!bestLimit || compareDecimal(bestLimit, "0") <= 0) throw new Error(`Invalid best_limit for ${row.inst_id ?? "unknown"}`);
      return {
        inst_id: normalizeInstId(row.inst_id, "limit inst_id"),
        best_limit: bestLimit,
        hold_hours: normalizeHoldHours(row.best_duration, input.legacyDurationUnit),
      };
    })
    .sort((left, right) => left.inst_id.localeCompare(right.inst_id));
  assertUnique(instrumentProtection, "blacklist");
  assertUnique(config, "limit");
  const payload = { schema_version: 1, instrument_protection: instrumentProtection, config };
  return Object.freeze({
    ...payload,
    content_hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  });
}

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("Usage: node tools/convert-d1-export.mjs input.json output.json");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const output = convertD1Export(input);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
