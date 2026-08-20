const EXIT_MUTATIONS = new Set(["SELL", "DELIST"]);
const ALLOWED_MUTATIONS = new Set(["BUY", ...EXIT_MUTATIONS]);

export const MUTATION_REASON = Object.freeze({
  AUTHORIZED: "AUTHORIZED",
  UNKNOWN_MUTATION: "UNKNOWN_MUTATION",
  MODE_OFF: "MODE_OFF",
  OWNER_NOT_HELD: "OWNER_NOT_HELD",
  NOT_READY: "NOT_READY",
  DEPENDENCY_NOT_READY: "DEPENDENCY_NOT_READY",
});

export function authorizeMutation({ tradingMode, mutation, ownerGuard, recoveryState, dependencies = {} }) {
  if (!ALLOWED_MUTATIONS.has(mutation)) return { allowed: false, reason: MUTATION_REASON.UNKNOWN_MUTATION };
  if (tradingMode === "OFF" && !EXIT_MUTATIONS.has(mutation)) return { allowed: false, reason: MUTATION_REASON.MODE_OFF };
  if (!ownerGuard?.isHeld()) return { allowed: false, reason: MUTATION_REASON.OWNER_NOT_HELD };
  if (!recoveryState?.isReady()) return { allowed: false, reason: MUTATION_REASON.NOT_READY };
  if (Object.keys(dependencies).length === 0 || Object.values(dependencies).some((ready) => ready !== true)) {
    return { allowed: false, reason: MUTATION_REASON.DEPENDENCY_NOT_READY };
  }
  return { allowed: true, reason: MUTATION_REASON.AUTHORIZED };
}
