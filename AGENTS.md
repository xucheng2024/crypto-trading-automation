# Scope

- Start with `git status` and the current diff.
- Inspect and modify only files on realistic dependency paths for the task.
- Preserve unrelated changes; do not perform repository-wide rewrites or fixes.
- Prefer `rg`, targeted tests, and concise command output.
- Use external documentation only when repository evidence is insufficient.

# Project Runtime

- This is a Node.js 22 ESM project using PostgreSQL, Bicep, Azure Container Apps, and GitHub Actions.
- Use Node.js 22 for CI and release parity.
- If Python files are introduced or modified, run Ruff only on those files; never apply repository-wide formatting automatically.

# Validation

Choose checks based on the changed paths:

- JavaScript logic: `node --test <affected test files>`.
- PostgreSQL or reconciliation changes: include `tests-worker/postgres.integration.test.js`.
- IaC changes: run `npm run test:iac` and `az bicep build --file infrastructure/bicep/main.bicep --stdout >/dev/null`.
- Container changes: run `npm run test:container`.
- Deployment workflow changes: run `node --test tests-worker/p4-deployment.test.js`.
- Before a commit, release, or production deployment, run `npm test`, relevant static checks, and `git diff --check`.
- Do not commit generated `infrastructure/bicep/main.json`.

# Review

- After implementation, review the current diff and affected callers, schemas, configuration, and tests once.
- Prioritize correctness, trading safety, concurrency, data integrity, secrets, compatibility, and deployment risk.
- Fix clear issues in one targeted pass, then run one final targeted validation.
- Do not continue an open-ended review/fix loop unless validation fails.
- Ignore speculative, style-only, unrelated, and legacy issues.

# Azure Production

- For user questions such as “最近系统正常么 / 有交易机会么 / 有被阻止么”, run `npm run ops:status -- report --since-last --details --expect-mode FULL` first; a missing local cursor automatically uses the latest 60 minutes.
- Use `snapshot` for runtime/version/restarts/errors/market lag/risk signals, `activity` for compact candidate-to-fill progression (`--details` for per-attempt timelines), and `blocks` for reason aggregation and per-instrument evidence.
- Use `positions --request` for the current redacted managed-position aggregate via the VNet `positions-read` job; do not query Postgres from the laptop.
- Use `deploy` for the latest or `--run-id` production workflow, jobs, pending approvals, active revision and migration Runner; use `runner` for the VNet Runner's Azure/GitHub readiness, restarts and credential-presence check. Add `--details` only after `deploy` reports a failure.
- Treat `PRICE_OUTSIDE`, `BREAKOUT_NOT_CONFIRMED`, `CANDLE_PENDING`, and `ASK_ABOVE_LIMIT` as normal market waiting; distinguish policy skips, safety/data blockers, opportunities, and execution events.
- Report the analyzed time range, health, configured/current-state coverage, opportunities, prepared/submitted/settled orders, and every reported blocker with time, instrument, route, and evidence; expand only reported anomalies.
- Correlate one admitted BUY by `decisionId` from candidate through guards and by both `decisionId` and `clOrdId` after durable preparation; prefer structured `block_evidence` fields over parsing trace messages.
- For blocker analysis, report stage coverage, exact capacity gaps when present, and the tool's `LIKELY_RECOVERABLE` / `MARKET_MOVED` / `SAFETY_BOUNDARY` classification; do not infer VPS-style L5 or subscription evidence this strategy does not collect.
- The cursor lives under `.git` and advances only after a successful `report`; `activity` and `blocks` do not advance it. Evidence is limited to retained App Insights telemetry, so identify unavailable or silent guard evidence instead of inferring it.
- Keep reads bounded (the helper caps child output at 4 MiB and event queries at 1,000–5,000 rows); inspect raw logs only after the summary reports an anomaly.
- Treat an inactive OFF revision's `owner_lost SESSION_ADVISORY_LOCK_LOST` during promotion as `EXPECTED_OFF_TRANSITION`; do not suppress current-revision or other inactive-revision severe traces.
- Deploy only through the existing GitHub Actions workflows.
- PostgreSQL migrations must run only on the `crypto-remote-migration` self-hosted runner inside the existing Container Apps VNet/NAT path; do not restore temporary GitHub-hosted runner firewall rules.
- Use `production-deploy.yml` to build, migrate, and deploy a healthy `TRADING_MODE=OFF` revision.
- Promote with `production-promote-full.yml` only after explicit user authorization.
- On failure, run `npm run ops:status -- deploy --run-id <id> --details` first, then inspect only the reported failed workflow step and affected Azure resource.
- For Container Apps, inspect only the target app, active or latest revision, health, mode, image digest, traffic, and recent errors.
- Never expose secrets or dump complete configurations, environment variables, or logs.
- Stop after the requested revision is healthy and the workflow succeeds.

# Communication

- Keep progress updates, command output, findings, and final responses concise.
- Write for the operator in plain English. The Codex Speeder chat line is a short human benefit; keep Speeder JSON compact. Do not put deploy or health results in that line. Hide other internal skill, routing, or tool status lines.
- Report only actionable failures, material risks, deployment mode, revision, health, commit, and workflow URL.
