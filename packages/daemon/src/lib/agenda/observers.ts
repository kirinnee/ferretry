import {
  type AgendaItem,
  parseGateFollowupReference,
  type ResolvedAgendaItem,
  type SessionAgendaSummary,
} from '@ferretry/protocol';
import type { SerialExecutor } from '../ports.ts';
import {
  boardReplyMessage,
  conversationTurn,
  discussMessage,
  isQuietAcknowledgement,
  needsInfoMessage,
  sessionAgendaSummary,
} from './conversation.ts';
import {
  type AgendaReplyQueue,
  type AgendaUndeliveredSink,
  itemOfKey,
  needsInfoReplyKey,
  type ReplyKey,
} from './reply-batch.ts';
import type { AgendaBoardChange, AgendaChangeObserver, AgendaLedgerRepository, AgendaService } from './service.ts';
import { agendaSnapshot, emptyAgendaLedger } from './state-machine.ts';
import { type AgendaModes, decoratedSummary, type SessionStops } from './stopped.ts';

/** Every observer told, in order, each on its own: one that throws never silences the next. */
export class AgendaChangeFanout implements AgendaChangeObserver {
  constructor(private readonly observers: readonly AgendaChangeObserver[]) {}

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    for (const observer of this.observers) await observer.changed(sessionId, change).catch(() => undefined);
  }
}

/** Where a session's open-Agenda summary is kept: its state document, which the list reads. */
export interface SessionAgendaState {
  /**
   * Writes the summary (removing it for `undefined`) and journals that the board moved. Without a
   * `change` — a reconciliation — it writes and journals only when the stored summary was wrong.
   */
  write(
    sessionId: string,
    summary: SessionAgendaSummary | undefined,
    change: AgendaBoardChange | undefined,
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
 *
 * The summary also says whether the ferret works in agenda mode and whether it is STOPPED on the owner, so
 * both are read at the same moment as the board.
 */
export class SessionAgendaProjection implements AgendaChangeObserver {
  constructor(
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly state: SessionAgendaState,
    private readonly serial: Pick<SerialExecutor, 'run'>,
    private readonly now: () => string,
    private readonly modes: AgendaModes = { enabled: async () => false },
    private readonly stops: SessionStops = { current: async () => undefined },
  ) {}

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    await this.project(sessionId, change);
  }

  /** The session's mode or idleness moved with no board change: the summary is brought in line. Total. */
  async refresh(sessionId: string): Promise<void> {
    await this.project(sessionId, undefined).catch(() => undefined);
  }

  /**
   * Brings every named session's summary in line with its board, one at a time: for boards that
   * changed before this daemon kept summaries, or while it was down. Each session on its own — one
   * unreadable board leaves the rest reconciled.
   */
  async reconcile(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) await this.project(sessionId, undefined).catch(() => undefined);
  }

  private async project(sessionId: string, change: AgendaBoardChange | undefined): Promise<void> {
    await this.serial.run(`agenda-projection:${sessionId}`, async () => {
      const ledger = (await this.boards.read(sessionId)) ?? emptyAgendaLedger(sessionId, this.now());
      const snapshot = agendaSnapshot(ledger);
      const summary = decoratedSummary(
        sessionAgendaSummary(snapshot),
        snapshot.items,
        await this.modes.enabled(sessionId).catch(() => false),
        await this.stops.current(sessionId).catch(() => undefined),
      );
      await this.state.write(sessionId, summary, change);
    });
  }
}

/**
 * Whether an item speaks for the ferret whose board holds it: one it raised, or a gate's follow-up conversation the
 * daemon opened on its behalf (`gate-followup:`), so the owner's words there reach it as on its own item.
 */
const speaksFor = (item: AgendaItem | ResolvedAgendaItem, sessionId: string): boolean =>
  (item.raisedBy === 'agent' && item.raisedBySession === sessionId) ||
  (item.raisedBy === 'daemon' && parseGateFollowupReference(item.sourceRef) !== undefined);

/**
 * Tells a ferret the owner's answer to an item IT raised, as an ordinary message naming the item.
 *
 * Every closing the owner makes on the board of an agent-raised item is told — an answer, a done or a
 * dismiss (`boardReplyMessage`), except a bare "Got it" on an info item (`isQuietAcknowledgement`) — and so is a request for more information or to discuss it, which leave
 * the item open. Nothing else is: an answer given in the conversation already reached
 * the ferret in the owner's words, the ferret's own `done` needs no echo, and the warden's or a
 * source's reconciliation is not an answer. Each goes to the ferret's outbox (`AgendaReplyBatcher`), which
 * delivers a burst of answers as one message and never the same item twice.
 */
export class AgendaReplyDelivery implements AgendaChangeObserver {
  /** `binary` names the CLI in the words a discussion tells the ferret to run. */
  constructor(
    private readonly replies: AgendaReplyQueue,
    private readonly binary: string,
  ) {}

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    const { addressed, item } = change;
    if (
      (change.change === 'needs-info' || change.change === 'discussing') &&
      change.actor.kind === 'human' &&
      item !== undefined &&
      speaksFor(item, sessionId) &&
      item.infoRequests !== undefined
    ) {
      // One counter for both: a request for information and a request to discuss are each told once.
      await this.replies.add(
        sessionId,
        needsInfoReplyKey(item.id, item.infoRequests),
        change.change === 'discussing' ? discussMessage(item, this.binary) : needsInfoMessage(item),
      );
      return;
    }
    if (change.via !== 'board' || change.actor.kind !== 'human' || addressed === undefined) return;
    if (!speaksFor(addressed, sessionId)) return;
    if (isQuietAcknowledgement(addressed)) return;
    await this.replies.add(sessionId, addressed.id, boardReplyMessage(addressed));
  }
}

/**
 * Hands an answer that never reached its ferret back to the owner: the item reopens on its board as a card
 * saying so (`AgendaService.undelivered`). A key that is about no item (the instructions note) has no
 * card to reopen. Total: a board that cannot take it is left as it is.
 */
export class AgendaBoardUndelivered implements AgendaUndeliveredSink {
  constructor(private readonly attention: Pick<AgendaService, 'undelivered'>) {}

  async undelivered(sessionId: string, key: ReplyKey, reason: string): Promise<void> {
    const id = itemOfKey(key);
    if (id === undefined) return;
    const counter = key.split('~')[1];
    const request = counter === undefined ? undefined : Number(counter);
    await this.attention.undelivered(sessionId, id, reason, request).catch(() => undefined);
  }
}

/**
 * A person's chat message, read against the ferret's open items (`conversationTurn`): the words to
 * deliver, and — once they are accepted — each item they named closed as `replied` (their words kept in its
 * history). It is no answer; the ferret reopens it if it still needs the owner.
 *
 * Total on the way in: a board that cannot be read leaves the message exactly as written, because a
 * person's words must never be refused for the sake of a decoration.
 */
export class AgendaConversation {
  constructor(private readonly agenda: Pick<AgendaService, 'list' | 'reply'>) {}

  async prepare(sessionId: string, message: string): Promise<ReturnType<typeof conversationTurn>> {
    const listed = await this.agenda.list(sessionId).catch(() => undefined);
    if (listed === undefined || !listed.ok) return { message, referenced: [] };
    return conversationTurn(message, listed.value.items);
  }

  /** Closes every item the accepted message named, `words` kept; each on its own, none able to fail the send. */
  async settle(sessionId: string, turn: ReturnType<typeof conversationTurn>, words?: string): Promise<void> {
    for (const item of turn.referenced) {
      await this.agenda.reply(sessionId, item.id, { kind: 'human' }, words).catch(() => undefined);
    }
  }
}
