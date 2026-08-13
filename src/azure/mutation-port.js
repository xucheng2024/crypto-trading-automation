import { authorizeMutation } from "./mutation-authorization.js";

// P0 deliberately has no OKX transport.  A handler can only be injected by a
// local test; a future coordinator must retain this authorization boundary.
export class AzureMutationPort {
  constructor({ config, ownerGuard, recoveryState, dependencies, mutationHandler }) {
    this.config = config;
    this.ownerGuard = ownerGuard;
    this.recoveryState = recoveryState;
    this.dependencies = dependencies;
    this.mutationHandler = mutationHandler;
  }

  async submit(mutation, payload) {
    const authorization = authorizeMutation({
      tradingMode: this.config.tradingMode,
      mutation,
      ownerGuard: this.ownerGuard,
      recoveryState: this.recoveryState,
      dependencies: this.dependencies,
    });
    if (!authorization.allowed) return authorization;
    if (typeof this.mutationHandler !== "function") {
      return { allowed: false, reason: "MUTATION_HANDLER_UNAVAILABLE" };
    }
    return { ...authorization, result: await this.mutationHandler({ mutation, payload }) };
  }
}
