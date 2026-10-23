import type { SessionAttentionSummary } from '@ferretry/protocol';
import type { SerialExecutor } from '../ports.ts';
import { boardReplyMessage, conversationResponse, conversationTurn, sessionAttentionSummary } from './conversation.ts';
import type {
  AttentionBoardChange,
  AttentionChangeObserver,
  AttentionLedgerRepository,
  AttentionService,
} from './service.ts';
import { attentionSnapshot, emptyAttentionLedger } from './state-machine.ts';

/** Every observer told, in order, each on its own: one that throws never silences the next. */
export class AttentionChangeFanout implements AttentionChangeObserver {
  constructor(private readonly observers: readonly AttentionChangeObserver[]) {}

  async changed(sessionId: string, change: AttentionBoardChange): Promise<void> {
    for (const observer of this.observers) await observer.changed(sessionId, change).catch(() => undefined);
  }
}

/** Where a session's open-Attention summary is kept: its state document, which the list reads. */
export interface SessionAttentionState {
  /**
   * Writes the summary (removing it for `undefined`) and journals that the board moved. Without a
   * `change` — a reconciliation — it writes and journals only when the stored summary was wrong.
   */
  write(
    sessionId: string,
    summary: SessionAttentionSummary | undefined,
    change: AttentionBoardChange | undefined,
  ): Promise<void>;
}

/**
 * Keeps each session's `state.attention` true to its board, so a list row reads as unread exactly while
 * something waits on the owner.
 *
 * THE BOARD IS RE-READ, not the snapshot the change carried: two mutations on one board commit in
 * order, but their observers may run out of order, and writing the earlier snapshot last would show an
 * answered item as still open. Re-reading under one lock per session makes the last write the current
 * board, whatever order the notices arrive in.
 */
export class SessionAttentionProjection implements AttentionChangeObserver {
  constructor(
    private readonly boards: Pick<AttentionLedgerRepository, 'read'>,
    private readonly state: SessionAttentionState,
    private readonly serial: Pick<SerialExecutor, 'run'>,
    private readonly now: () => string,
  ) {}

  async changed(sessionId: string, change: AttentionBoardChange): Promise<void> {
    await this.project(sessionId, change);
  }

  /**
   * Brings every named session's summary in line with its board, one at a time: for boards that
   * changed before this daemon kept summaries, or while it was down. Each session on its own — one
   * unreadable board leaves the rest reconciled.
   */
  async reconcile(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) await this.project(sessionId, undefined).catch(() => undefined);
  }

  private async project(sessionId: string, change: AttentionBoardChange | undefined): Promise<void> {
    await this.serial.run(`attention-projection:${sessionId}`, async () => {
      const ledger = (await this.boards.read(sessionId)) ?? emptyAttentionLedger(sessionId, this.now());
      await this.state.write(sessionId, sessionAttentionSummary(attentionSnapshot(ledger)), change);
    });
  }
}

/** A queued, non-interrupting message to a ferret, idempotent under its send id. */
export interface AttentionMessenger {
  send(sessionId: string, message: string, sendId: string): Promise<void>;
}

/**
 * Tells a ferret the owner's answer to an item IT raised, as an ordinary message naming the item.
 *
 * Only the owner's own closing of an agent-raised item on the board is told: an answer given in the
 * conversation already reached the ferret in the owner's words, the ferret's own `done` needs no echo,
 * and the warden's or a source's reconciliation is not an answer. The send id is the item's, so a
 * notice delivered twice is one message.
 */
export class AttentionReplyDelivery implements AttentionChangeObserver {
  constructor(private readonly messenger: AttentionMessenger) {}

  async changed(sessionId: string, change: AttentionBoardChange): Promise<void> {
    const { addressed } = change;
    if (change.via !== 'board' || change.actor.kind !== 'human' || addressed === undefined) return;
    if (addressed.raisedBy !== 'agent' || addressed.raisedBySession !== sessionId) return;
    const message = boardReplyMessage(addressed);
    if (message === null) return;
    await this.messenger.send(sessionId, message, `attention-${sessionId}-${addressed.id}`);
  }
}

/**
 * A person's chat message, read against the ferret's open items (`conversationTurn`): the words to
 * deliver, and — once they are accepted — the items they answered resolved in the owner's name.
 *
 * Total on the way in: a board that cannot be read leaves the message exactly as written, because a
 * person's words must never be refused for the sake of a decoration.
 */
export class AttentionConversation {
  constructor(
    private readonly attention: Pick<AttentionService, 'list' | 'answer' | 'resolve'>,
    private readonly binary: string,
  ) {}

  async prepare(sessionId: string, message: string): Promise<ReturnType<typeof conversationTurn>> {
    const listed = await this.attention.list(sessionId).catch(() => undefined);
    if (listed === undefined || !listed.ok) return { message, answers: [] };
    return conversationTurn(message, listed.value.items, this.binary);
  }

  /** Resolves every item the accepted message answered; each on its own, none able to fail the send. */
  async settle(sessionId: string, turn: ReturnType<typeof conversationTurn>, original: string): Promise<void> {
    for (const item of turn.answers) {
      const response = conversationResponse(item, original);
      const note = original.trim().slice(0, 2_048);
      await (
        response === undefined
          ? this.attention.resolve(sessionId, item.id, { kind: 'human' }, note, 'conversation')
          : this.attention.answer(sessionId, item.id, response, { kind: 'human' }, null, 'conversation')
      ).catch(() => undefined);
    }
  }
}
