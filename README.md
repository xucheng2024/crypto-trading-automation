# Crypto Remote Trading Engine

Production trading runtime for OKX, implemented in Node.js and deployed to Azure Container Apps with PostgreSQL.

Infrastructure defaults to `TRADING_MODE=OFF`. Enabling `FULL` requires separate authorization and completion of the release gate in [`docs/runbooks/P4_AZURE_CANDIDATE.md`](docs/runbooks/P4_AZURE_CANDIDATE.md).

## Current architecture

```text
OKX WebSocket
  -> in-memory market/account projections
  -> bounded engine work loop
  -> BUY/SELL/DELIST planning
  -> PostgreSQL reservation and deterministic clOrdId
  -> OKX REST batch orders
  -> reconciliation and durable settlement
```

The runtime does not create OKX algo-trigger orders. Buy signals are evaluated from live ticker and confirmed candle observations, then admitted and submitted through the single order coordinator.

## Runtime components

- `src/entrypoints/azure/trading-engine.js` — production engine entrypoint.
- `src/application/` — signal planning, order coordination, reconciliation, protection and work loops.
- `src/infrastructure/okx/` — OKX REST and WebSocket clients.
- `src/infrastructure/postgres/` — persistence, ownership and reservation repositories.
- `src/entrypoints/azure/maintenance-job.js` — credential-free PostgreSQL maintenance job.
- `infrastructure/bicep/` — Azure Container Apps, PostgreSQL, Key Vault, networking and monitoring.

Historical migration decisions and evidence remain under `docs/design/` and `docs/audit/`. Offline D1-to-PostgreSQL conversion assets are retained only for reproducible migration evidence; they are not runtime dependencies.

## Local verification

Requirements: Node.js 22 and npm.

```bash
npm ci
npm test
npm run test:p4
npm run test:p4-replay
npm run test:p4-slo
npm run test:iac
npm run test:container
```

PostgreSQL integration tests require their documented local database prerequisites:

```bash
npm run test:postgres
```

## Local startup

The engine defaults to `OFF` when `TRADING_MODE` is absent. Real composition also requires Azure Key Vault and PostgreSQL configuration.

```bash
npm run trading-engine
```

Do not use local startup as authorization to enable trading. Deployment and mode changes must follow the Azure candidate runbook.

## Read-only production reports

The operations helper runs locally and reads Azure Container Apps and Application Insights through authenticated `az`/`gh` CLIs. It does not run inside Azure and does not mutate production resources.

```bash
# Full health, trading activity and blocker report since the last successful report.
npm run ops:status -- report --since-last --details --expect-mode FULL

# Runtime, revision, restart, error, market-lag and risk snapshot.
npm run ops:status -- snapshot --minutes 15

# Trading opportunities, pre-submit, API submission and settlement activity.
npm run ops:status -- activity --since-last --details

# Block reasons plus per-instrument time, route and market evidence.
npm run ops:status -- blocks --since-last --details

# Explicit historical boundary or machine-readable output.
npm run ops:status -- report --since 2026-08-15T04:00:00Z --json
```

The report cursor is stored under `.git` and is not committed. Only a successful `report` advances it; when no cursor exists, `--since-last` checks the latest 60 minutes. `activity` and `blocks` are read-only views and do not advance the cursor.

Decision telemetry distinguishes normal market waiting (`PRICE_OUTSIDE`, `BREAKOUT_NOT_CONFIRMED`, `CANDLE_PENDING`, `ASK_ABOVE_LIMIT`), policy states, safety/data blockers, opportunities and execution events. An admitted BUY receives a deterministic `decisionId`, which is carried through coordinator guards, the durable attempt, `clOrdId`, API outcome and confirmed fill. Structured `block_evidence` traces expose the stage, reason code and available market, freshness, capacity, sizing and routing evidence without parsing error text. Block reports classify events as `LIKELY_RECOVERABLE`, `MARKET_MOVED`, or `SAFETY_BOUNDARY`, summarize stage coverage, and report the smallest exact capacity gap when sizing evidence is available. With `--details`, activity and report output link each instrument through candidate, blocker, persistence, API and fill stages; default output remains a compact aggregate. Results remain limited to retained App Insights telemetry; unavailable evidence must not be inferred.

Reads are bounded to a 4 MiB child-process buffer, 5,000 decision/block events, 1,000 lifecycle events and 10 severe traces. Block evidence records `decisionId`/`clOrdId`, stage, time, instrument, route, relevant prices, freshness, capacity and sizing gaps, and whether the event occurred before the API boundary, after database reservation, at API acknowledgement, or at confirmed exchange settlement. Raw logs should be queried only when the summary identifies an anomaly.

## Trading modes

- `OFF` — no new exchange mutations.
- `EXIT_ONLY` — permits guarded SELL/DELIST operations but no BUY.
- `FULL` — permits guarded BUY/SELL/DELIST operations after ownership, recovery, readiness and risk checks pass.

## Deployment

Deploy immutable image digests only. Review the architecture in [`AZURE_WS_TRADING_DESIGN.md`](AZURE_WS_TRADING_DESIGN.md) and follow [`docs/runbooks/P4_AZURE_CANDIDATE.md`](docs/runbooks/P4_AZURE_CANDIDATE.md). The repository's Bicep configuration pins `TRADING_MODE=OFF`; changing it is outside the normal deployment workflow.
