/**
 * A {@link SessionForkReceiptStore} on the kernel's state port: the one durable home of a fork receipt, keyed
 * daemon-globally by the plan-derived `(sourceSessionId, requestId)` identity, never under or through the source
 * session. One receipt is one document, `state/ferrets/forks/<planId>.json` (the contract's `ForkFiles`).
 *
 * THE CLAIM IS A REAL COMPARE-AND-SET, not a read-then-write. Two daemon-side attempts that both found no receipt must
 * not both mint a target, and the state port's `update` is the primitive that promises it: it reads and writes inside
 * one serialization chain per file, and a function that answers the very `current` it was handed DECLINES, writing
 * nothing. So `claim` answers `current` when a receipt is already there and the new receipt when there is none: exactly
 * one attempt wins the pair, and every other is answered with the document that won. The loser ADOPTS the winner's
 * target and plan rather than creating a second session, and the orchestration decides whether the winner's payload
 * matches.
 *
 * DURABILITY IS THE KERNEL'S. Atomic replacement, the fsync of the bytes and of the containing directory, the private
 * mode and the repair of a name a power loss could have rolled back are the state port's rules for every document it
 * writes, so none of them is restated or re-implemented here. What this store keeps is only what is the receipt's own:
 * the key, the monotonic phase, and the refusal of a document that is not this pair's.
 *
 * THE ADVANCE IS MONOTONIC AND NEVER OVERWRITES A MISMATCH. A receipt comes off disk as untrusted input, so `advance`
 * re-parses the holder before it writes: a corrupt or unknown-version document is refused (the state port reports it as
 * damaged), a document for a different decision (the full-decision `fingerprint` no longer matches) is refused outright
 * and the frozen receipt is left intact, and a phase that would move backwards is refused. A replay of an advance that
 * already landed finds the boundary already crossed and DECLINES, leaving the receipt untouched rather than rewriting it.
 *
 * SOURCE IMMUTABILITY HOLDS BY CONSTRUCTION: the only document this store ever names is the daemon-global
 * `forks/<planId>` one, derived from the composite key. No source session directory is named, so none can be touched —
 * source decisions were derived once in preparation and frozen into the receipt before this store is ever asked to claim
 * it. Import's later validation-only source re-read is outside this write-capable store.
 *
 * ONE KEY, ONE CHAIN. The state port serializes each document, so even a read-verify-write `advance` cannot interleave
 * with another on the same key; the fork service's `SessionForkSerial` still keys a whole fork on the composite so that
 * two attempts do not re-run a boundary between their reads. Distinct keys address distinct documents, which is all a
 * fan-out of forks needs.
 */

import type { StateDamage, StatePort } from '@ferretry/kernel/contract';
import { ForkFiles } from '../../../contract/index.ts';
import { SessionForkPhaseRegressionError, SessionForkReceiptInvalidError } from '../../lib/forks/failures.ts';
import type { SessionForkKey } from '../../lib/forks/identity.ts';
import { parseSessionForkReceipt, type SessionForkReceipt, sessionForkPhaseRank } from '../../lib/forks/receipt.ts';
import type { SessionForkReceiptStore } from '../../lib/forks/types.ts';
import { deriveTransferPlanId } from '../../lib/transfer/prepare.ts';

/**
 * The daemon-global plan-id name of one receipt: one document per `(sourceSessionId, requestId)`, never under a session
 * directory. The plan id is the single owner of the composite identity, so the name is derived from it rather than
 * invented here.
 */
export function forkReceiptName(key: SessionForkKey): string {
  return deriveTransferPlanId(key.sourceSessionId, key.requestId);
}

export class StateSessionForkReceiptStore implements SessionForkReceiptStore {
  constructor(private readonly state: StatePort) {}

  async read(key: SessionForkKey): Promise<unknown> {
    const read = await this.state.read(ForkFiles, forkReceiptName(key));
    // A document the port could not read is evidence something else happened to it: refused, never answered as
    // unclaimed, because minting over it is exactly how a retry creates a second target.
    if (!read.ok) throw unusable(key, read.error);
    return read.value;
  }

  async claim(receipt: SessionForkReceipt): Promise<unknown> {
    const key = { sourceSessionId: receipt.sourceSessionId, requestId: receipt.requestId };
    // `current` is returned as it is when a receipt already holds the pair: a decline, so the winner is never
    // overwritten. Adopt it unchanged — the store does not decide whether the payloads match; the orchestration does.
    const claimed = await this.state.update(ForkFiles, current => current ?? receipt, forkReceiptName(key));
    if (!claimed.ok) throw unusable(key, claimed.error);
    return claimed.value;
  }

  async advance(next: SessionForkReceipt): Promise<void> {
    const key = { sourceSessionId: next.sourceSessionId, requestId: next.requestId };
    const advanced = await this.state.update(
      ForkFiles,
      current => {
        if (current === undefined) {
          throw new SessionForkReceiptInvalidError(key, 'no durable receipt holds this pair, so it cannot be advanced');
        }
        // A receipt comes off disk as untrusted input: it is re-parsed, with the cross-checks the contract cannot make.
        const held = parseSessionForkReceipt(current, key);

        // The durable decision — key, caller payload, explicit target and complete parsed plan — is frozen at the
        // claim and summarized by the receipt `fingerprint`. An advance for a different decision is refused outright
        // and the frozen receipt is left intact, never overwritten.
        if (held.fingerprint !== next.fingerprint) {
          throw new SessionForkReceiptInvalidError(
            key,
            'the receipt being advanced is a different decision than the one this pair froze',
          );
        }

        const nextRank = sessionForkPhaseRank(next.phase);
        const heldRank = sessionForkPhaseRank(held.phase);
        if (nextRank < heldRank) throw new SessionForkPhaseRegressionError(held.phase, next.phase);
        // A replay of an advance that already landed does not rewrite it: answering `current` declines the write.
        if (nextRank === heldRank) return current;
        return next;
      },
      forkReceiptName(key),
    );
    if (!advanced.ok) throw unusable(key, advanced.error);
  }
}

/** A receipt the state port reported as damaged, in the fork's own refusal. */
function unusable(key: SessionForkKey, damage: StateDamage): SessionForkReceiptInvalidError {
  return new SessionForkReceiptInvalidError(key, `its document is damaged (${damage.reason}): ${damage.sentence}`);
}
