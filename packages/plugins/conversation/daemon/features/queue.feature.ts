import {
  harnessFamily,
  type MailboxHost,
  type MailboxRefusal,
  type QueueRefusal,
  QueueRefused,
  type QueuedMessage,
  type SessionQueue,
} from '@ferretry/core-mailbox/contract';
import type { SitrepLineSource } from '@ferretry/core-ferrets/contract';
import { type Result, err, ok } from '@ferretry/std';
import { CHANNEL_WRITE_BUDGET_MS } from '../../contract/wire-channel.ts';
import {
  MessageBeforeSend,
  QUEUE_STATE,
  QUESTION_STATE,
  SENDS_STATE,
  STUCK_FRAME_STATES,
} from '../../contract/index.ts';
import type { ConversationApi } from '../../contract/index.ts';
import { channelSenderName } from '../channel/index.ts';
import { askDeliveryOf } from '../delivery/adapters/ask-delivery.ts';
import { EntriesSendEvidence, StateSendChannel, StateSendLedger } from '../delivery/adapters/index.ts';
import { sentDraftClearer } from '../drafts/lib/mounts/shared-drafts.ts';
import { StateQueueStore } from '../queue/adapters/index.ts';
import { tryParseSessionId } from '../seams/ferret-id.ts';
import { OwnerWordsReader } from '../turns/lib/index.ts';
import { SessionOwnerChat } from '../turns/lib/owner-chat.ts';
import { parseSessionId } from '../seams/ferret-id.ts';
import { built, type ConversationFeature } from './types.ts';

/**
 * What the owner says to a ferret and what happens to it: the queue (the Mailbox owns it, so every read and change goes
 * through its port), the send ledger and the Claude channel's files, the port's send, queue and composer members, the
 * owner's words as `fy agenda log` copies them, the sitrep lines, and the slot the Mailbox keeps its files through
 * (`mailbox.host`: the queue log and send ledger stay in this plugin's folder).
 */
export default {
  id: 'queue',
  register: f => {
    const { kernel, ferrets, mailbox, hooks, gate, clock } = f;
    const queueStore = new StateQueueStore(kernel.state, undefined, failure =>
      kernel.log.warn('the queue log could not be rotated; it keeps growing until a rotation succeeds', {
        ferret: failure.ferret,
        events: failure.events,
        bytes: failure.bytes,
        error: String(failure.error),
      }),
    );
    /** The queue as this half reads it: the Mailbox owns it (its one writer), so every read and change goes through its port. */
    const queued = (outcome: Result<QueuedMessage, MailboxRefusal>): QueuedMessage => {
      if (outcome.ok) return outcome.value;
      throw new QueueRefused(outcome.error.code as QueueRefusal, outcome.error.message);
    };
    const queue: Pick<SessionQueue, 'list' | 'edit' | 'cancel'> = {
      list: async id => (await mailbox.queue(id)).messages,
      edit: async (id, messageId, text) => queued(await mailbox.editQueued(id, messageId, { text })),
      cancel: async (id, messageId) => queued(await mailbox.cancelQueued(id, messageId)),
    };
    const ledger = new StateSendLedger(kernel.state, clock);
    const channel = new StateSendChannel(kernel.state);

    const turnsOf = async (ferret: ReturnType<typeof parseSessionId>) =>
      await ferrets.turns?.(ferret).catch(() => undefined);
    /** What the owner said to a ferret: the queue, the send ledger and its turn documents (Ferrets reads them back). */
    const ownerWords = new OwnerWordsReader({
      queue,
      sends: ledger,
      turns: { list: async (id, options) => (await (await turnsOf(id))?.list(options)) ?? [] },
      // An unknown ferret (one the registry has since removed) was not started by a ferret, as today's parent lookup answers.
      startedByFerret: async id => (await ferrets.get(id))?.parent !== undefined,
    });

    const api: Pick<
      ConversationApi,
      | 'send'
      | 'ownerWords'
      | 'interrupt'
      | 'queue'
      | 'editQueued'
      | 'cancelQueued'
      | 'sends'
      | 'sendRecord'
      | 'retrySend'
      | 'cancelSend'
      | 'enterSend'
      | 'composer'
      | 'resubmitStuck'
      | 'retractedDraft'
    > = {
      send: async (ferret, caller, request) => await mailbox.send(ferret, caller, request),
      ownerWords: async (ferret, options) => {
        try {
          return ok({ v: 1, ferret, words: await ownerWords.said(ferret, { strict: options?.strict === true }) });
        } catch (error) {
          return err({ code: 'unreadable', message: error instanceof Error ? error.message : String(error) });
        }
      },
      interrupt: async (ferret, request) => await mailbox.interrupt(ferret, request),
      queue: async ferret => await mailbox.queue(ferret),
      editQueued: async (ferret, message, request) => await mailbox.editQueued(ferret, message, request),
      cancelQueued: async (ferret, message) => await mailbox.cancelQueued(ferret, message),
      sends: async (ferret, cursor) => await mailbox.sends(ferret, cursor),
      sendRecord: async (ferret, sendId) => await mailbox.sendRecord(ferret, sendId),
      retrySend: async (ferret, sendId, force) => await mailbox.retrySend(ferret, sendId, force),
      cancelSend: async (ferret, sendId) => await mailbox.cancelSend(ferret, sendId),
      enterSend: async (ferret, sendId) => await mailbox.enterSend(ferret, sendId),
      resubmitStuck: async (ferret, caller, sendId) =>
        (await mailbox.resubmitStuck?.(ferret, caller, sendId)) ??
        err({ code: 'unavailable', message: 'the Mailbox cannot re-submit a stuck send' }),
      retractedDraft: async ferret => await mailbox.retractedDraft?.(ferret),
      composer: async (ferret, action, draft) => await mailbox.composer(ferret, action, draft),
    };

    const sitrep: SitrepLineSource = {
      async lines(ferret) {
        const lines = [];
        const waiting = (await queue.list(ferret)).filter(
          (message: QueuedMessage) => message.state === 'queued' || message.state === 'typing',
        ).length;
        if (waiting > 0)
          lines.push({
            kind: 'turn' as const,
            text: waiting === 1 ? '1 message is waiting to be typed' : `${waiting} messages are waiting to be typed`,
          });
        const question = await kernel.state.read(QUESTION_STATE, ferret);
        if (question.ok && question.value !== undefined)
          lines.push({ kind: 'turn' as const, text: `Waiting on your answer: ${question.value.text}` });
        return lines;
      },
    };

    return {
      port: api,
      hooks: () => {
        const channelOutbox = built(f.late.channelOutbox, 'channel outbox');
        /** What the Mailbox needs of the files and terminals this plugin keeps (it never opens them itself). */
        const mailboxHost: MailboxHost = {
          claudeChannel: {
            connected: ferret => channelOutbox.connected(ferret),
            push: (ferret, message) => {
              channelOutbox.push(ferret, message);
            },
            claimedAt: (ferret, sendId) => channelOutbox.claimedAt(ferret, sendId),
            withdraw: (ferret, sendId) => channelOutbox.withdraw(ferret, sendId),
            markBroken: ferret => {
              channelOutbox.markBroken(ferret);
            },
            received: (ferret, sendId) => {
              channelOutbox.received(ferret, sendId);
            },
            broken: ferret => channelOutbox.broken(ferret),
            bootedAt: channelOutbox.bootedAt,
            writeBudgetMs: CHANNEL_WRITE_BUDGET_MS,
            senderName: channelSenderName,
          },
          queue: queueStore,
          ledger,
          channel,
          gate,
          boundaries: built(f.late.boundaries, 'turn boundaries'),
          askedQuestion: async ferret => await built(f.late.askedQuestion, 'question reader')(ferret),
          transformMessage: async input => await hooks.transform(MessageBeforeSend, input),
          evidence: new EntriesSendEvidence(async ferret => {
            const id = tryParseSessionId(ferret);
            const summary = id === undefined ? undefined : await ferrets.get(id);
            const harness = id === undefined ? undefined : await ferrets.harness?.(id);
            const family = summary === undefined ? undefined : harnessFamily(summary.harness);
            // A harness this build does not know has no transcript reading: unreadable, so nothing is typed again on a guess.
            return family === undefined || harness === undefined
              ? undefined
              : { harness: family, reader: harness.transcript };
          }),
          keepFrame: async (ferret, frame) => {
            const [newest, middle, oldest] = STUCK_FRAME_STATES;
            for (const [from, to] of [
              [middle, oldest],
              [newest, middle],
            ] as const) {
              const kept = await kernel.state.read(from, ferret);
              if (kept.ok && kept.value !== undefined) await kernel.state.write(to, kept.value, ferret);
            }
            await kernel.state.write(newest, new TextEncoder().encode(frame), ferret);
            return kernel.state.pathOf(newest, ferret);
          },
          stamp: async (log, ferret) =>
            (await kernel.state.version(log === 'sends' ? SENDS_STATE : QUEUE_STATE, ferret))?.etag ?? 'absent',
          // The stored originals a send hands to the agent (the reading feature owns the store).
          attachments: { download: (ferret, id) => built(f.late.reading, 'reading half').download(ferret, id) },
          clearSentDraft: sentDraftClearer(built(f.late.drafts, 'shared draft')),
        };
        return {
          'ask.delivery:ferret': askDeliveryOf(api),
          // The owner's messages to a ferret as `fy agenda log` copies them: the queue and the send ledger, by message id.
          'ask.owner-chat:conversation': new SessionOwnerChat(queue, ledger),
          // Where the Mailbox keeps a ferret's queue and send ledger: the files stay in this plugin's folder.
          'mailbox.host:ferret': mailboxHost,
          'sitrep.lines': () => [{ id: 'conversation', item: sitrep }],
        };
      },
    };
  },
} satisfies ConversationFeature;
