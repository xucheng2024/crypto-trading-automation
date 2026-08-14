# P4 Azure deployment candidate runbook

This runbook is preparation only. The local candidate is complete, while P4 is **blocked on external verification** until separately authorized Azure validate/what-if and real OKX read-only preflight pass. It must not be used to enter P5, stop legacy services, revoke keys, clear orders, or enable `FULL`. PostgreSQL uses Entra-only authentication; bootstrap runtime roles with the separately reviewed SQL rehearsal, never a password environment variable.

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

`az` and `bicep` are not installed in this workstation. This is the explicit
`BICEP_CLI_UNAVAILABLE` blocker: static IaC checks are not a Bicep compile.
The Azure SDK production dependencies are installed and locally exercised.
After an authorized operator installs Azure CLI/Bicep, run the build, lint,
validate and what-if commands below. Do not download tooling from this repository workflow.

Review-only Azure commands (do not run without separate authorization):

```sh
az bicep build --file infrastructure/bicep/main.bicep
az deployment group validate --resource-group <RESOURCE_GROUP> --template-file infrastructure/bicep/main.bicep --parameters infrastructure/bicep/parameters.example.json
az deployment group what-if --resource-group <RESOURCE_GROUP> --template-file infrastructure/bicep/main.bicep --parameters infrastructure/bicep/parameters.example.json
az deployment group create --resource-group <RESOURCE_GROUP> --confirm-with-what-if --template-file infrastructure/bicep/main.bicep --parameters infrastructure/bicep/parameters.example.json
```

Build/push is a human-gated operation; do not substitute a tag for the recorded digest:

```sh
docker build --tag <LOCAL_CANDIDATE_IMAGE> .
# After authorized ACR push, record <ACR>/<REPOSITORY>@sha256:<DIGEST> in parameters.
```

## Safe OFF deployment and health

Deploy only with `TRADING_MODE=OFF`. Apply migrations and the offline import rehearsal first. Verify the NAT IP is the sole PostgreSQL firewall entry and the planned OKX allowlist entry. Verify Engine identity has AcrPull and minimum Key Vault secret read; the maintenance identity has AcrPull only and no Key Vault/OKX secret access.

The initial template deployment creates the two managed identities. Record its principal ID/name outputs, connect as the configured Entra administrator, replace the reviewed placeholders in `P4_POSTGRES_ENTRA_BOOTSTRAP.sql`, apply migrations and role grants, then restart the still-OFF revision. During bootstrap the Engine may remain unready. Never grant Maintenance direct order-table mutation; it gets only the bounded retention function.

Supply converter output verbatim as `strategyConfigJson`, the enabled pairs as `okxInstruments`, and an explicitly reviewed UTC epoch as `managedFillStartMs`. The source user JSON files are never copied into the image. Missing per-pair strategy data fails ACCOUNT BUY ingestion closed.

Verify liveness, global READY and RECOVERING from redacted telemetry. READY must remain false until owner lock, recovery, public/private/business WS baselines, account and instruments are fresh. A temporary WS outage is an alert/reconnect condition, not a liveness-kill loop.

## P5 gate (not authorized here)

Before a separately authorized P5: inventory legacy mutation schedulers, then manually verify old scheduler/API-key/pending-algo cleanup; use ownership filters only. `FULL` needs new explicit authorization. Observe the first order and ledger state. Never scan positions, pending algo, bills or unrelated shared-account assets.

## Incident and rollback

For UNKNOWN, risk breach, stale WS, owner loss, or DB loss: preserve attempts, inspect only ownership-filtered read-only data, then use the emergency order `FULL → EXIT_ONLY → OFF` after human confirmation. Roll back only to the compatible prior Azure image **digest**, which will reacquire owner and recover. Test PITR/backup restoration in an isolated environment before relying on it.
