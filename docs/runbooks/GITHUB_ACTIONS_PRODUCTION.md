# GitHub Actions production deployment

The workflows in `.github/workflows/` implement the production release path:

`validate → immutable linux/amd64 image → migration → one OFF revision → protected FULL approval → one FULL revision`.

The engine uses a PostgreSQL advisory owner lock. It is intentionally a
singleton, so this is not a blue/green traffic deployment: a second revision
cannot become business-ready while the first revision holds the lock. The
workflow therefore deactivates old active revisions before it waits for the new
one to become healthy.

## One-time GitHub configuration

Create two Azure application registrations with GitHub OIDC federated
credentials restricted to this repository and the listed environments:

- deployment identity: ACR push and Container Apps update/revision permissions;
- migration identity: PostgreSQL migration DDL role. It does not require
  Flexible Server firewall-rule permission because migrations run from the
  VNet-integrated self-hosted runner through the existing NAT allowlist.

Create GitHub repository secrets:

- `AZURE_DEPLOY_CLIENT_ID`
- `AZURE_MIGRATION_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `GH_RUNNER_PAT` — a dedicated fine-grained token restricted to this
  repository with Repository Administration read/write solely so the runner
  can exchange it for short-lived registration tokens. Do not reuse a personal
  general-purpose CLI token.

Create GitHub repository variables (none contains a password):

- `AZURE_RESOURCE_GROUP`
- `ACR_NAME`
- `ACR_LOGIN_SERVER`
- `CONTAINER_APP_NAME`
- `POSTGRES_MIGRATION_URL` — Entra-only PostgreSQL URL for the dedicated
  migration principal; a URL password is rejected by the runner.

Create protected environments `production-migrate`, `production-off`, and
`production-full`. Require an operator approval for `production-full`; require
approval for the other two if the organization requires change-control before
migrations or an OFF rollout.

The migration identity must be created as a PostgreSQL principal with the
minimum schema DDL rights. Do not reuse the engine or maintenance identity.

Before the first production deployment, run **Production runner bootstrap**
from a GitHub-hosted runner. It builds a SHA-256-verified GitHub Actions runner
image, pushes it to ACR by immutable digest, and deploys a no-ingress,
single-replica Container App in the existing Container Apps Environment. The
runner therefore shares the production VNet and fixed NAT IP already allowed
by PostgreSQL. It registers with the `crypto-remote-migration` label, accepts
one job with `--ephemeral`, clears its work directory, exits, and is restarted
by Container Apps. Rotate `GH_RUNNER_PAT` by rerunning the bootstrap workflow.

## Use

Run **Production deploy** manually. With `promote_full=false`, it stops at the
verified OFF revision. With `promote_full=true`, the workflow pauses at the
protected `production-full` environment before it can change the mode. The
workflow has a repository-wide `production-deploy` concurrency group, so two
deployments cannot modify revisions concurrently.

After an OFF deployment has already been verified, use **Production promote
FULL** for the separately authorized transition. It promotes the exact healthy
OFF digest after the `production-full` approval without rebuilding, rerunning
tests, reopening the database firewall, or reapplying migrations.

Production deploy requires a successful `CI` run for the exact commit instead
of repeating the suite. Images tagged with the same commit are reused. The
PostgreSQL server records the reviewed migration-set fingerprint after a
successful application; unchanged sets skip dependency installation. A
changed migration waits for the same workflow run's image build to succeed
before SQL is applied.

`scripts/apply-postgres-migrations.mjs` stores a SHA-256 hash for each reviewed
migration in `schema_migrations`. A changed historical migration fails closed;
new migrations must be append-only and added to
`scripts/postgres-migration-manifest.mjs` in execution order.
