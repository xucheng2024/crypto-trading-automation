# Azure deployment record — 2026-08-14

## Release

- Source commit: `6e4162c` (`fix: make exit recovery durable`)
- Deployed image: `crp4e24cacr.azurecr.io/trading-engine@sha256:34d4034be71b2cee52f36f14800774f3da0110958ac31f9316851a26dc20c240`
- Image platform: `linux/amd64`
- Final revision: `crp4e24c-cae-engine--full-6e4162e`

## Observed deployment faults and resolution

1. An initial image index contained only `linux/arm64`, because it had been
   built on Apple Silicon without an explicit target platform. Container Apps
   reported image-pull failures, including an initially misleading
   authorization diagnostic. Rebuilding with `docker buildx build --platform
   linux/amd64 --push` resolved the pull failure.
2. The application then correctly stopped at `POSTGRES_MIGRATIONS_MISSING`.
   The reviewed `0007_sell_force_hold.sql` migration was applied by the Entra
   PostgreSQL administrator. The narrowly scoped temporary operator firewall
   rule used for that connection was removed immediately afterwards; the
   server returned to its NAT-only rule.
3. During revision updates, Container Apps automatically reactivated an older
   healthy FULL fallback revision. This held the PostgreSQL session advisory
   lock and caused the new revision to report `OWNER_UNAVAILABLE`. The old
   revision was explicitly deactivated; the final revision then acquired the
   lock and became healthy.

## Final verification

- Exactly one revision was active.
- The final replica was running and ready, and Azure reported `Healthy`.
- The final image matched the immutable recorded digest.
- OFF was observed healthy before the separately authorized transition to FULL.

## Preventive controls

The Azure release runbook now requires an explicit `linux/amd64` build and
manifest check, reviewed migrations before activation, and a full active-
revision inventory after every Container Apps update.
