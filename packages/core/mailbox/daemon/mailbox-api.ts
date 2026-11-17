import { err, ok } from '@ferretry/std';
import { ApiError, type KernelPorts } from '@ferretry/kernel/contract';
import { AGENT_ORIGIN, type LaunchOrigin, PERSON_ORIGIN } from '@ferretry/core-ferrets/contract';
import {
  type MailboxApi,
  type MailboxCaller,
  parseSessionId,
  sendRecordFor,
  sendRecordView,
  type SendLedger,
  type SessionQueue,
  type SentDraftClearer,
} from '../contract/index.ts';
import type { MountRoute } from './lib/api.ts';
import { messageWithAttachments } from './lib/attachments-delivery.ts';
import { sessionSendRoutes, SessionSendError } from './lib/delivery/mounts/session-send.ts';
import { SendsPager } from './lib/delivery/sends-pager.ts';
import { actRefusal, buildSendHalf, refusalCode, sendActRefusal, type UnwiredSend } from './send-half.ts';

/** What the send half hands over, and the queue it and the routes read: everything the port and the routes need. */
export interface MailboxParts {
  readonly kernel: KernelPorts;
  readonly send: ReturnType<typeof buildSendHalf>;
  readonly queue: Pick<SessionQueue, 'list' | 'edit' | 'cancel'>;
  readonly ledger: SendLedger;
}

/**
 * Who a send on the PORT is for: the owner is a person; a ferret, and the Warden speaking, are agents (the Warden has no
 * ferret behind it). The caller the kernel bound the port to is the only source: a request field names nothing here.
 */
const originOfCaller = (caller: MailboxCaller): LaunchOrigin =>
  caller.kind === 'owner'
    ? PERSON_ORIGIN
    : caller.kind === 'ferret'
      ? { kind: 'agent', ferret: caller.ferret }
      : AGENT_ORIGIN;

/** The send half of the Mailbox's port: every act on a message that is not the queue's own. */
export function sendApi({
  kernel,
  send,
  queue,
  ledger,
}: MailboxParts): Omit<MailboxApi, 'queue' | 'editQueued' | 'cancelQueued'> {
  const { prepared, sendActs, interruptFerret, mayGo, deliverAttachments, submit, keptSend, records, lookFirst } = send;
  const { deliverer } = send;
  return {
    send: async (ferret, caller, request) => {
      try {
        const kept = await keptSend(ferret, request.sendId);
        if (kept !== undefined) return ok(kept);
        // Asked before an id is minted or the text is prepared: a refused send runs no transform and spends nothing.
        mayGo(request);
        const delivered = await deliverAttachments(ferret, request.attachmentIds);
        return ok(
          await submit(ferret, {
            sendId: request.sendId ?? String(kernel.ids.mint('send')),
            message: messageWithAttachments(await prepared(ferret, request.message), delivered),
            ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
            ...(request.label === undefined ? {} : { label: request.label }),
            ...(request.now === undefined ? {} : { now: request.now }),
            ...(request.replyExpected === undefined ? {} : { replyExpected: request.replyExpected }),
            // Who the send is for follows the caller the port was given: the owner is a person; a ferret and the Warden are agents.
            origin: originOfCaller(caller),
            // The route and the port follow one rule: a ferret is the message's SENDER, never a different target's rule.
            ...(caller.kind === 'ferret' ? { senderSessionId: caller.ferret } : {}),
            ...(caller.kind === 'warden' ? { warden: true as const } : {}),
            ...(caller.kind === 'agenda' ? { agenda: true as const } : {}),
          }),
        );
      } catch (error) {
        // An unconfirmed send names its id in the words: the refusal has no field for it, and a caller that let the id
        // be minted could not otherwise ask about, or avoid repeating, exactly that send.
        const unconfirmed =
          error instanceof SessionSendError && error.failure === 'unconfirmed' && error.sendId !== undefined
            ? ` (send ${error.sendId})`
            : '';
        return err({
          code: refusalCode(error),
          message: `${error instanceof Error ? error.message : String(error)}${unconfirmed}`,
        });
      }
    },
    interrupt: async (ferret, request) => {
      try {
        // As the route refuses it: a plain turn-stop answered `ok` would report an abandon that never happened.
        if (request.toolUseId !== undefined)
          throw new ApiError(
            501,
            `abandoning structured question ${request.toolUseId} is not served: a plain stop cannot tell the question you named from one that appeared afterwards`,
            'question_abandon_unsupported',
          );
        await interruptFerret(ferret);
        return ok(undefined);
      } catch (error) {
        return err({ code: refusalCode(error), message: error instanceof Error ? error.message : String(error) });
      }
    },
    sends: async ferret => ({ sends: [...(await records(ferret))] }),
    sendRecord: async (ferret, sendId) => {
      await lookFirst(ferret);
      return sendRecordFor(await ledger.list(ferret), await queue.list(ferret), sendId);
    },
    retrySend: async (ferret, sendId, force) => {
      try {
        return ok(
          sendRecordView(
            await sendActs.reattempt(ferret, sendId, { by: 'person', force: force === true }).catch(sendActRefusal),
          ),
        );
      } catch (error) {
        return err(actRefusal(error));
      }
    },
    cancelSend: async (ferret, sendId) => {
      try {
        return ok(sendRecordView(await sendActs.cancel(ferret, sendId).catch(sendActRefusal)));
      } catch (error) {
        return err(actRefusal(error));
      }
    },
    enterSend: async (ferret, sendId) => {
      try {
        return ok(sendRecordView(await sendActs.submit(ferret, sendId).catch(sendActRefusal)));
      } catch (error) {
        return err(actRefusal(error));
      }
    },
    resubmitStuck: async (ferret, caller, sendId) => {
      // Only the Warden presses a stuck send's Enter: nobody else is the daemon, and a ferret or the owner has the
      // ordinary send, cancel and Enter above. Checked before a pane is read.
      if (caller.kind !== 'warden')
        return err({ code: 'forbidden', message: "only the Warden re-submits a stuck send of Ferretry's own" });
      try {
        return ok(await sendActs.resubmitStuck(ferret, sendId).catch(sendActRefusal));
      } catch (error) {
        return err(actRefusal(error));
      }
    },
    retractedDraft: async ferret => await sendActs.retractedDraft(ferret).catch(() => undefined),
    deliveryLook: async ferret => await deliverer.look(ferret).catch(() => undefined),
    composer: async (ferret, action, draft) => {
      try {
        const outcome = await sendActs.resolveDraft(ferret, action, draft).catch(sendActRefusal);
        return ok({ action, outcome });
      } catch (error) {
        return err(actRefusal(error));
      }
    },
  };
}

/** The routes of the send path over the same half (`sessionSendRoutes`). */
export function sendRoutes(
  { send, queue, ledger }: Pick<MailboxParts, 'send' | 'queue' | 'ledger'>,
  clearer: SentDraftClearer | undefined,
): readonly MountRoute[] {
  const pager = new SendsPager(ledger);
  const { prepared, sendActs, interruptFerret, mayGo, deliverAttachments, submit, keptSend, records } = send;
  const { sendsStamp, awaitStatus, queueMessages, queueStamp, queueFailure, handoffOf } = send;
  return sessionSendRoutes(
    {
      send: async (
        id: string,
        request: UnwiredSend & {
          readonly message: string;
          readonly sendId: string;
          readonly senderSessionId?: string | undefined;
        },
      ) => {
        const kept = await keptSend(parseSessionId(id), request.sendId);
        if (kept !== undefined) return kept;
        // Asked before the text is prepared: a refused send runs no `message.before-send` transform.
        mayGo(request);
        const delivered = await deliverAttachments(parseSessionId(id), request.attachmentIds);
        return await submit(parseSessionId(id), {
          ...request,
          message: messageWithAttachments(await prepared(id, request.message), delivered),
        });
      },
      interrupt: async (id: string) => await interruptFerret(id),
      sends: records,
      // The same look a read takes first (a send the pane has settled), then a page cut from the index and the log's end.
      sendsPage: async (id, query) => {
        const ferret = parseSessionId(id);
        await send.lookFirst(ferret);
        return await pager.page(ferret, query);
      },
      sendsStamp,
      sendStatus: async (id, sendId, options) => await awaitStatus(parseSessionId(id), sendId, options),
      queue: queueMessages,
      queueStamp,
      editQueued: async (id, messageId, text) =>
        await queue.edit(parseSessionId(id), messageId, text).catch(queueFailure),
      cancelQueued: async (id, messageId) => await queue.cancel(parseSessionId(id), messageId).catch(queueFailure),
      retry: async (id, sendId, force) =>
        sendRecordView(
          await sendActs.reattempt(parseSessionId(id), sendId, { by: 'person', force }).catch(sendActRefusal),
        ),
      cancel: async (id, sendId) =>
        sendRecordView(await sendActs.cancel(parseSessionId(id), sendId).catch(sendActRefusal)),
      submit: async (id, sendId) =>
        sendRecordView(await sendActs.submit(parseSessionId(id), sendId).catch(sendActRefusal)),
      composer: async (id, request) => ({
        action: request.action,
        outcome: await sendActs.resolveDraft(parseSessionId(id), request.action, request.draft).catch(sendActRefusal),
      }),
      handoff: handoffOf,
    },
    clearer,
  );
}
