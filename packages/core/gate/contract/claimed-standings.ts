/**
 * GATE-PRIVATE: which standings an owner-only act has already CLAIMED the fresh proof for. Not re-exported by
 * `contract/index.ts` and not in the package's `exports`, so no other package can mark or read it — only
 * `owner-only.ts` and `loosening-act.ts` (the markers) and Gate's config judge (the reader).
 *
 * The key is the standing's `claimFreshStepUp` function, not the standing or the `CallContext`: the kernel builds a
 * call as a COPY of the standing (`{ request, params, ...standing }`), so the two objects differ while the claim
 * function is the one shared reference, and Gate mints a new one for every admission.
 */
const claimed = new WeakSet<object>();

/** Records that the standing owning `claim` has had its fresh proof taken by an owner-only act on this request. */
export function markProofClaimed(claim: object): void {
  claimed.add(claim);
}

/** Whether the standing owning `claim` already took its fresh proof, so a second claim on it would spend another. */
export function proofClaimed(claim: object | undefined): boolean {
  return claim !== undefined && claimed.has(claim);
}

/**
 * The standings whose request is, right now, ONE loosening act (`loosening-act.ts`): their proof was claimed for the
 * whole act, so every loosening the act writes rides on it until the act ends. Same key as {@link claimed}.
 */
const covering = new WeakSet<object>();

/**
 * Opens the act of the standing owning `claim` (its proof already claimed, and marked so); answers the close. Closing
 * also drops the claimed mark, so nothing rides on the act's proof once it ended: a later loosening on the same
 * standing asks the registry again and finds the proof used.
 */
export function coverAct(claim: object): () => void {
  covering.add(claim);
  return () => {
    covering.delete(claim);
    claimed.delete(claim);
  };
}

/** Whether the standing owning `claim` is inside an open loosening act whose proof covers each loosening it writes. */
export function actCovers(claim: object | undefined): boolean {
  return claim !== undefined && covering.has(claim);
}
