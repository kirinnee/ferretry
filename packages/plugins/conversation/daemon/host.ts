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
  type SendResult,
  TurnEnded,
} from '../contract/index.ts';
import { ClockSendScheduler, StateSendChannel, StateSendLedger } from './delivery/adapters/index.ts';
import { sendRecordFor, sendRecordView } from './delivery/lib/index.ts';
import { sentDraftClearer, sharedDraftRoutes, sharedDraftSocketRoutes } from './drafts/lib/mounts/shared-drafts.ts';
import { SessionSendError, sessionSendRoutes } from './delivery/lib/mounts/session-send.ts';
import { StateDraftRepository } from './drafts/adapters/index.ts';
import { clearAskedQuestion } from './questions/adapters/index.ts';
import { NO_TURN_DOCUMENTS, OwnerWordsReader, TurnBoundaries, type TurnPhase } from './turns/lib/index.ts';
import { SharedDraftPresence, SharedDraftService, sharedDraftOrigin } from './drafts/lib/index.ts';
import { StateQueueStore } from './queue/adapters/index.ts';
import { answerOf } from './queue/lib/answer.ts';
import { NotifyingSessionQueueStore, QueueRefused, SessionQueueService } from './queue/lib/index.ts';
import { type SessionAnswerSubsystem, sessionAnswerRoutes } from './questions/lib/mounts/session-answer.ts';
import { sessionCompactAtRoutes } from './turns/lib/mounts/session-compact-at.ts';
import { StateHypermediaSwitch } from './hypermedia/adapters/index.ts';
import { hypermediaDefault, SessionHypermediaService, sessionHypermediaRoutes } from './hypermedia/lib/index.ts';
import {
  type HarnessGate,
  INTERRUPT_UNAVAILABLE,
  MaybeTyped,
  SEND_EXTRAS_UNAVAILABLE,
  SEND_UNAVAILABLE,
  terminalSeam,
} from './harness-seam.ts';
import { KeyedSerialExecutor } from './seams/keyed-serial-executor.ts';
import { type MountRoute, routeTable, socketTable } from './seams/api.ts';
import { parseSessionId, type SessionId, tryParseSessionId } from './seams/ferret-id.ts';
import type { ClockPort } from './seams/ports.ts';
import type { SessionView } from './seams/protocol.ts';

/** Said by every route that needs the ferret's terminal and is not connected to it: a send, an interrupt, the composer, a question's form, a retry. */
const TERMINAL_PENDING =
  "This needs the ferret's terminal, and Conversation is not connected to it yet. Drive the ferret from its terminal for now.";

const pending = (sentence: string = TERMINAL_PENDING): never => {
  throw new ApiError(503, sentence, 'conversation_terminal_unavailable');
};
const pendingRefusal = (): ConversationRefusal => ({
  code: 'conversation_terminal_unavailable',
  message: TERMINAL_PENDING,
});

/** The code a refusal answers with on the port: the route's own code, else the word of a send refusal. */
const refusalCode = (error: unknown): string =>
  error instanceof ApiError
    ? (error.code ?? 'send_refused')
    : error instanceof SessionSendError
      ? ((
          { not_found: 'not_found', refused: 'send_refused', failed: 'session_send_failed' } as Readonly<
            Record<string, string>
          >
        )[error.failure] ?? 'send_refused')
      : 'send_refused';

/** What a send can carry that the harness seam does not type yet. */
interface UnwiredSend {
  readonly attachmentIds?: readonly string[] | undefined;
  readonly label?: unknown;
  readonly now?: boolean | undefined;
  readonly replyExpected?: boolean | undefined;
}

/** One answer as the terminal seam takes it: the route's request, or the port's with a minted request id. */
type AnswerToTerminal = Parameters<SessionAnswerSubsystem['answer']>[1];

/** What part a builds: its routes, its sockets, the half of the port it owns and its sitrep lines. */
export interface ConversationAHalf {
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly sockets: Readonly<Record<string, SocketAccept>>;
  readonly api: Pick<
    ConversationApi,
    | 'currentTurn'
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
    | 'question'
    | 'answer'
    | 'compactAt'
    | 'setCompactAt'
    | 'draft'
    | 'editDraft'
  >;
  readonly sitrep: SitrepLineSource;
  /** The hypermedia switch the owner set for a ferret, or `undefined` when none (the launch reads it). */
  hypermediaRecorded(ferret: string): Promise<boolean | undefined>;
  /** The ferret stopped or went away: the question it was asking is withdrawn, so `question.json` goes. */
  withdrawQuestion(ferret: string): Promise<void>;
  /** An ask was answered: the draft of its item goes with it. */
  onAskAnswered(answered: { readonly ferret: string; readonly askId: AskId }): Promise<void>;
  /** What Ferrets says of a ferret's phase, for `turn.ended`. */
  readonly turns: { look(ferret: string, phase: TurnPhase): void; forget(ferret: string): void };
  stop(): void;
}

/**
 * Part a of Conversation's daemon half: the queue, the send ledger, questions, turns and the shared draft, on the
 * kernel's state, clock, events and ids. A send and an interrupt are built over Ferrets' harness seam but wait behind
 * the gate (`deps.gate`) until Ferrets answers a closed refusal for a send and presses the harness's own stop key.
 * Everything else that needs the pane (the composer actions, a send's retry, cancel and submit, answering a question's
 * form, the harness's own compact-at setting) is wired to a refusal that says so; the queue, the ledger reads, the
 * shared draft and its stream are real.
 */
export function buildConversationA(deps: {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
  readonly asks: Pick<AsksApi, 'get'>;
  readonly hooks: Pick<HookInvoker, 'observe' | 'transform'>;
  /** Which of the harness seam's two actions are live (see {@link HarnessGate}). */
  readonly gate: HarnessGate;
}): ConversationAHalf {
  const { kernel, ferrets, asks, hooks, gate } = deps;
  const clock: ClockPort = { now: () => kernel.clock.now() };
  const queueSerial = new KeyedSerialExecutor();
  const draftSerial = new KeyedSerialExecutor();
  /** The one lane of each ferret's `question.json`: its writer, the exact-id clear and the withdrawal (r4 #2). */
  const questionSerial = new KeyedSerialExecutor();

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
  void channel; // handed to the send service when the full send path (queue, tracker) is wired

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
  /**
   * THE TERMINAL SEAM: typing and interrupting go through Ferrets' harness seam (`FerretsApi.harness`), whose runner acts
   * on the ferret's terminal itself, so nothing here wraps a call in an act of its own. Answering a question's form is
   * the structured-question drive, which still waits on its own wiring.
   */
  const harness = terminalSeam(ferrets);
  const terminal = {
    ...harness,
    answer: async (_ferret: string, _request: AnswerToTerminal): Promise<SessionView> => pending(),
  };
  /**
   * Stops the ferret's turn and answers its view, so a route can show what the call changed. Waits behind the gate before
   * anything is opened: Ferrets' interrupt is the runner's raw `C-c`, which quits an idle Codex, answers a pending
   * question by accident and ignores a terminal status, where today presses Escape and only on a pane doing work.
   */
  const interruptFerret = async (ferret: string): Promise<SessionView> => {
    if (!gate.interrupt) return pending(INTERRUPT_UNAVAILABLE);
    await (await terminal.bind(ferret)).interrupt();
    boundaries.markInterrupted(ferret);
    // Ferrets' record carries no turn count, so the view is the id and the status the interrupt just made true.
    return { id: ferret, status: 'interrupted', turn: 0 };
  };
  /**
   * Whether a send may be typed at all, before anything is opened or kept (a repeat of a kept id is answered without it). Waits behind the gate:
   * the runner throws, rather than answers, for a pane that is busy, behind a dialog or holding the person's draft, so a
   * refusal that typed nothing cannot be told from a send that was typed. And refuses what the harness seam does not type
   * yet: files, a hold-to-turn-end label, the type-now flag and a reply request would be dropped, and the send answered
   * `sent` all the same (U3 carries them).
   */
  const mayGo = (request: UnwiredSend): void => {
    if (!gate.send) pending(SEND_UNAVAILABLE);
    if (
      (request.attachmentIds?.length ?? 0) > 0 ||
      request.label !== undefined ||
      request.now !== undefined ||
      request.replyExpected !== undefined
    )
      pending(SEND_EXTRAS_UNAVAILABLE);
  };
  /**
   * Types one message. The send is ledgered as accepted BEFORE a key goes (the same id twice is one message), and a
   * refusal that typed nothing takes the record back so the id may start over; a runner that threw mid-write keeps it,
   * because what reached the pane is uncertain. Proof that the harness took it is the tracker's, so the fate stays
   * `accepted` here.
   */
  const typeMessage = async (
    ferret: SessionId,
    request: UnwiredSend & {
      readonly message: string;
      readonly sendId: string;
      readonly senderSessionId?: string | undefined;
    },
  ): Promise<SendResult> => {
    mayGo(request);
    // Opened BEFORE the record: an unknown ferret or a seam that is off types nothing and keeps nothing. No caller goes
    // to Ferrets: a send has no target rule (the path names where it goes, as for every caller); a ferret is a SENDER.
    const bound = await terminal.bind(ferret);
    const at = kernel.clock.now();
    const accepted = await ledger.accept(ferret, {
      sendId: request.sendId,
      acceptedAt: at,
      acceptedTurn: 0,
      path: 'direct',
      message: request.message,
      matchText: request.message,
      fate: 'accepted',
      attempt: 1,
      attemptAt: at,
      senderKind: request.senderSessionId === undefined ? 'human' : 'agent',
      ...(request.senderSessionId === undefined ? {} : { from: request.senderSessionId }),
    });
    if (!accepted.created) return (await keptSend(ferret, request.sendId)) ?? { ferret, disposition: 'sent' };
    try {
      await bound.deliver(request.message);
    } catch (error) {
      if (error instanceof MaybeTyped) throw error.answer;
      await ledger.withdraw(ferret, request.sendId, 'nothing was typed').catch(() => undefined);
      throw error;
    }
    return { ferret, disposition: 'sent', sendId: request.sendId, fate: 'accepted' };
  };

  /**
   * The send a request's own id already made, answered as that send's first request was: the same id twice is ONE message,
   * across daemon runs, because the queue keeps it as the message's id and the send ledger as its `sendId`. A message
   * delivered inside a combined turn has no row of its own and is answered from the turn's, as its own id.
   */
  const keptSend = async (ferret: SessionId, sendId: string | undefined): Promise<SendResult | undefined> => {
    if (sendId === undefined) return undefined;
    const [rows, queued] = await Promise.all([ledger.list(ferret), queue.list(ferret)]);
    const waiting = queued.find(message => message.id === sendId);
    // A withdrawn row typed nothing, so its id may start over: only the queue still holding the message keeps it answered.
    const row =
      rows.find(entry => entry.sendId === sendId && (entry.fate !== 'withdrawn' || waiting !== undefined)) ??
      (waiting?.deliveredAs === undefined ? undefined : rows.find(entry => entry.sendId === waiting.deliveredAs));
    if (row === undefined && waiting === undefined) return undefined;
    const answer = answerOf(row, waiting);
    return {
      ferret,
      disposition: answer.disposition,
      sendId,
      fate: answer.fate,
      ...(answer.waitReason === undefined ? {} : { waitReason: answer.waitReason }),
      ...(answer.waitBehind === undefined ? {} : { waitBehind: answer.waitBehind }),
      ...(waiting?.label === undefined ? {} : { label: waiting.label }),
      ...(waiting?.holdUntil === undefined ? {} : { heldUntil: waiting.holdUntil }),
    };
  };
  /** What the owner said to a ferret: the queue, the send ledger and its turn documents (none are written yet). */
  const ownerWords = new OwnerWordsReader({
    queue,
    sends: ledger,
    turns: NO_TURN_DOCUMENTS,
    // An unknown ferret (one the registry has since removed) was not started by a ferret, as today's parent lookup answers.
    startedByFerret: async id => (await ferrets.get(id))?.parent !== undefined,
  });

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
  /**
   * Answers through the terminal seam. An answer that landed ends the question, so `question.json` goes with it (the
   * route's subsystem "returns only after … state cleared its exact bound tool id"): the route, the port and the sitrep
   * then say none instead of the question already answered.
   */
  const answerQuestion = async (ferret: string, request: AnswerToTerminal): Promise<SessionView> => {
    const view = await terminal.answer(ferret, request);
    await clearAskedQuestion(kernel.state, questionSerial, ferret, request.toolUseId);
    return view;
  };

  const hypermediaSwitch = new StateHypermediaSwitch(kernel.state);
  const hypermedia = new SessionHypermediaService({
    facts: async ferret => {
      const id = tryParseSessionId(ferret);
      const summary = id === undefined ? undefined : await ferrets.get(id);
      if (summary === undefined) return undefined;
      return {
        enabled: (await hypermediaSwitch.recorded(summary.id)) ?? hypermediaDefault(summary.mode),
        running: summary.state !== 'stopped',
      };
    },
    write: async (ferret, enabled, at) => await hypermediaSwitch.write(ferret, enabled, at),
    now: () => kernel.clock.now(),
  });

  const mounts: MountRoute[] = [
    ...sessionSendRoutes(
      {
        send: async (
          id: string,
          request: UnwiredSend & {
            readonly message: string;
            readonly sendId: string;
            readonly senderSessionId?: string | undefined;
          },
        ) =>
          (await keptSend(parseSessionId(id), request.sendId)) ??
          (await typeMessage(parseSessionId(id), { ...request, message: await prepared(id, request.message) })),
        interrupt: async (id: string) => await interruptFerret(id),
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
    ...sessionAnswerRoutes({ question: askedQuestion, answer: answerQuestion }),
    ...sessionCompactAtRoutes({ get: async () => pending(), set: async () => pending() }),
    ...sessionHypermediaRoutes({ set: async (ferret, enabled) => await hypermedia.set(ferret, enabled) }),
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
    send: async (ferret, caller, request) => {
      try {
        const kept = await keptSend(ferret, request.sendId);
        if (kept !== undefined) return ok(kept);
        return ok(
          await typeMessage(ferret, {
            sendId: request.sendId ?? String(kernel.ids.mint('send')),
            message: await prepared(ferret, request.message),
            ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
            ...(request.label === undefined ? {} : { label: request.label }),
            ...(request.now === undefined ? {} : { now: request.now }),
            ...(request.replyExpected === undefined ? {} : { replyExpected: request.replyExpected }),
            // The route and the port follow one rule: a ferret is the message's SENDER, never a different target's rule.
            ...(caller.kind === 'ferret' ? { senderSessionId: caller.ferret } : {}),
          }),
        );
      } catch (error) {
        return err({
          code: refusalCode(error),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    ownerWords: async (ferret, options) => {
      try {
        return ok({ v: 1, ferret, words: await ownerWords.said(ferret, { strict: options?.strict === true }) });
      } catch (error) {
        return err({ code: 'unreadable', message: error instanceof Error ? error.message : String(error) });
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
    answer: async (ferret, request) => {
      try {
        await answerQuestion(ferret, { ...request, requestId: String(kernel.ids.mint('answer')) });
      } catch (error) {
        return err({
          code: (error instanceof ApiError ? error.code : undefined) ?? 'answer_refused',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return ok(undefined);
    },
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
    hypermediaRecorded: async ferret => await hypermediaSwitch.recorded(ferret),
    withdrawQuestion: async ferret => await clearAskedQuestion(kernel.state, questionSerial, ferret),
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
