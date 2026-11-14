/**
 * Whether anything of the OWNER's is open on one ferret — what the Warden asks before it moves the ferret, because a
 * move kills its pane and relaunches it (`WardenOwnerHoldPorts`): an input card the owner has not answered (Vault), a
 * sign-in waiting for their phone, a plan card waiting for their answer, or a secret the ferret copied, which lives in
 * this daemon's memory with its pane.
 *
 * ONE yes or no. No card, field, account, approval id or value crosses it: the Warden is told only that a move would
 * throw something away, never what. FAILS CLOSED: a read that cannot be made, or that throws, is a hold.
 *
 * Pure but for its reads.
 */
export interface OwnerHoldReads {
  /** The Vault's answer; `undefined` when it offers none, which cannot be told from a yes. */
  readonly inputCardOpen: (ferret: string) => boolean | undefined;
  readonly phoneApprovalOpen: (ferret: string) => boolean;
  readonly planAwaitingOwner: (ferret: string) => boolean;
  readonly heldSecrets: (ferret: string) => number;
}

export function holdsOwner(reads: OwnerHoldReads, ferret: string): boolean {
  try {
    if (reads.inputCardOpen(ferret) !== false) return true;
    return reads.phoneApprovalOpen(ferret) || reads.planAwaitingOwner(ferret) || reads.heldSecrets(ferret) > 0;
  } catch {
    return true;
  }
}
