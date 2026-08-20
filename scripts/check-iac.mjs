import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const root = await readFile("infrastructure/bicep/main.bicep", "utf8");
const files = await Promise.all(["network", "registry", "keyvault", "postgres", "observability", "apps", "alerts"].map((n) => readFile(`infrastructure/bicep/modules/${n}.bicep`, "utf8")));
const [runnerBicep, runnerEntrypoint, runnerDockerfile] = await Promise.all(["infrastructure/bicep/github-runner.bicep", "infrastructure/runner/entrypoint.sh", "infrastructure/runner/Dockerfile"].map((file) => readFile(file, "utf8")));
const text = [root, ...files, runnerBicep].join("\n");
const [instrumentArtifact, strategyArtifact] = await Promise.all([
  readFile("infrastructure/config/p5-enabled-instruments.json", "utf8").then(JSON.parse),
  readFile("infrastructure/config/p5-strategy.json", "utf8").then(JSON.parse),
]);
for (const word of ["managedEnvironments", "containerApps", "jobs", "natGateways", "flexibleServers", "flexibleServers/databases", "enableRbacAuthorization: true", "adminUserEnabled: false", "name: 'TRADING_MODE', value: 'OFF'", "KEY_VAULT_URI", "POSTGRES_URL", "OKX_INSTRUMENTS", "MANAGED_FILL_START_MS", "STRATEGY_CONFIG_JSON", "MAINTENANCE_ADAPTER_MODULE", "secretRef: 'appinsights-connection-string'", "sha256", "activeDirectoryAuth: 'Enabled'", "passwordAuth: 'Disabled'", "flexibleServers/administrators", "roleAssignments", "AcrPull", "keyVaultSecretsUserRole", "monitoringReaderRole", "cronExpression: '5 0 * * *'", "triggerType: 'Manual'", "query-managed-positions.mjs", "positions-read", "query-instrument-timeline.mjs", "timeline-read", "budgetContactEmails", "dailyQuotaGb", "actionGroups", "metricAlerts", "scheduledQueryRules", "engine-restart", "postgres-storage-70", "postgres-storage-85-backup-ha", "maintenance-job-failure", "nat-anomaly", "keyvault-anomaly", "acr-anomaly", "ready-false", "owner-recovering", "unknown-orders", "risk-halt", "exit-backlog", "pending-sell-watermark", "appinsights-ingestion-70", "appinsights-ingestion-90", "Standard_B1ms", "highAvailabilityMode", "storageSizeGb", "skuName: acrSku", "cpu: json('0.25')", "memory: '0.5Gi'"]) if (!text.includes(word) && !root.includes(word)) throw new Error(`IaC control missing: ${word}`);
if (/name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: applicationInsightsConnectionString/.test(text)) throw new Error("App Insights connection string must use a Container Apps secretRef");
for (const control of ["managedEnvironmentId: environmentId", "minReplicas: 1, maxReplicas: 1", "secretRef: 'github-runner-pat'", "userAssignedIdentities", "identity: registryIdentityId"]) if (!runnerBicep.includes(control)) throw new Error(`GitHub runner control missing: ${control}`);
if (runnerBicep.includes("ingress:") || /GITHUB_RUNNER_PAT', value:/.test(runnerBicep)) throw new Error("GitHub runner must have no ingress and must consume PAT through secretRef");
for (const control of ["--ephemeral", "--disableupdate", "unset GITHUB_RUNNER_PAT", "rm -rf _work"]) if (!runnerEntrypoint.includes(control)) throw new Error(`ephemeral runner control missing: ${control}`);
if (!runnerDockerfile.includes("sha256sum --check --strict")) throw new Error("GitHub runner archive must be SHA-256 verified");
for (const forbidden of ["privateEndpoints", "privateDnsZones", "serviceBus", "redis", "Microsoft.Storage", "administratorLoginPassword", "replace-at-deploy", ":latest"]) if (text.toLowerCase().includes(forbidden.toLowerCase())) throw new Error(`forbidden resource or secret: ${forbidden}`);
if (!root.includes("imageDigest") || !root.includes("@sha256:")) throw new Error("image digest is not enforced");
if (text.includes("maintenanceVaultRead") || text.includes("maintenance") && text.includes("keyVaultSecretsUserRole") && !text.includes("engineVaultRead")) throw new Error("maintenance Key Vault boundary violated");
if (text.includes("positionsReadVaultRead") || text.includes("positionsRead") && text.includes("keyVaultSecretsUserRole") && !text.includes("engineVaultRead")) throw new Error("positions-read Key Vault boundary violated");
if (text.includes("allOf: []") || !text.includes("metricName:") || !text.includes("threshold:")) throw new Error("metric alerts must define concrete criteria");
for (const invalid of ["SNATConnectionCount", "TotalPullCount", "threshold > 0"]) if (text.includes(invalid)) throw new Error(`invalid alert rule retained: ${invalid}`);
if (instrumentArtifact.enabled_count !== instrumentArtifact.enabled.length || new Set(instrumentArtifact.enabled).size !== instrumentArtifact.enabled.length) throw new Error("P5 enabled instrument artifact count/uniqueness mismatch");
const margin = instrumentArtifact.routes?.margin ?? []; const spot = instrumentArtifact.routes?.spot ?? [];
if (instrumentArtifact.margin_count !== margin.length || instrumentArtifact.spot_count !== spot.length) throw new Error("P5 route artifact count mismatch");
if (new Set([...margin, ...spot]).size !== instrumentArtifact.enabled.length || [...margin, ...spot].some((instId) => !instrumentArtifact.enabled.includes(instId))) throw new Error("P5 margin/spot routes must exactly partition enabled instruments");
const blacklisted = new Set(strategyArtifact.instrument_protection.filter((row) => row.state === "BLACKLISTED").map((row) => row.inst_id));
if (instrumentArtifact.enabled.some((instId) => blacklisted.has(instId))) throw new Error("P5 enabled instrument artifact contains a blacklisted instrument");
const localParameters = await readFile("infrastructure/bicep/parameters.p5.json", "utf8").then(JSON.parse).catch(() => null);
if (localParameters && localParameters.parameters.okxInstruments.value !== instrumentArtifact.enabled.join(",")) throw new Error("P5 deployment parameters do not match the enabled instrument artifact");
console.log("IaC static safety checks passed; this is not a Bicep compilation");
if (spawnSync("bicep", ["--version"], { stdio: "ignore" }).error && spawnSync("az", ["bicep", "version"], { stdio: "ignore" }).error) console.log("BICEP_CLI_UNAVAILABLE: install/authorize Bicep before build, lint, validate, or what-if");
