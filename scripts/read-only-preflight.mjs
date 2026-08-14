import { readFile } from "node:fs/promises";
import { runReadOnlyPreflight } from "../src/entrypoints/azure/read-only-preflight.js";

const fixturePath = process.argv[2] ?? "fixtures/p4/preflight-offline.json";
if (process.argv.includes("--real")) throw new Error("Real preflight is disabled in this candidate; obtain separate authorization first");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
console.log(JSON.stringify(await runReadOnlyPreflight({ mode: "offline", fixture })));
