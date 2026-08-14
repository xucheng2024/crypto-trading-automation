import { runMaintenance } from "../src/entrypoints/azure/maintenance-job.js";

const adapterModule = process.env.MAINTENANCE_ADAPTER_MODULE;
if (!adapterModule) throw new Error("MAINTENANCE_ADAPTER_MODULE is required; maintenance fails closed without a PostgreSQL/management adapter");
const adapter = await import(adapterModule);
if (typeof adapter.createMaintenanceDependencies !== "function") throw new Error("maintenance adapter must export createMaintenanceDependencies");
const dependencies = await adapter.createMaintenanceDependencies();
if (dependencies.okx || dependencies.transport?.submitBatchOrders || dependencies.credentials) throw new Error("maintenance adapter must not load OKX trade credentials or mutation transport");
try { console.log(JSON.stringify(await runMaintenance(dependencies))); }
finally { await dependencies.close?.(); }
export { runMaintenance };
