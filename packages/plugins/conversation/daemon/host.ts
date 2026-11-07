import { ApiError, type KernelPorts, type RouteHandler, type SocketAccept } from '@ferretry/kernel/contract';
import { type AskId, AskIdSchema, type AsksApi } from '@ferretry/core-asks/contract';
import type { FerretsApi, SitrepLineSource } from '@ferretry/core-ferrets/contract';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import type { Instant } from '@ferretry/std';
import { err, milliseconds, ok } from '@ferretry/std';
import {
  type ConversationApi,
  type ConversationRefusal,
  MessageBeforeSend,
  QueueChanged,
  type QueuedMessage,
  QUESTION_STATE,
  type Question,
  type SendRecord,
  TurnEnded,
} from '../contract/index.ts';
import { ClockSendScheduler, StateSendChannel, StateSendLedger } from './delivery/adapters/index.ts';
import { sendRecordFor, sendRecordView } from './delivery/lib/index.ts';
import { sentDraftClearer, sharedDraftRoutes, sharedDraftSocketRoutes } from './drafts/lib/mounts/shared-drafts.ts';
import { SessionSendError, sessionSendRoutes } from './delivery/lib/mounts/session-send.ts';
import { StateDraftRepository } from './drafts/adapters/index.ts';
import { TurnBoundaries, type TurnPhase } from './turns/lib/index.ts';
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
    | 'question'
    | 'answer'
    | 'compactAt'
    | 'setCompactAt'
    | 'draft'
    | 'editDraft'
  >;
  readonly sitrep: SitrepLineSource;
  /** An ask was answered: the draft of its item goes with it. */
  onAskAnswered(answered: { readonly ferret: string; readonly askId: AskId }): Promise<void>;
  /** What Ferrets says of a ferret's phase, for `turn.ended`. */
  readonly turns: { look(ferret: string, phase: TurnPhase): void; forget(ferret: string): void };
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
  readonly asks: Pick<AsksApi, 'get'>;
  readonly hooks: Pick<HookInvoker, 'observe' | 'transform'>;
}): ConversationAHalf {
  const { kernel, ferrets, asks, hooks } = deps;
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
      has: async id => (await ferrets.get(parseSessionId(id))) !== undefined,
      hasOpenItem: async (ferret, item) => (await asks.get({ ferret, id: AskIdSchema.parse(item) }))?.state === 'open',
    },
    new StateDraftRepository(kernel.state, draftSerial),
    clock,
    { after: (ms, run) => ({ cancel: kernel.clock.after(milliseconds(ms), run) }) },
    { next: () => String(kernel.ids.mint('draft')) },
  );
  const scheduler = new ClockSendScheduler(kernel.clock);

  // The round that ends is announced to whoever takes `turn.ended`; Ferrets' own phase is what the daemon can see.
  const boundaries = new TurnBoundaries(boundary => {
    hooks.observe(TurnEnded, {
      ferret: parseSessionId(boundary.ferret),
      turn: boundary.turn,
      outcome: boundary.outcome,
      endedAt: boundary.endedAt as Instant,
    });
  });
  // No poll: Ferrets says every change of a ferret's state (`ferret.changed`), and each is one look (see `index.ts`).

  /** The one place text enters a send: `message.before-send` may reword it, or refuse it. */
  const prepared = async (ferret: string, message: string): Promise<string> => {
    const out = await hooks.transform(MessageBeforeSend, { ferret: parseSessionId(ferret), text: message });
    if (!out.ok) throw new ApiError(422, out.error, 'message_refused');
    return out.value.text;
  };
  /** THE TERMINAL SEAM: typing into a ferret's terminal waits on the runner's deliver (Ferrets, Vault) and refuses until then. */
  const terminal = {
    deliver: async (_ferret: string, _message: string): Promise<never> => pending(),
    interrupt: async (_ferret: string): Promise<never> => pending(),
  };
  const interruptFerret = async (ferret: string): Promise<void> => {
    await terminal.interrupt(ferret);
    boundaries.markInterrupted(ferret);
  };

  const queueMessages = async (id: string): Promise<readonly QueuedMessage[]> => await queue.list(parseSessionId(id));
  const queueFailure = (error: unknown): never => {
    if (error instanceof QueueRefused)
      throw new SessionSendError(error.refusal === 'not_found' ? 'not_found' : 'refused', error.message);
    throw error;
  };
  const records = async (id: string): Promise<readonly SendRecord[]> =>
    (await ledger.list(parseSessionId(id))).map(sendRecordView);

  /** `question.json`: the question the ferret is waiting on, as the harness asked it (written where the transcript is read). */
  const askedQuestion = async (ferret: string): Promise<Question | undefined> => {
    const read = await kernel.state.read(QUESTION_STATE, ferret);
    if (!read.ok || read.value === undefined) return undefined;
    // The transcript it was proved against stays in the file: the route and the port answer the question only.
    const { transcript: _proof, ...question } = read.value;
    return question;
  };

  const mounts: MountRoute[] = [
    ...sessionSendRoutes(
      {
        send: async (id: string, request: { readonly message: string }) =>
          await terminal.deliver(id, await prepared(id, request.message)),
        interrupt: async (id: string) => await interruptFerret(id).then(pending),
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
    ...sessionAnswerRoutes({ question: askedQuestion, answer: async () => pending() }),
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
    currentTurn: async ferret => boundaries.current(ferret),
    send: async (ferret, _caller, request) => {
      try {
        await terminal.deliver(ferret, await prepared(ferret, request.message));
      } catch (error) {
        return err({
          code: (error instanceof ApiError ? error.code : undefined) ?? 'send_refused',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return err(pendingRefusal());
    },
    interrupt: async ferret => {
      try {
        await interruptFerret(ferret);
      } catch {
        // refused below, with the sentence
      }
      return err(pendingRefusal());
    },
    queue: async ferret => ({ messages: [...(await queue.list(ferret))] }),
    editQueued: async (ferret, message, request) => {
      try {
        return ok(await queue.edit(ferret, message, request.text));
      } catch (error) {
        if (error instanceof QueueRefused) return err({ code: error.refusal, message: error.message });
        throw error;
      }
    },
    cancelQueued: async (ferret, message) => {
      try {
        return ok(await queue.cancel(ferret, message));
      } catch (error) {
        if (error instanceof QueueRefused) return err({ code: error.refusal, message: error.message });
        throw error;
      }
    },
    sends: async ferret => ({ sends: [...(await records(ferret))] }),
    sendRecord: async (ferret, sendId) => sendRecordFor(await ledger.list(ferret), await queue.list(ferret), sendId),
    retrySend: async () => err(pendingRefusal()),
    cancelSend: async () => err(pendingRefusal()),
    enterSend: async () => err(pendingRefusal()),
    composer: async () => err(pendingRefusal()),
    question: async ferret => await askedQuestion(ferret),
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
        return ok({ applied: result.applied, snapshot: result.snapshot });
      } catch (error) {
        return err({ code: 'draft_refused', message: error instanceof Error ? error.message : String(error) });
      }
    },
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
    routes: routeTable(mounts),
    sockets: socketTable(sockets),
    api,
    sitrep,
    onAskAnswered: async ({ ferret, askId }) => {
      await drafts.discard(ferret, askId).catch(() => undefined);
    },
    turns: {
      look: (ferret, phase) => boundaries.look(ferret, phase, kernel.clock.now()),
      forget: ferret => boundaries.forget(ferret),
    },
    stop: () => {
      scheduler.cancelAll();
    },
  };
}
