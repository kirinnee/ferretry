/**
 * GATE-PRIVATE: which standings an owner-only act has already CLAIMED the fresh proof for. Not re-exported by
 * `contract/index.ts` and not in the package's `exports`, so no other package can mark or read it — only
 * `owner-only.ts` (the marker) and Gate's config judge (the reader).
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
