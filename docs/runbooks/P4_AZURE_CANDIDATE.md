# Azure deployment and release runbook

This file began as the P4 candidate runbook and is now the authoritative Azure
release gate. Production is deployed in Azure with `TRADING_MODE=OFF`. Nothing
in this runbook authorizes `FULL` or any OKX mutation; changing to `FULL`
requires a separate, explicit operator authorization. PostgreSQL uses Entra-only
authentication; bootstrap runtime roles with the separately reviewed SQL
rehearsal, never a password environment variable.

## Mandatory change and deployment gate

Do not use Azure as the first test environment. For every code change:

1. Add or update a focused regression test for the changed behavior and run its
   test file locally.
2. Run `npm test` locally. This includes the temporary real-PostgreSQL lifecycle,
   restart, concurrency, reservation, Spot/Margin ordering and recovery tests.
   Any failure blocks image build and deployment.
3. For OKX REST, authentication or WebSocket changes, run the applicable real
   public, business and private connection checks locally. These checks are
   read-only: subscriptions and the hard-coded GET allowlist are permitted;
   order placement, cancellation, borrowing and every other mutation are not.
4. For migrations, container or IaC changes, also run the relevant
   `npm run migrate:rehearsal`, `npm run test:container`, `npm run test:iac`,
   Bicep build, Azure validate and what-if checks before deployment.
5. Review `git diff --check` and the exact diff. Preserve unrelated and untracked
   operator files. Commit and push the tested source before building an image.
6. Build once from that commit, push to ACR, and deploy only the immutable
   `repository@sha256:<digest>`. Never deploy a mutable tag.

If a cloud deployment exposes a defect, keep the service `OFF`, reproduce the
defect locally, add a regression test, run the gates above, and then build one
new digest. Do not repeatedly patch and probe production when the behavior can
be tested locally. Only Azure-specific control-plane, managed-identity, network,
Key Vault and Container Apps lifecycle behavior is deferred to post-deployment
verification.

## Preconditions

- Confirm East Asia quota, permitted PostgreSQL/Container Apps SKUs, and measured OKX endpoint latency.
- Confirm the Microsoft for Startups workload page, each real workload's cost above $1, roughly 60-day continuity, and Cost Management budget alerts. Never create empty resources or fake traffic for these figures.
- Obtain an immutable ACR digest. A tag is never a production revision.
- Use placeholders only: `<RESOURCE_GROUP>`, `<ACR>/<REPOSITORY>@sha256:<DIGEST>`, `<NAT_PUBLIC_IP>`, and `<OKX_ALLOWLIST_ENTRY>`.

## Local candidate checks

```sh
npm run test:iac
npm run test:container
npm run migrate:rehearsal
npm run read-only-preflight
```

Azure CLI 2.89.1 and Bicep 0.46.1 were installed by the authorized operator.
The 2026-08-14 external gate completed a warning-free build, Azure validate,
and what-if. Repeat these checks after every IaC change; static checks never
replace provider-schema compilation or the Azure service-side checks.

Review-only Azure commands (do not run without separate authorization):

```sh
az bicep build --file infrastructure/bicep/main.bicep
az deployment group validate --resource-group <RESOURCE_GROUP> --template-file infrastructure/bicep/main.bicep --parameters infrastructure/bicep/parameters.example.json
az deployment group what-if --resource-group <RESOURCE_GROUP> --template-file infrastructure/bicep/main.bicep --parameters infrastructure/bicep/parameters.example.json
az deployment group create --resource-group <RESOURCE_GROUP> --confirm-with-what-if --template-file infrastructure/bicep/main.bicep --parameters infrastructure/bicep/parameters.example.json
```

The separately authorized real preflight reads OKX credentials from Key Vault
through the logged-in Azure CLI identity and permits only its hard-coded GET
allowlist. It never accepts credential values from environment variables:

```sh
P4_REAL_PREFLIGHT_AUTHORIZED=true \
KEY_VAULT_URI=https://<KEY_VAULT_NAME>.vault.azure.net \
OKX_PREFLIGHT_INST_ID=<ENABLED_INST_ID> \
npm run read-only-preflight -- --real
```

Build/push is a human-gated operation; do not substitute a tag for the recorded digest.
Container Apps in this environment run `linux/amd64`; builds made on an Apple
Silicon workstation must therefore declare the platform explicitly. Before
deploying, inspect the pushed digest and confirm it contains `linux/amd64`.
An `arm64`-only image can surface in Container Apps as misleading
`ImagePullBackOff` or unauthorized-pull diagnostics even when `AcrPull` is
configured correctly:

```sh
docker buildx build --platform linux/amd64 --push --tag <ACR>/<REPOSITORY>:<COMMIT> .
docker buildx imagetools inspect <ACR>/<REPOSITORY>:<COMMIT>
# Record and deploy only <ACR>/<REPOSITORY>@sha256:<DIGEST>.
```

## Safe OFF deployment and health

Deploy only with `TRADING_MODE=OFF`. Apply migrations and the offline import rehearsal first. Verify the NAT IP is the sole PostgreSQL firewall entry and the planned OKX allowlist entry. Verify Engine identity has AcrPull and minimum Key Vault secret read; the maintenance identity has AcrPull only and no Key Vault/OKX secret access.

The initial template deployment creates the two managed identities. Record its principal ID/name outputs, connect as the configured Entra administrator, replace the reviewed placeholders in `P4_POSTGRES_ENTRA_BOOTSTRAP.sql`, apply migrations and role grants, then restart the still-OFF revision. During bootstrap the Engine may remain unready. Never grant Maintenance direct order-table mutation; it gets only the bounded retention function.

Supply converter output verbatim as `strategyConfigJson`, the enabled pairs as `okxInstruments`, and an explicitly reviewed UTC epoch as `managedFillStartMs`. The source user JSON files are never copied into the image. Missing per-pair strategy data fails ACCOUNT BUY ingestion closed.

Verify liveness, global READY and RECOVERING from redacted telemetry. READY must remain false until owner lock, recovery, public/private/business WS baselines, account and instruments are fresh. A temporary WS outage is an alert/reconnect condition, not a liveness-kill loop.

The Engine uses a PostgreSQL session advisory lock and must have only one owner.
For an image-only release, create the new `OFF` revision, deactivate every old
or automatically reactivated fallback revision, and verify that only the final
revision remains active. Azure may temporarily reactivate an older fallback
while a new revision is unready; listing only the latest revision is therefore
insufficient. If the new process attempted startup while the old owner still
held the lock, let it restart or restart only the final revision after all old
replicas have stopped.

If a new migration causes `POSTGRES_MIGRATIONS_MISSING`, do not weaken the
startup check. Keep the revision `OFF`, apply the reviewed SQL as the Entra
database administrator, remove any temporary operator firewall rule immediately,
then restart the final OFF revision. A migration is complete only when the
startup gate and readiness probe both pass.

Every deployment must finish with all of the following evidence:

- the deployed image exactly matches the recorded immutable digest and tested
  commit;
- `TRADING_MODE=OFF` unless a separate explicit authorization says otherwise;
- the configured instrument count and strategy hash match the reviewed inputs;
- exactly one revision is active with one ready replica and Azure health is
  `Healthy`;
- `/health/live` succeeds and `/health/ready` returns HTTP 200; owner, database,
  public/private/business WebSockets, account and instruments are all ready;
- the real OKX GET-only preflight succeeds without exposing credentials or
  sending a mutation.

A successful deployment does not imply authorization to enable trading. Leave
the service `OFF` and report the evidence before any proposed mode change.

## FULL gate (not authorized here)

Before separately authorized `FULL`: inventory legacy mutation schedulers, then manually verify old scheduler/API-key/pending-algo cleanup; use ownership filters only. `FULL` needs new explicit authorization. Observe the first order and ledger state. Never scan positions, pending algo, bills or unrelated shared-account assets.

## Recommended automation

Use a GitHub Actions workflow with GitHub-to-Azure OIDC federation rather than
long-lived Azure credentials or an IDE deployment plugin. The workflow should:

1. run the local test, container, IaC and migration-rehearsal gates;
2. use Buildx to build and push `linux/amd64`, then inspect the pushed manifest;
3. deploy the immutable digest in `OFF` mode and wait for one healthy revision;
4. apply reviewed migrations through a dedicated, least-privileged migration
   runner; and
5. require a protected-environment approval before changing to `FULL`, then
   explicitly deactivate all older revisions and verify the final owner lock.

The Azure Container Apps deploy action can perform the image update, but the
guarded `az containerapp` steps remain necessary for the migration, revision
inventory, and OFF-to-FULL approval boundary.

## Incident and rollback

For UNKNOWN, risk breach, stale WS, owner loss, or DB loss: preserve attempts, inspect only ownership-filtered read-only data, then use the emergency order `FULL → EXIT_ONLY → OFF` after human confirmation. Roll back only to the compatible prior Azure image **digest**, which will reacquire owner and recover. Test PITR/backup restoration in an isolated environment before relying on it.
