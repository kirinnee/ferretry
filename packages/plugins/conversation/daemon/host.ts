import {
  ApiError,
  type FerretId,
  type KernelPorts,
  type RouteHandler,
  type SocketAccept,
} from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { FerretsApi, SitrepLineSource } from '@ferretry/core-ferrets/contract';
import { err, ok } from '@ferretry/std';
import {
  type ConversationApi,
  type ConversationRefusal,
  QueueChanged,
  type QueuedMessage,
  QUESTION_STATE,
  type SendRecord,
} from '../contract/index.ts';
import { ClockSendScheduler, StateSendChannel, StateSendLedger } from './delivery/adapters/index.ts';
import { sendRecordFor, sendRecordView } from './delivery/lib/index.ts';
import { sentDraftClearer, sharedDraftRoutes, sharedDraftSocketRoutes } from './drafts/lib/mounts/shared-drafts.ts';
import { SessionSendError, sessionSendRoutes } from './delivery/lib/mounts/session-send.ts';
import { StateDraftRepository } from './drafts/adapters/index.ts';
import { SharedDraftPresence, SharedDraftService, sharedDraftOrigin } from './drafts/lib/index.ts';
import { StateQueueStore } from './queue/adapters/index.ts';
import { NotifyingSessionQueueStore, QueueRefused, SessionQueueService } from './queue/lib/index.ts';
import { sessionAnswerRoutes } from './questions/lib/mounts/session-answer.ts';
import { sessionCompactAtRoutes } from './turns/lib/mounts/session-compact-at.ts';
import { KeyedSerialExecutor } from './seams/keyed-serial-executor.ts';
import { type MountRoute, routeTable, socketTable } from './seams/api.ts';
import { parseSessionId, type SessionId } from './seams/ferret-id.ts';
import type { ClockPort } from './seams/ports.ts';

/** Said by every route that needs to type into, or read the screen of, a ferret's terminal. */
export const TERMINAL_PENDING =
  "This needs the ferret's terminal, and Conversation is not connected to it yet. Drive the ferret from its terminal for now.";

const pending = (): never => {
  throw new ApiError(503, TERMINAL_PENDING, 'conversation_terminal_unavailable');
};
const pendingRefusal = (): ConversationRefusal => ({
  code: 'conversation_terminal_unavailable',
  message: TERMINAL_PENDING,
});

/** What part a builds: its routes, its sockets, the half of the port it owns and its sitrep lines. */
export interface ConversationAHalf {
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly sockets: Readonly<Record<string, SocketAccept>>;
  readonly api: Pick<
    ConversationApi,
    | 'currentTurn'
    | 'send'
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
    | 'answer'
    | 'compactAt'
    | 'setCompactAt'
    | 'draft'
    | 'editDraft'
  >;
  readonly sitrep: SitrepLineSource;
  stop(): void;
}

/**
 * Part a of Conversation's daemon half: the queue, the send ledger, questions, turns and the shared draft, on the
 * kernel's state, clock, events and ids. Everything that must TYPE into a ferret's terminal (send, interrupt, the
 * composer actions, answering a question, the harness's own compact-at setting) is wired to a refusal that says so,
 * until Terminals and the harnesses give Conversation the pane seam; the queue, the ledger reads, the shared draft
 * and its stream are real.
 */
export function buildConversationA(deps: {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
}): ConversationAHalf {
  const { kernel, ferrets } = deps;
  const clock: ClockPort = { now: () => kernel.clock.now() };
  const queueSerial = new KeyedSerialExecutor();
  const draftSerial = new KeyedSerialExecutor();

  const queue = new SessionQueueService({
    store: new NotifyingSessionQueueStore(new StateQueueStore(kernel.state), {
      publish: async (id, _type, data) => {
        await kernel.events.publish(QueueChanged, { ferret: id, message: data.messageId, change: data.change });
      },
    }),
    clock,
    serial: queueSerial,
  });
  const ledger = new StateSendLedger(kernel.state, clock);
  const channel = new StateSendChannel(kernel.state);
  void channel; // handed to the send service when the terminal seam lands

  const presence = new SharedDraftPresence();
  const drafts = new SharedDraftService(
    {
      has: async id => (await ferrets.get(id as FerretId)) !== undefined,
      hasOpenItem: async () => true,
    },
    new StateDraftRepository(kernel.state, draftSerial),
    clock,
    { after: (ms, run) => ({ cancel: kernel.clock.after(milliseconds(ms), run) }) },
    { next: () => String(kernel.ids.mint('draft')) },
  );
  const scheduler = new ClockSendScheduler(kernel.clock);

  const queueMessages = async (id: string): Promise<readonly QueuedMessage[]> => await queue.list(parseSessionId(id));
  const queueFailure = (error: unknown): never => {
    if (error instanceof QueueRefused)
      throw new SessionSendError(error.refusal === 'not_found' ? 'not_found' : 'refused', error.message);
    throw error;
  };
  const records = async (id: string): Promise<readonly SendRecord[]> =>
    (await ledger.list(parseSessionId(id))).map(sendRecordView);

  const mounts: MountRoute[] = [
    ...sessionSendRoutes(
      {
        send: async () => pending(),
        interrupt: async () => pending(),
        sends: records,
        sendStatus: async (id, sendId) => {
          const parsed: SessionId = parseSessionId(id);
          const found = sendRecordFor(await ledger.list(parsed), await queue.list(parsed), sendId);
          if (found === undefined) throw new SessionSendError('not_found', `no send ${sendId} on this ferret`);
          return found;
        },
        queue: queueMessages,
        editQueued: async (id, messageId, text) =>
          await queue.edit(parseSessionId(id), messageId, text).catch(queueFailure),
        cancelQueued: async (id, messageId) => await queue.cancel(parseSessionId(id), messageId).catch(queueFailure),
        retry: async () => pending(),
        cancel: async () => pending(),
        submit: async () => pending(),
        composer: async () => pending(),
        handoff: async () => pending(),
      },
      sentDraftClearer(drafts),
    ),
    ...sessionAnswerRoutes({ answer: async () => pending() }),
    ...sessionCompactAtRoutes({ get: async () => pending(), set: async () => pending() }),
    ...sharedDraftRoutes(drafts),
  ];
  const sockets = sharedDraftSocketRoutes(drafts, {
    presence,
    deviceName: async () => undefined,
    nextPeer: () => String(kernel.ids.mint('peer')),
    clock: { nowMs: () => kernel.clock.nowMs() },
  });

  const api: ConversationAHalf['api'] = {
    currentTurn: async () => undefined,
    send: async () => err(pendingRefusal()),
    interrupt: async () => err(pendingRefusal()),
    queue: async ferret => ({ messages: [...(await queue.list(ferret as unknown as SessionId))] }),
    editQueued: async (ferret, message, request) => {
      try {
        return ok(await queue.edit(ferret as unknown as SessionId, message, request.text));
      } catch (error) {
        if (error instanceof QueueRefused) return err({ code: error.refusal, message: error.message });
        throw error;
      }
    },
    cancelQueued: async (ferret, message) => {
      try {
        return ok(await queue.cancel(ferret as unknown as SessionId, message));
      } catch (error) {
        if (error instanceof QueueRefused) return err({ code: error.refusal, message: error.message });
        throw error;
      }
    },
    sends: async ferret => ({ sends: [...(await records(ferret))] }),
    sendRecord: async (ferret, sendId) => {
      const id = ferret as unknown as SessionId;
      const found = sendRecordFor(await ledger.list(id), await queue.list(id), sendId);
      return found;
    },
    retrySend: async () => err(pendingRefusal()),
    cancelSend: async () => err(pendingRefusal()),
    enterSend: async () => err(pendingRefusal()),
    composer: async () => err(pendingRefusal()),
    answer: async () => err(pendingRefusal()),
    compactAt: async () => undefined,
    setCompactAt: async () => err(pendingRefusal()),
    draft: async (ferret, slot) => await drafts.read(ferret, slot === 'chat' ? undefined : slot),
    editDraft: async (ferret, slot, edit) => {
      try {
        const result = await drafts.edit(
          ferret,
          edit,
          sharedDraftOrigin('admin-cli', 'api', String(kernel.ids.mint('edit'))),
          slot === undefined || slot === 'chat' ? {} : { slot },
        );
        return ok(result as never);
      } catch (error) {
        return err({ code: 'draft_refused', message: error instanceof Error ? error.message : String(error) });
      }
    },
  };

  const sitrep: SitrepLineSource = {
    async lines(ferret) {
      const lines = [];
      const waiting = (await queue.list(ferret as unknown as SessionId)).filter(
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
    routes: routeTable(mounts),
    sockets: socketTable(sockets),
    api,
    sitrep,
    stop: () => {
      scheduler.cancelAll();
    },
  };
}
