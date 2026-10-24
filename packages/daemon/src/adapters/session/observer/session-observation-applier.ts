import { SessionStateSchema } from '@ferretry/protocol';
import {
  type AnswerLedger,
  isTurnStatus,
  type ObserverPatch,
  type QuestionPatch,
  questionDocumentPatch,
  questionReceipts,
  type SerialExecutor,
  type SessionId,
  type TurnStateChange,
} from '../../../lib/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

/** The storage writes a patch is applied through: the same locked path every other writer takes. */
export type ObservationStorage = Pick<DaemonStorage, 'updateState' | 'append'>;

/**
 * Records one turn change: a compare-and-set on `from` under the session's own lock, then the journal
 * line that wakes every open page. Answers whether anything was written.
 *
 * The status is re-read under the lock: a stop that committed after the look has the last word, so a
 * session that is no longer live is never given a turn again (a clear is still recorded).
 */
export async function recordTurnChange(
  storage: ObservationStorage,
  id: SessionId,
  change: TurnStateChange,
  at: string,
): Promise<boolean> {
  let written = false;
  await storage.updateState(id, raw => {
    const current = SessionStateSchema.safeParse(raw);
    if (!current.success || current.data.turnState !== change.from) return raw;
    // Re-read under the lock: a stop that committed after the watcher looked has the last word.
    if (change.to !== undefined && !isTurnStatus(current.data.status)) return raw;
    const next: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    if (change.to === undefined) {
      delete next.turnState;
      delete next.turnStateAt;
    } else if (change.to !== change.from) {
      // Only a CHANGED turn moves the boundary: a new dialog on the same `needs-input` is not one.
      next.turnState = change.to;
      next.turnStateAt = at;
    }
    if (change.prompt === undefined) delete next.turnPrompt;
    else next.turnPrompt = change.prompt;
    if (change.request === undefined) delete next.permissionRequest;
    else next.permissionRequest = change.request;
    if (change.dialog === undefined) delete next.harnessDialog;
    else next.harnessDialog = change.dialog;
    written = true;
    return next as typeof raw;
  });
  if (!written) return false;
  // Journaled, so the event stream wakes every open page at once rather than on its next poll.
  // A new dialog on the same 'needs-input' is its own event: 'turn.state' is a turn boundary, and
  // what reacts to one (the Warden, a notification) must not fire twice for the same boundary.
  await storage.append(id, change.to === change.from ? 'turn.prompt' : 'turn.state', {
    from: change.from ?? null,
    to: change.to ?? null,
    prompt: change.prompt ?? null,
    // The request itself rides the feed, so a page shows the approval card from the event alone.
    permissionRequest: change.request ?? null,
    harnessDialog: change.dialog ?? null,
  });
  return true;
}

/**
 * THE ONE WRITER OF WHAT A SESSION OBSERVER DERIVES.
 *
 * An observer — on this thread or, from stage 3b, on a session worker — holds no storage and writes no
 * file; it answers patches. This applies them through `DaemonStorage`, so the session lock, the index
 * row, the journal and its in-process listeners (the Warden's triggers, `/v1/events`) are exactly the
 * ones every other writer goes through (`docs/design/session-workers.md` §2.4).
 *
 * ONE SESSION'S PATCHES ARE APPLIED ONE AT A TIME, in the order they are handed in, on this applier's
 * own per-session lane — so a question patch handed in before a turn patch lands before it (#689). The
 * lane is the applier's alone: nothing it calls re-enters it, and storage keeps its own lower lane.
 *
 * A QUESTION PATCH IS APPLIED UNDER THE SESSION'S ANSWER KEY, which every caller holds (`runIfIdle`): no
 * answer drive and no other writer of the answer ledger runs meanwhile, so the ledger this reads is the
 * ledger it appends to — the same read-modify-write argument `FileAnswerLedger` makes for the coordinator.
 */
export class SessionObservationApplier {
  constructor(
    private readonly storage: ObservationStorage,
    private readonly answers: Pick<AnswerLedger, 'all' | 'append'>,
    private readonly serial: SerialExecutor,
  ) {}

  /** Applies one patch; answers whether the state document was written. */
  async apply(id: SessionId, patch: ObserverPatch, at: string): Promise<boolean> {
    return await this.serial.run(id, async () =>
      patch.kind === 'turn'
        ? await recordTurnChange(this.storage, id, patch.change, at)
        : await this.question(id, patch),
    );
  }

  /**
   * The receipts reconciliation settled are appended first — only those the ledger, read now, still owes:
   * a worker's look can be one append behind an answer drive that has since settled the same receipt
   * itself ({@link questionReceipts}). Then, when the look implied a change, the state patch is
   * RE-DECIDED against the document under the lock, from the receipts as they now stand — a lifecycle
   * stop that committed after the look must not have its `kill_failed` resurrected as `awaiting_question`.
   */
  private async question(id: SessionId, patch: QuestionPatch): Promise<boolean> {
    const receipts = questionReceipts(patch, await this.answers.all(id));
    for (const settlement of receipts.settlements) await this.answers.append(id, settlement);
    if (!patch.writes) return false;
    const decidedFrom = { ...patch, records: receipts.records };
    let written = false;
    await this.storage.updateState(id, raw => {
      const verified = SessionStateSchema.safeParse(raw);
      if (!verified.success) return raw;
      const decided = questionDocumentPatch(verified.data, decidedFrom);
      if (decided === undefined) return raw;
      const next: Record<string, unknown> = { ...(raw as Record<string, unknown>), ...decided.fields };
      for (const field of decided.removals) delete next[field];
      written = true;
      return next as typeof raw;
    });
    return written;
  }
}
