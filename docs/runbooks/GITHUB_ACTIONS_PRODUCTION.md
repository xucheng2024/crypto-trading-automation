# GitHub Actions production deployment

The workflows in `.github/workflows/` implement the production release path:

`validate → immutable linux/amd64 image → migration → one OFF revision → one FULL revision`.

The OFF revision must become healthy before the workflow automatically creates
the FULL revision from the same immutable digest.

The engine uses a PostgreSQL advisory owner lock. It is intentionally a
singleton, so this is not a blue/green traffic deployment: a second revision
cannot become business-ready while the first revision holds the lock. The
workflow therefore deactivates old active revisions before it waits for the new
one to become healthy.

## One-time GitHub configuration

Create two Azure application registrations with GitHub OIDC federated
credentials restricted to this repository and the `production` environment
(plus the deployment identity's default-branch subject if already present):

- deployment identity: ACR push; resource-group-scoped `Container Apps
  Contributor` and `Azure Deployment Stack Contributor`; and `Managed Identity
  Operator` scoped only to the production ACR pull identity. These rights allow
  the bootstrap to create/update the Runner without granting database, network,
  Key Vault, role-assignment, or general Contributor access;
- migration identity: PostgreSQL migration DDL role. It does not require
  Flexible Server firewall-rule permission because migrations run from the
  VNet-integrated self-hosted runner through the existing NAT allowlist.
  Keep this identity separate from the deployment identity.

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

Create one protected GitHub environment named `production` with a protected-branch
policy. Do not attach required reviewers unless you want every migrate, OFF
deploy, and FULL promote to wait for the same approval. Promote FULL only after
explicit operator authorization; the workflow itself does not add a second
environment gate.

The migration identity must be created as a PostgreSQL principal with the
minimum schema DDL rights. Do not reuse the engine or maintenance identity.

Before the first production deployment, run **Production runner bootstrap**
from a GitHub-hosted runner. It builds a SHA-256-verified GitHub Actions runner
image, pushes it to ACR by immutable digest, and deploys a no-ingress,
single-replica Container App in the existing Container Apps Environment. The
bootstrap uses the deployment identity through the `production`
environment; it never grants resource deployment rights to the migration
identity. It reuses the production app's existing least-privilege ACR pull
identity rather than creating another role assignment. The
runner therefore shares the production VNet and fixed NAT IP already allowed
by PostgreSQL. It registers with the `crypto-remote-migration` label, accepts
one job with `--ephemeral`, clears its work directory, exits, and is restarted
by Container Apps. Rotate `GH_RUNNER_PAT` by rerunning the bootstrap workflow.

## Use

Run **Production deploy** manually. It verifies an OFF revision, then promotes
the same digest to FULL automatically. The workflow has a repository-wide
`production-deploy` concurrency group, so two deployments cannot modify
revisions concurrently.

Use **Production promote FULL** only to recover from a production deployment
that completed at OFF before this workflow change. It promotes the exact
healthy OFF digest without rebuilding, rerunning tests, reopening the database
firewall, or reapplying migrations.

Production deploy requires a successful `CI` run for the exact commit instead
of repeating the suite, and fails immediately if CI is still running. Images
tagged with the same commit are reused. The PostgreSQL server records the
reviewed migration-set fingerprint after a successful application; unchanged
sets skip dependency installation. Migration runs only after the image build
succeeds, so the single VNet migration Runner is never reserved while it waits
for an image.

`scripts/apply-postgres-migrations.mjs` stores a SHA-256 hash for each reviewed
migration in `schema_migrations`. A changed historical migration fails closed;
new migrations must be append-only and added to
`scripts/postgres-migration-manifest.mjs` in execution order.
