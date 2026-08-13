import { createSystemClock, requireClock } from "./clock.js";
import { loadAzureRuntimeConfig } from "./config.js";
import { AzureMutationPort } from "./mutation-port.js";
import { OwnerGuard, RecoveryState } from "./owner-guard.js";

export function createAzureRuntime(env = {}, { clock = createSystemClock(), ownerGuard = new OwnerGuard(), recoveryState = new RecoveryState(), dependencies = {}, mutationHandler } = {}) {
  const config = loadAzureRuntimeConfig(env);
  return Object.freeze({
    config,
    clock: requireClock(clock),
    ownerGuard,
    recoveryState,
    mutationPort: new AzureMutationPort({ config, ownerGuard, recoveryState, dependencies, mutationHandler }),
  });
}
