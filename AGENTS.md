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

- Deploy only through the existing GitHub Actions workflows.
- Use `production-deploy.yml` to build, migrate, and deploy a healthy `TRADING_MODE=OFF` revision.
- Promote with `production-promote-full.yml` only after explicit user authorization.
- On failure, inspect only the failed workflow step and affected Azure resource.
- For Container Apps, inspect only the target app, active or latest revision, health, mode, image digest, traffic, and recent errors.
- Never expose secrets or dump complete configurations, environment variables, or logs.
- Stop after the requested revision is healthy and the workflow succeeds.

# Communication

- Keep progress updates, command output, findings, and final responses concise.
- Report only actionable failures, material risks, deployment mode, revision, health, commit, and workflow URL.
