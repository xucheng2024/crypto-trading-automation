import { readFile } from "node:fs/promises";
const [dockerfile, ignore] = await Promise.all([readFile("Dockerfile", "utf8"), readFile(".dockerignore", "utf8")]);
for (const required of [
  "FROM node:22.14.0-alpine",
  "npm ci --omit=dev",
  "COPY src/decimal.js ./src/decimal.js",
  "COPY src/infrastructure/azure ./src/infrastructure/azure",
  "USER trading",
  "TRADING_MODE=OFF",
  "HEALTHCHECK",
  "ENTRYPOINT",
]) if (!dockerfile.includes(required)) throw new Error(`Dockerfile missing ${required}`);
for (const forbidden of [".env", "limits_d1.json", ".git"]) if (!ignore.includes(forbidden)) throw new Error(`.dockerignore missing ${forbidden}`);
if (dockerfile.includes("submitBatchOrders")) throw new Error("production image bypasses the application mutation boundary");
console.log("container static checks passed; no image pushed");
