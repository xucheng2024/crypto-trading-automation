import { runMaintenance } from "../src/entrypoints/azure/maintenance-job.js";
import { createApplicationInsightsTelemetry } from "../src/infrastructure/azure/application-insights-telemetry.js";

const adapterModule = process.env.MAINTENANCE_ADAPTER_MODULE;
if (!adapterModule) throw new Error("MAINTENANCE_ADAPTER_MODULE is required; maintenance fails closed without a PostgreSQL/management adapter");
const adapter = await import(adapterModule);
if (typeof adapter.createMaintenanceDependencies !== "function") throw new Error("maintenance adapter must export createMaintenanceDependencies");
const dependencies = await adapter.createMaintenanceDependencies();
if (dependencies.okx || dependencies.transport?.submitBatchOrders || dependencies.credentials) throw new Error("maintenance adapter must not load OKX trade credentials or mutation transport");
const telemetry = createApplicationInsightsTelemetry({ connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING, serviceName: "maintenance-job", environment: process.env.DEPLOYMENT_ENVIRONMENT ?? "p5", tradingMode: "OFF" });
try {
  const result = await runMaintenance(dependencies);
  telemetry({ event: "MAINTENANCE_COMPLETED", retentionCount: result.retentionCount });
  console.log(JSON.stringify(result));
} catch (error) {
  telemetry({ event: "MAINTENANCE_FAILED", error: error?.message });
  throw error;
} finally {
  await dependencies.close?.(); await telemetry.flush(); await telemetry.shutdown();
}
export { runMaintenance };
