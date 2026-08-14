import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { convertD1Export } from "../tools/convert-d1-export.mjs";

const run = promisify(execFile);

function fixture() {
  return {
    blacklist: [
      { crypto_symbol: "ETH", reason: "legacy protection", is_active: true },
      { crypto_symbol: "OLD", is_active: false },
      { crypto_symbol: "btc-usdt", is_active: true },
    ],
    limits: [
      { inst_id: "ETH-USDT", best_limit: "80", best_duration: "2D" },
      { inst_id: "btc-usdt", best_limit: "70.5", best_duration: "6H" },
    ],
  };
}

test("D1 conversion is deterministic, filtered and versioned", () => {
  const input = fixture();
  const output = convertD1Export(input);
  assert.equal(output.schema_version, 1);
  assert.match(output.content_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(output.instrument_protection.map((row) => row.inst_id), ["BTC-USDT", "ETH-USDT"]);
  assert.deepEqual(output.config, [
    { inst_id: "BTC-USDT", best_limit: "70.5", hold_hours: "6" },
    { inst_id: "ETH-USDT", best_limit: "80", hold_hours: "48" },
  ]);
  const reversed = { blacklist: [...input.blacklist].reverse(), limits: [...input.limits].reverse() };
  assert.deepEqual(convertD1Export(reversed), output);
  assert.deepEqual(convertD1Export(input), output);
});

test("D1 conversion accepts only explicitly declared legacy duration units", () => {
  const legacy = { blacklist: [], limits: [{ inst_id: "BTC-USDT", best_limit: "70", best_duration: "2" }], legacyDurationUnit: "D" };
  assert.equal(convertD1Export(legacy).config[0].hold_hours, "48");
  assert.throws(() => convertD1Export({ ...legacy, legacyDurationUnit: undefined }), /explicit H or D unit/);
});

test("D1 conversion rejects invalid schema, values and duplicates", () => {
  assert.throws(() => convertD1Export(null), /Input must be an object/);
  assert.throws(() => convertD1Export({ blacklist: [], limits: {} }), /limits array/);
  assert.throws(() => convertD1Export({ blacklist: [], limits: [{ inst_id: "BTC-USDT", best_limit: "0", best_duration: "1D" }] }), /Invalid best_limit/);
  assert.throws(() => convertD1Export({ blacklist: [{ crypto_symbol: "BTC" }, { crypto_symbol: "btc-usdt" }], limits: [] }), /Duplicate blacklist/);
  assert.throws(() => convertD1Export({ blacklist: [], limits: [{ inst_id: "BTC-EUR", best_limit: "70", best_duration: "1D" }] }), /Invalid limit inst_id/);
});

test("D1 conversion CLI writes repeatable content without external services", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crypto-p1-convert-"));
  const inputPath = join(dir, "input.json");
  const outputPath = join(dir, "output.json");
  try {
    await writeFile(inputPath, JSON.stringify(fixture()));
    await run(process.execPath, [new URL("../tools/convert-d1-export.mjs", import.meta.url).pathname, inputPath, outputPath]);
    const first = await readFile(outputPath, "utf8");
    await run(process.execPath, [new URL("../tools/convert-d1-export.mjs", import.meta.url).pathname, inputPath, outputPath]);
    assert.equal(await readFile(outputPath, "utf8"), first);
    assert.deepEqual(JSON.parse(first), convertD1Export(fixture()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
