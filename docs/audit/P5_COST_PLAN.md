# P5 cost-optimized OFF rollout

Date: 2026-08-14. This plan records the operator-authorized cost reduction before any P5 workload deployment. It does not authorize `FULL` or any OKX mutation.

## Production shape

- Container Apps Consumption: one Engine replica and one scheduled maintenance Job, each explicitly `0.25 vCPU / 0.5 GiB`.
- PostgreSQL Flexible Server 16: `Standard_B1ms`, Burstable, 32 GB auto-growing storage, 14-day PITR, Entra-only authentication, TLS, and no HA standby.
- Container Registry Basic with immutable image digest deployment and admin credentials disabled.
- NAT Gateway plus Standard static public IP remains mandatory for stable outbound identity and the PostgreSQL firewall.
- Log Analytics/Application Insights, Key Vault, and budget/alerts retain real production responsibilities.

The non-HA database is an explicit cost tradeoff. PostgreSQL or zone loss can cause downtime, but the Engine loses its advisory owner/session and fails closed; no new mutation is allowed. PITR, automatic storage growth, immutable images, single-replica restart, and OFF-first rollout remain intact. B2s, SameZone, or ZoneRedundant can be selected later through parameters without redesign.

## East Asia retail estimate

Public retail prices queried on 2026-08-14, before credits and taxes:

| Workload | Estimated monthly USD | Basis |
|---|---:|---|
| PostgreSQL B1ms + 32 GB | ~26 | $0.0286/hour plus $0.15/GB-month |
| NAT Gateway + Standard public IP | ~36.5 plus data | $0.045/hour + $0.005/hour |
| ACR Basic | ~5 | $0.1666/day |
| Container Apps | ~6–20 | one always-on minimum replica; active/idle mix varies |
| Azure Monitor | usage-based | real application/platform telemetry; 1 GB/day is a cap, not a target |
| Key Vault | usage-based | three OKX secrets, startup/rotation reads only |

Expected steady-state total is roughly $73–95 plus actual monitoring, network data, and backup overage. The deployment budget alert is $150/month; it is an alert, not a hard cap.

## Milestone 3

The five intended sustained, real workloads are Container Apps, PostgreSQL, Container Registry, NAT Gateway, and Azure Monitor. Key Vault is an additional real service but low request volume may remain below $1. The Microsoft for Startups workload page remains authoritative: verify each recognized workload stays above $1 for 60 continuous days. Do not create empty resources, fake traffic, or padded telemetry; if Monitor does not naturally cross $1, review a genuinely needed service rather than manufacturing usage.
