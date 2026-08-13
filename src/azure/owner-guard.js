export class OwnerGuard {
  isHeld() {
    return false;
  }
}

export class RecoveryState {
  #state = "RECOVERING";

  get state() {
    return this.#state;
  }

  isReady() {
    return this.#state === "READY";
  }

  markReady() {
    this.#state = "READY";
  }

  markRecovering() {
    this.#state = "RECOVERING";
  }
}
