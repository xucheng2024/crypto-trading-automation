import fs from "node:fs";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) throw new Error("Usage: node scripts/config-to-sql.mjs input.json output.sql");
const config = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const quote = (value) => value === undefined || value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const rows = Object.entries(config.crypto_configs || {}).map(([instId, item]) => `(${[
  instId, item.best_limit, item.best_duration, item.max_returns, item.trade_count, item.trades_per_month,
  item.avg_return_per_trade, item.win_rate, item.median_earn,
].map(quote).join(",")})`);
if (!rows.length) throw new Error("Configuration contains no crypto_configs");
const sql = [
  "DELETE FROM crypto_limits;",
  `INSERT INTO crypto_limits(inst_id,best_limit,best_duration,max_returns,trade_count,trades_per_month,avg_return_per_trade,win_rate,median_earn) VALUES\n${rows.join(",\n")};`,
  "",
].join("\n");
fs.writeFileSync(outputPath, sql, { mode: 0o600 });
console.log(`Prepared ${rows.length} crypto_limits row(s)`);
