import type { StatePort } from '@ferretry/kernel/contract';
import { SessionHandoverReceiptSchema } from '../../../../contract/handover.ts';
import { HandoverFiles } from '../../../../contract/handover-state.ts';
import { handoverPlanId, isTerminalHandoverPhase } from '../../../lib/moves/handover/policy.ts';
import { SessionIdSchema } from '../../../lib/session-id.ts';
import {
  type HandoverReceipt,
  HandoverReceiptDamagedError,
  type HandoverReceiptStore,
} from '../../../lib/moves/handover/types.ts';

/** Where a session's receipt is named in an error: the declared collection path with the session in place. */
function documentOf(sourceSessionId: string): string {
  return HandoverFiles.path.replace('*', sourceSessionId);
}

/**
 * The durable handover receipt, in the predecessor's own session directory (`<id>/handover.json`, the contract's
 * {@link HandoverFiles}).
 *
 * ATOMIC, BY THE KERNEL'S STATE PORT. The document is written before every side effect it authorizes and re-read
 * after every crash, so a torn one is not an inconvenience: it is the record of an operation that may be
 * half-applied, read by the thing deciding whether to apply the rest. The port writes through a temporary file, a
 * sync and a rename, so this store carries none of that itself.
 *
 * A DAMAGED DOCUMENT REFUSES, IT NEVER READS AS EMPTY. This is the decision worth stating plainly. A
 * store that answered `null` for a file it could not parse would let a second handover begin on top
 * of a first — inviting a second replacement onto a board that already has two active roots, or
 * stopping a predecessor twice. Absence and damage are different facts and this store keeps them
 * apart: an absent document is `null`, anything the port calls damage is a throw naming the file and the reason.
 *
 * The roster scan reads every session's receipt for the same reason it is a scan rather than an
 * index: the receipts ARE the durable state, and a second index of them would be a second answer to
 * "what is still in flight" that nothing keeps honest. A directory with no receipt is not listed, and a
 * damaged one is deliberately allowed to throw — a reconciler that quietly skipped the one session
 * whose document it could not read would be a reconciler that never finishes the handover most in
 * need of finishing.
 */
export class FileHandoverReceiptStore implements HandoverReceiptStore {
  constructor(private readonly state: StatePort) {}

  /**
   * The collection name this session's receipt lives under.
   *
   * The id is PARSED, not merely non-empty. The wire schema proves a receipt's `sourceSessionId` is a
   * string with something in it, which is not a proof about a path: a damaged document naming
   * `../../other` would otherwise redirect the very next write out of its own session directory.
   */
  private name(sourceSessionId: string): string {
    const id = SessionIdSchema.safeParse(sourceSessionId);
    if (!id.success) throw new Error(`${JSON.stringify(sourceSessionId)} is not a session id this daemon owns`);
    return id.data;
  }

  async read(sourceSessionId: string): Promise<HandoverReceipt | null> {
    return await this.readDocument(this.name(sourceSessionId));
  }

  async write(receipt: HandoverReceipt): Promise<void> {
    const name = this.name(receipt.sourceSessionId);
    // Parsed on the way OUT as well as in. The receipt's own refinements — a phase history that ends
    // at the current phase, a terminal failure that names a cause — are what a reader relies on, and
    // a store that only checked them on read would let this daemon be the one that wrote the document
    // no future daemon can use.
    await this.state.write(HandoverFiles, SessionHandoverReceiptSchema.parse(receipt), name);
  }

  async pendingSourceSessionIds(): Promise<readonly string[]> {
    const pending: string[] = [];
    for (const name of await this.state.list(HandoverFiles)) {
      const receipt = await this.readDocument(name);
      if (receipt !== null && !isTerminalHandoverPhase(receipt.phase)) pending.push(receipt.sourceSessionId);
    }
    return pending;
  }

  private async readDocument(expected: string): Promise<HandoverReceipt | null> {
    const file = documentOf(expected);
    const read = await this.state.read(HandoverFiles, expected);
    if (!read.ok) throw new HandoverReceiptDamagedError(file, read.error.sentence);
    const receipt = read.value;
    if (receipt === undefined) return null;
    // BOUND TO THE DIRECTORY IT WAS FOUND IN. A receipt is addressed by its owner's session id, so one
    // naming a different session is not a receipt for this one — and following it would make the
    // roster report a handover under an id whose directory holds no record of it.
    if (receipt.sourceSessionId !== expected) {
      throw new HandoverReceiptDamagedError(
        file,
        `it names session ${receipt.sourceSessionId} while living in ${expected}'s directory`,
      );
    }
    // THE PLAN ID IS RE-DERIVED, not merely cross-checked against the plan it travels with. The wire
    // schema proves `planId` and `plan.planId` agree, which two copies of a forged value also do; the
    // id is a pure function of (source, request), so recomputing it is what proves the document
    // describes the handover it claims to and not a plan swapped in under a matching pair of names.
    const derived = handoverPlanId(receipt.sourceSessionId, receipt.requestId);
    if (receipt.planId !== derived) {
      throw new HandoverReceiptDamagedError(
        file,
        `its plan id ${receipt.planId} is not the one handover ${receipt.requestId} of ` +
          `${receipt.sourceSessionId} derives (${derived})`,
      );
    }
    return receipt;
  }
}
