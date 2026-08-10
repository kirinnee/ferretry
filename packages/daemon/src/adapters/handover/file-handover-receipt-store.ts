import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionHandoverReceiptSchema } from '@ferretry/protocol';
import { handoverPlanId, isTerminalHandoverPhase } from '../../lib/handover/policy.ts';
import { SessionIdSchema } from '../../lib/session-id.ts';
import {
  type HandoverReceipt,
  HandoverReceiptDamagedError,
  type HandoverReceiptStore,
} from '../../lib/handover/types.ts';

/** One receipt per session, owned by the PREDECESSOR — the party that exists in every phase. */
const RECEIPT_FILE = 'handover.json';

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The durable handover receipt, in the predecessor's own session directory.
 *
 * ATOMIC, THROUGH A TEMPORARY FILE AND A RENAME. The document is written before every side effect it
 * authorizes and re-read after every crash, so a torn one is not an inconvenience: it is the record
 * of an operation that may be half-applied, read by the thing deciding whether to apply the rest.
 *
 * A DAMAGED DOCUMENT REFUSES, IT NEVER READS AS EMPTY. This is the decision worth stating plainly. A
 * store that answered `null` for a file it could not parse would let a second handover begin on top
 * of a first — inviting a second replacement onto a board that already has two active roots, or
 * stopping a predecessor twice. Absence and damage are different facts and this store keeps them
 * apart: `ENOENT` is `null`, anything else is a throw naming the file and the reason.
 *
 * The roster scan reads every session's receipt for the same reason it is a scan rather than an
 * index: the receipts ARE the durable state, and a second index of them would be a second answer to
 * "what is still in flight" that nothing keeps honest. A directory with no receipt is skipped, and a
 * damaged one is deliberately allowed to throw — a reconciler that quietly skipped the one session
 * whose document it could not read would be a reconciler that never finishes the handover most in
 * need of finishing.
 */
export class FileHandoverReceiptStore implements HandoverReceiptStore {
  constructor(
    private readonly sessionsDirectory: string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  /**
   * Where this session's receipt lives.
   *
   * The id is PARSED, not merely non-empty. The wire schema proves a receipt's `sourceSessionId` is a
   * string with something in it, which is not a proof about a path: a damaged document naming
   * `../../other` would otherwise redirect the very next write out of its own session directory.
   */
  file(sourceSessionId: string): string {
    const id = SessionIdSchema.safeParse(sourceSessionId);
    if (!id.success) throw new Error(`${JSON.stringify(sourceSessionId)} is not a session id this daemon owns`);
    return join(this.sessionsDirectory, id.data, RECEIPT_FILE);
  }

  async read(sourceSessionId: string): Promise<HandoverReceipt | null> {
    return await this.readFile(this.file(sourceSessionId), sourceSessionId);
  }

  async write(receipt: HandoverReceipt): Promise<void> {
    const file = this.file(receipt.sourceSessionId);
    // Parsed on the way OUT as well as in. The receipt's own refinements — a phase history that ends
    // at the current phase, a terminal failure that names a cause — are what a reader relies on, and
    // a store that only checked them on read would let this daemon be the one that wrote the document
    // no future daemon can use.
    const document = JSON.stringify(SessionHandoverReceiptSchema.parse(receipt), null, 2);
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    await writeFile(temporary, `${document}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }

  async pendingSourceSessionIds(): Promise<readonly string[]> {
    const entries = await readdir(this.sessionsDirectory, { withFileTypes: true }).catch(error => {
      if (missing(error)) return [];
      throw error;
    });
    const pending: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const receipt = await this.readFile(join(this.sessionsDirectory, entry.name, RECEIPT_FILE), entry.name);
      if (receipt !== null && !isTerminalHandoverPhase(receipt.phase)) pending.push(receipt.sourceSessionId);
    }
    return pending;
  }

  private async readFile(file: string, expected: string): Promise<HandoverReceipt | null> {
    const raw = await readFile(file, 'utf8').catch(error => {
      if (missing(error)) return null;
      throw new HandoverReceiptDamagedError(file, reason(error));
    });
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new HandoverReceiptDamagedError(file, reason(error));
    }
    const parsed = SessionHandoverReceiptSchema.safeParse(value);
    if (!parsed.success) throw new HandoverReceiptDamagedError(file, parsed.error.message);
    // BOUND TO THE DIRECTORY IT WAS FOUND IN. A receipt is addressed by its owner's session id, so one
    // naming a different session is not a receipt for this one — and following it would make the
    // roster report a handover under an id whose directory holds no record of it.
    if (parsed.data.sourceSessionId !== expected) {
      throw new HandoverReceiptDamagedError(
        file,
        `it names session ${parsed.data.sourceSessionId} while living in ${expected}'s directory`,
      );
    }
    // THE PLAN ID IS RE-DERIVED, not merely cross-checked against the plan it travels with. The wire
    // schema proves `planId` and `plan.planId` agree, which two copies of a forged value also do; the
    // id is a pure function of (source, request), so recomputing it is what proves the document
    // describes the handover it claims to and not a plan swapped in under a matching pair of names.
    const derived = handoverPlanId(parsed.data.sourceSessionId, parsed.data.requestId);
    if (parsed.data.planId !== derived) {
      throw new HandoverReceiptDamagedError(
        file,
        `its plan id ${parsed.data.planId} is not the one handover ${parsed.data.requestId} of ` +
          `${parsed.data.sourceSessionId} derives (${derived})`,
      );
    }
    return parsed.data;
  }
}
