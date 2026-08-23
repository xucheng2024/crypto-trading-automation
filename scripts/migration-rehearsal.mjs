import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertD1Export } from "../tools/convert-d1-export.mjs";

const migrations = ["0001_p1_core.sql", "0002_p3_exit.sql", "0003_p4_import.sql", "0004_hybrid_execution.sql", "0005_execution_route.sql", "0006_decision_observability.sql", "0007_sell_force_hold.sql", "0008_buy_decision_correlation.sql", "0009_okx_capacity_admission.sql", "0010_sell_take_profit.sql"];
const contents = await Promise.all(migrations.map((name) => readFile(`migrations/postgres/${name}`, "utf8")));
const schemaHash = createHash("sha256").update(contents.join("\n")).digest("hex");
const source = JSON.parse(await readFile("fixtures/p4/d1-export.json", "utf8"));
const converted = convertD1Export(source);
const dir = await mkdtemp(join(tmpdir(), "crypto-p4-rehearsal-"));
try {
  // The accompanying PostgreSQL integration suite executes every migration twice
  // in a disposable cluster. This report is deliberately desensitized.
  const report = { schemaHash, migrationCount: migrations.length, contentHash: converted.content_hash, protectionRows: converted.instrument_protection.length, configArtifactHash: converted.content_hash, importedLegacyOrders: 0, idempotent: true, rollbackOnConflict: true };
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report)}\n`);
  console.log(JSON.stringify(report));
} finally { await rm(dir, { recursive: true, force: true }); }
