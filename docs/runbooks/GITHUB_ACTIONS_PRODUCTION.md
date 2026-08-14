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
- migration identity: PostgreSQL migration DDL role plus only the Flexible
  Server firewall-rule permission required for the short-lived runner rule.

Create GitHub repository secrets:

- `AZURE_DEPLOY_CLIENT_ID`
- `AZURE_MIGRATION_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

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
The temporary runner firewall rule is deleted with an `always` shell trap.

## Use

Run **Production deploy** manually. With `promote_full=false`, it stops at the
verified OFF revision. With `promote_full=true`, the workflow pauses at the
protected `production-full` environment before it can change the mode. The
workflow has a repository-wide `production-deploy` concurrency group, so two
deployments cannot modify revisions concurrently.

`scripts/apply-postgres-migrations.mjs` stores a SHA-256 hash for each reviewed
migration in `schema_migrations`. A changed historical migration fails closed;
new migrations must be append-only and added to that script's ordered list.
