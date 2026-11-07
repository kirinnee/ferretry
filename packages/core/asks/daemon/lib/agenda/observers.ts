import type { AgendaItem, ResolvedAgendaItem } from '../protocol/agenda.ts';
import {
  boardReplyMessage,
  discussMessage,
  isQuietAcknowledgement,
  needsInfoMessage,
  ownerAnswerMessage,
} from './conversation.ts';
import {
  type AgendaReplyQueue,
  type AgendaUndeliveredSink,
  itemOfKey,
  needsInfoReplyKey,
  type ReplyKey,
} from './reply-batch.ts';
import type { AgendaBoardChange, AgendaChangeObserver, AgendaService } from './service.ts';
import { isOnBehalfItem } from './state-machine.ts';

/** Every observer is told, even after a failure. Critical delivery failures prevent durable acknowledgement. */
export class AgendaChangeFanout implements AgendaChangeObserver {
  readonly requiresAcceptance = true;

  constructor(private readonly observers: readonly AgendaChangeObserver[]) {}

  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    const failures: unknown[] = [];
    for (const observer of this.observers) {
      try {
        await observer.changed(sessionId, change);
      } catch (error) {
        if (observer.requiresAcceptance === true) failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'agenda reply delivery was not durably accepted');
  }
}

/**
 * Whether an item speaks for the ferret whose board holds it: one it raised, or a gate's follow-up conversation the
 * daemon opened on its behalf (`gate-followup:`, `card-agenda:`), so the owner's words there reach it as on its own item.
 */
const speaksFor = (item: AgendaItem | ResolvedAgendaItem, sessionId: string): boolean =>
  (item.raisedBy === 'agent' && item.raisedBySession === sessionId) || isOnBehalfItem(item);

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
  readonly requiresAcceptance = true;

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
    // An answer that RESTED the item (it stays open, waiting on the ferret) is told under its own request key, so a
    // second answer after the ferret replied is told too.
    if (change.change === 'answered' && change.via === 'board' && change.actor.kind === 'human' && item !== undefined) {
      const message = ownerAnswerMessage(item);
      if (!speaksFor(item, sessionId) || message === undefined || item.ownerAnswer === undefined) return;
      await this.replies.add(sessionId, needsInfoReplyKey(item.id, item.ownerAnswer.request), message);
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
