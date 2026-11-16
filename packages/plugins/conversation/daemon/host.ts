import { ApiError, type KernelPorts, type RouteHandler, type SocketAccept } from '@ferretry/kernel/contract';
import { type AskAnswer, type AskId, AskIdSchema, type AskOwnerChat, type AsksApi } from '@ferretry/core-asks/contract';
import {
  AGENT_ORIGIN,
  type FerretsApi,
  type LaunchOrigin,
  PERSON_ORIGIN,
  type SitrepLineSource,
} from '@ferretry/core-ferrets/contract';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import { err, milliseconds, ok } from '@ferretry/std';
import { type MailboxHost, QueueChanged, type QueuedMessage } from '@ferretry/core-mailbox/contract';
import {
  type ConversationApi,
  type ConversationCaller,
  QuestionAnswered,
  QuestionAsked,
  QUESTION_ANSWERED_STATE,
  QUESTION_STATE,
  type Question,
} from '../contract/index.ts';
import { StateSendChannel, StateSendLedger } from './delivery/adapters/index.ts';
import { sendRecordFor, sendRecordView } from '@ferretry/core-mailbox/contract';
import { sentDraftClearer, sharedDraftRoutes, sharedDraftSocketRoutes } from './drafts/lib/mounts/shared-drafts.ts';
import { SessionSendError, sessionSendRoutes } from './delivery/lib/mounts/session-send.ts';
import { StateDraftRepository } from './drafts/adapters/index.ts';
import {
  buildQuestionAnswering,
  clearAskedQuestion,
  QuestionAsks,
  questionEntry,
  writeAskedQuestion,
  writeProjectedQuestion,
} from './questions/adapters/index.ts';
import type { TranscriptEvent } from './seams/transcript-types.ts';
import { ANSWER_FAILURES, SessionAnswerError } from './questions/lib/mounts/session-answer.ts';
import { agendaAnswers } from './questions/lib/agenda-answer.ts';
import { QUESTION_WATCH_MS, QuestionWatch } from './questions/lib/watch.ts';
import { PromptAsks } from './prompts/adapters/prompt-asks.ts';
import { StatePromptRecords } from './prompts/adapters/state-prompt-records.ts';
import type { PromptRead } from './prompts/lib/prompt-wait.ts';
import { OwnerWordsReader, type TurnPhase } from './turns/lib/index.ts';
import { SessionOwnerChat } from './turns/lib/owner-chat.ts';
import { SharedDraftPresence, SharedDraftService, sharedDraftOrigin } from './drafts/lib/index.ts';
import { StateQueueStore } from './queue/adapters/index.ts';
import { NotifyingSessionQueueStore, QueueRefused, SessionQueueService } from './queue/lib/index.ts';
import { sessionAnswerRoutes } from './questions/lib/mounts/session-answer.ts';
import { sessionCompactAtRoutes } from './turns/lib/mounts/session-compact-at.ts';
import { SessionCompactAtError, SessionCompactAtService } from './turns/compact-at/lib/service.ts';
import { StateHypermediaSwitch } from './hypermedia/adapters/index.ts';
import { hypermediaDefault, SessionHypermediaService, sessionHypermediaRoutes } from './hypermedia/lib/index.ts';
import { type HarnessGate } from './harness-seam.ts';
import { messageWithAttachments } from './attachments/lib/delivery.ts';
import { KeyedSerialExecutor } from './seams/keyed-serial-executor.ts';
import { type MountRoute, routeTable, socketTable } from './seams/api.ts';
import { parseSessionId, tryParseSessionId } from './seams/ferret-id.ts';
import type { ClockPort } from './seams/ports.ts';
import type { SessionView } from '@ferretry/core-mailbox/contract';
import {
  actRefusal,
  type AttachmentSource,
  buildSendHalf,
  refusalCode,
  sendActRefusal,
  statusOf,
  type UnwiredSend,
} from './send-half.ts';

export type { AttachmentSource };
/** A ferret nobody knows has no setting to read (the port answers `undefined`); anything else is a real failure. */
const compactAtAbsent = (error: unknown): undefined => {
  if (error instanceof SessionCompactAtError && error.reason === 'not-found') return undefined;
  throw error;
};

/**
 * Who a send on the PORT is for: the owner is a person; a ferret, and the Warden speaking, are agents (the Warden has no
 * ferret behind it). The caller the kernel bound the port to is the only source: a request field names nothing here.
 */
const originOfCaller = (caller: ConversationCaller): LaunchOrigin =>
  caller.kind === 'owner'
    ? PERSON_ORIGIN
    : caller.kind === 'ferret'
      ? { kind: 'agent', ferret: caller.ferret }
      : AGENT_ORIGIN;

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
    | 'resubmitStuck'
    | 'retractedDraft'
    | 'question'
    | 'answer'
    | 'compactAt'
    | 'setCompactAt'
    | 'draft'
    | 'editDraft'
  >;
  readonly sitrep: SitrepLineSource;
  /** The owner's messages to a ferret as `fy agenda log` copies them: the queue and the send ledger, by message id. */
  readonly ownerChat: AskOwnerChat;
  /** The queue log and send ledger over the files this plugin keeps, handed to the Mailbox through `mailbox.host`. */
  readonly mailboxHost: MailboxHost;
  /** The hypermedia switch the owner set for a ferret, or `undefined` when none (the launch reads it). */
  hypermediaRecorded(ferret: string): Promise<boolean | undefined>;
  /** The ferret stopped or went away: the question it was asking is withdrawn, so `question.json` goes. */
  withdrawQuestion(ferret: string): Promise<void>;
  /** An ask was answered: the draft of its item goes with it. */
  onAskAnswered(answered: { readonly ferret: string; readonly askId: AskId }): Promise<void>;
  /** The board changed (an ask was answered, closed or changed): a question card it refused for now is raised again. */
  onAsksChanged(): Promise<void>;
  /**
   * The owner answered a question's card on the Agenda: the answer is typed into the ferret's own question form BEFORE the
   * card counts as answered (`ask.sources:question` `apply`). A refusal keeps the card open, in the sentence it says.
   */
  applyQuestionAnswer(answer: AskAnswer): Promise<'applied' | { readonly refused: string }>;
  /** What Ferrets says of a ferret's phase, for `turn.ended`. */
  readonly turns: { look(ferret: string, phase: TurnPhase): void; forget(ferret: string): void };
  /** The question watch: one look at a ferret (a state change), and what is forgotten about a ferret that stopped. */
  readonly questions: { look(ferret: string): void; forget(ferret: string): void };
  /** Ferrets said a ferret changed state: its pane is read for a prompt on the next 2 s sweep, and no other ferret's is. */
  promptChanged(ferret: string): void;
  stop(): void;
}

/**
 * Part a of Conversation's daemon half: the queue, the send ledger, questions, turns and the shared draft, on the
 * kernel's state, clock, events and ids. A send and an interrupt go through Ferrets' harness seam, which answers a
 * closed refusal for a send and presses the harness's own stop key (`deps.gate` can still hold either back, 503).
 * The composer actions, a send's cancel and Enter, and answering a question's form (the structured-question drive over
 * the harness's form seam) are wired too, and so are a send's explicit retry (the send tracker's re-attempt, which only
 * types what the daemon proved absent) and the compact-at setting (recorded by Ferrets, applied at the next launch).
 */
export function buildConversationA(deps: {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
  readonly asks: Pick<AsksApi, 'get' | 'raise' | 'open' | 'close'>;
  readonly hooks: Pick<HookInvoker, 'observe' | 'transform'>;
  /** Which of the harness seam's two actions are live (see {@link HarnessGate}). */
  readonly gate: HarnessGate;
  /** The stored originals a send may name (part b's store). Absent: a send that names a file is refused. */
  readonly attachments?: AttachmentSource;
  /** A Codex ferret's parsed transcript tail (part b's reader), for the question watch. Absent: Codex is not watched. */
  readonly questionEvents?: (
    ferret: string,
    limit?: number,
  ) => Promise<readonly TranscriptEvent[] | 'unreadable' | undefined>;
}): ConversationAHalf {
  const { kernel, ferrets, asks, hooks, gate } = deps;
  const clock: ClockPort = { now: () => kernel.clock.now() };
  const queueSerial = new KeyedSerialExecutor();
  const draftSerial = new KeyedSerialExecutor();
  /** The one lane of each ferret's `question.json`: its writer, the exact-id clear and the withdrawal (r4 #2). */
  const questionSerial = new KeyedSerialExecutor();
  /** The Agenda's card for each stored question (Asks' source `question`), for either harness: one path. */
  const questionAsks = new QuestionAsks(asks, (ferret, error, outcome) =>
    kernel.log.warn(
      outcome === 'permanent'
        ? `conversation could not raise the agenda card of the question of ${ferret} and will not try again: ${String(error)}`
        : `conversation could not raise the agenda card of the question of ${ferret} yet, and will try again when the agenda has room: ${String(error)}`,
    ),
  );
  /** The Agenda's card for a ferret parked on a permission prompt or a dialog (Asks' source `prompt`). */
  const promptAsks = new PromptAsks(
    asks,
    async ferret => (await ferrets.prompt?.(parseSessionId(ferret))) as PromptRead | undefined,
    new StatePromptRecords(kernel.state),
    message => kernel.log.warn(message),
  );
  /** Said once until the ferret list reads again, not on every 2 s look. */
  let promptRosterFailing = false;
  /** Asks failing is never the question's failure: it is logged, owed and tried again on the watch's next look. */
  const askFailure =
    (what: string) =>
    (error: unknown): void =>
      kernel.log.warn(`conversation could not ${what} the agenda card of a question: ${String(error)}`);
  /** The card of the exact question now stored, raised once (idempotent), after the question is durable. */
  const raiseQuestionAsk = async (ferret: string, toolUseId: string): Promise<void> => {
    const read = await kernel.state.read(QUESTION_STATE, ferret);
    if (read.ok && read.value?.toolUseId === toolUseId)
      await questionAsks.raise(ferret, read.value).catch(askFailure('raise'));
  };
  /** The questions an Agenda answer is typing into the form now: their card is the Agenda's to resolve, not the drive's. */
  const applying = new Set<string>();
  const applyingKey = (ferret: string, toolUseId: string): string => JSON.stringify([ferret, toolUseId]);
  const closeQuestionAsk = async (
    ferret: string,
    toolUseId: string,
    reason: 'answered' | 'withdrawn',
  ): Promise<void> => {
    if (reason === 'answered' && applying.has(applyingKey(ferret, toolUseId))) return;
    await questionAsks.close(ferret, toolUseId, reason).catch(askFailure('close'));
  };
  /**
   * The Agenda says what the stored questions say, after a restart (the one-time event is gone): every stored question
   * has its card, a card without a stored question is closed. An unreadable file or roster refuses the whole pass: it is
   * missing evidence, never "no question".
   */
  const reconcileQuestionAsks = async (): Promise<void> => {
    const stored = new Map<string, Question>();
    for (const { id } of await ferrets.list()) {
      const read = await kernel.state.read(QUESTION_STATE, id);
      if (!read.ok) throw new Error(`the question of ${id} is unreadable`);
      if (read.value !== undefined) stored.set(id, read.value);
    }
    await questionAsks.reconcile(stored);
  };
  let questionAsksReconciled = false;

  const queueStore = new StateQueueStore(kernel.state, undefined, failure =>
    kernel.log.warn('the queue log could not be rotated; it keeps growing until a rotation succeeds', {
      ferret: failure.ferret,
      events: failure.events,
      bytes: failure.bytes,
      error: String(failure.error),
    }),
  );
  const queue = new SessionQueueService({
    store: new NotifyingSessionQueueStore(queueStore, {
      publish: async (id, _type, data) => {
        await kernel.events.publish(QueueChanged, { ferret: id, message: data.messageId, change: data.change });
      },
    }),
    clock,
    serial: queueSerial,
  });
  const ledger = new StateSendLedger(kernel.state, clock);
  const channel = new StateSendChannel(kernel.state);

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
  const send = buildSendHalf({
    kernel,
    ferrets,
    gate,
    hooks,
    clock,
    queue,
    ledger,
    channel,
    askedQuestion: async ferret => await askedQuestion(ferret),
    ...(deps.attachments === undefined ? {} : { attachments: deps.attachments }),
  });
  const {
    boundaries,
    prepared,
    turnStates,
    handoffOf,
    tracker,
    sendActs,
    interruptFerret,
    mayGo,
    deliverAttachments,
    typeMessage,
    keptSend,
    turnsOf,
    sendsStamp,
    queueStamp,
    queueMessages,
    queueFailure,
    lookFirst,
    records,
    awaitStatus,
  } = send;
  /** What the owner said to a ferret: the queue, the send ledger and its turn documents (Ferrets reads them back). */
  const ownerWords = new OwnerWordsReader({
    queue,
    sends: ledger,
    turns: { list: async (id, options) => (await (await turnsOf(id))?.list(options)) ?? [] },
    // An unknown ferret (one the registry has since removed) was not started by a ferret, as today's parent lookup answers.
    startedByFerret: async id => (await ferrets.get(id))?.parent !== undefined,
  });

  /**
   * What a ferret's queue holds. A ferret nobody knows and nothing was ever queued for is not "an empty queue": it is not a
   * ferret, so `fy queue <typo>` is refused with the sentence the send path uses instead of reporting that nothing waits.
   */
  /** `question.json`: the question the ferret is waiting on, as the harness asked it (written where the transcript is read). */
  const askedQuestion = async (ferret: string): Promise<Question | undefined> => {
    const read = await kernel.state.read(QUESTION_STATE, ferret);
    if (!read.ok || read.value === undefined) return undefined;
    // The transcript it was proved against stays in the file: the route and the port answer the question only.
    const { transcript: _proof, ...question } = read.value;
    return question;
  };
  /**
   * Answering a question's form is the structured-question drive (`questions/adapters/question-answering.ts`): the
   * service binds `question.json`, the driver types into the live form through Ferrets' form seam only after binding it
   * on a captured frame, the coordinator drives one logical answer at most once, and the stamp plus the exact-id clear of
   * `question.json` is the commit point. Its failures are the route's refusals (`SessionAnswerError`).
   */
  const answering = buildQuestionAnswering({
    state: kernel.state,
    ferrets,
    questionLane: questionSerial,
    // Its own queue: the answered clear re-enters the question lane, which an answer must not hold across the drive.
    serial: new KeyedSerialExecutor(),
    clock,
    status: async id => {
      const summary = await ferrets.get(id);
      return summary === undefined ? undefined : statusOf(summary);
    },
    publishAnswered: async (ferret, toolUseId) => {
      await closeQuestionAsk(ferret, toolUseId, 'answered');
      await kernel.events.publish(QuestionAnswered, { ferret, toolUseId });
    },
    released: async (ferret, toolUseId) => await closeQuestionAsk(ferret, toolUseId, 'withdrawn'),
    log: { info: (event, fields) => kernel.log.info(event, fields), warn: message => kernel.log.warn(message) },
    sleep: async ms => await kernel.clock.sleep(milliseconds(ms)),
  });
  const answerQuestion = async (...args: Parameters<typeof answering.answer>): Promise<SessionView> =>
    await answering.answer(...args);

  /**
   * THE QUESTION WATCH: Claude Code's hook leaves the question it asks in the ferret's own file; this reads it on the 2 s
   * cadence over the roster (and once on a ferret's state change) and makes it `question.json`, which is what the app, the
   * agenda and the send guard read. It also retires the question when the transcript says it was answered. Reads only.
   */
  const questionWatch = new QuestionWatch({
    roster: async () => (await ferrets.list()).map(({ id, harness, state }) => ({ id, harness, state })),
    harness: async ferret => {
      const id = tryParseSessionId(ferret);
      return id === undefined ? undefined : await ferrets.harness?.(id);
    },
    current: async ferret => {
      const read = await kernel.state.read(QUESTION_STATE, ferret);
      return read.ok ? read.value : undefined;
    },
    lastAnswered: async ferret => {
      const read = await kernel.state.read(QUESTION_ANSWERED_STATE, ferret);
      // Unreadable is missing evidence, never "nothing was answered": the look decides nothing and tries again.
      if (!read.ok) throw new Error('the answered stamp is unreadable');
      return read.value?.toolUseId;
    },
    write: async (ferret, payload, askedAt, transcript) =>
      await writeAskedQuestion(kernel.state, questionSerial, ferret, payload, askedAt, transcript),
    clear: async (ferret, toolUseId) => await clearAskedQuestion(kernel.state, questionSerial, ferret, toolUseId),
    ...(deps.questionEvents === undefined
      ? {}
      : {
          transcriptEvents: deps.questionEvents,
          writeProjected: async (ferret, pending, askedAt) =>
            await writeProjectedQuestion(kernel.state, questionSerial, ferret, pending, askedAt, () =>
              kernel.clock.now(),
            ),
        }),
    asked: async (ferret, toolUseId) => {
      await raiseQuestionAsk(ferret, toolUseId);
      await kernel.events.publish(QuestionAsked, { ferret: parseSessionId(ferret), toolUseId });
    },
    answered: async (ferret, toolUseId) => {
      await closeQuestionAsk(ferret, toolUseId, 'answered');
      await kernel.events.publish(QuestionAnswered, { ferret: parseSessionId(ferret), toolUseId });
    },
  });
  let cancelQuestionWatch: (() => void) | undefined;
  const watchQuestions = (): void => {
    if (send.isStopped()) return;
    cancelQuestionWatch = kernel.clock.after(milliseconds(QUESTION_WATCH_MS), () => {
      void (async () => {
        // The Agenda first (once after boot, then only what failed before is retried), so a card never waits on a look.
        if (!questionAsksReconciled) {
          await reconcileQuestionAsks().then(() => {
            questionAsksReconciled = true;
          }, askFailure('reconcile'));
        } else await questionAsks.settle();
        // A pane is read only for a ferret Ferrets reported changed, one owed a card, or once after boot: never every tick.
        await ferrets.list().then(
          async roster => {
            promptRosterFailing = false;
            await promptAsks.sweep(roster.map(ferret => ({ id: ferret.id, state: ferret.state })));
          },
          error => {
            if (!promptRosterFailing)
              kernel.log.warn(`conversation could not list the ferrets for their prompts: ${String(error)}`);
            promptRosterFailing = true;
          },
        );
        await questionWatch.sweep();
      })()
        .catch(() => undefined)
        .finally(watchQuestions);
    });
  };
  watchQuestions();

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

  // The ferret's own compaction trigger is Ferrets' to record (its session config, which every launch and relaunch reads);
  // Conversation judges the value, words what it means for a running ferret and asks Ferrets to write it. The model's
  // window and the login's default are not reachable from here: a value the model cannot honour is dropped at launch.
  const compactAtSetting = new SessionCompactAtService({
    // The caller is the ferret behind the call, when it is one: Ferrets applies its `mayTouch` rule to the read and the
    // write, and the read comes first, so a refused caller never reaches the store.
    facts: async (ferret, caller) => {
      const id = tryParseSessionId(ferret);
      const summary = id === undefined ? undefined : await ferrets.get(id);
      if (summary === undefined) return undefined;
      return {
        own: await ferrets.compactAt?.(summary.id, caller === undefined ? undefined : parseSessionId(caller)),
        accountDefault: undefined,
        window: undefined,
        running: summary.state !== 'stopped',
      };
    },
    write: async (ferret, value, _at, caller) => {
      if (ferrets.setCompactAt === undefined)
        throw new ApiError(503, 'Ferrets cannot record the compact-at setting right now.', 'plugin_unavailable');
      await ferrets.setCompactAt(
        parseSessionId(ferret),
        value,
        caller === undefined ? undefined : parseSessionId(caller),
      );
    },
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
        ) => {
          const kept = await keptSend(parseSessionId(id), request.sendId);
          if (kept !== undefined) return kept;
          // Asked before the text is prepared: a refused send runs no `message.before-send` transform.
          mayGo(request);
          const delivered = await deliverAttachments(parseSessionId(id), request.attachmentIds);
          return await typeMessage(parseSessionId(id), {
            ...request,
            message: messageWithAttachments(await prepared(id, request.message), delivered),
          });
        },
        interrupt: async (id: string) => await interruptFerret(id),
        sends: records,
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
      sentDraftClearer(drafts),
    ),
    ...sessionAnswerRoutes({ question: askedQuestion, answer: answerQuestion }),
    ...sessionCompactAtRoutes({
      get: async (ferret, caller) => await compactAtSetting.get(ferret, caller),
      set: async (ferret, wanted, caller) => await compactAtSetting.set(ferret, wanted, caller),
    }),
    ...sessionHypermediaRoutes({
      read: async ferret => await hypermedia.read(ferret),
      set: async (ferret, enabled) => await hypermedia.set(ferret, enabled),
    }),
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
        // Asked before an id is minted or the text is prepared: a refused send runs no transform and spends nothing.
        mayGo(request);
        const delivered = await deliverAttachments(ferret, request.attachmentIds);
        return ok(
          await typeMessage(ferret, {
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
    composer: async (ferret, action, draft) => {
      try {
        const outcome = await sendActs.resolveDraft(ferret, action, draft).catch(sendActRefusal);
        return ok({ action, outcome });
      } catch (error) {
        return err(actRefusal(error));
      }
    },
    question: async ferret => await askedQuestion(ferret),
    answer: async (ferret, request) => {
      try {
        // No request id comes with the port's call: one is minted, and a repeat finds the question no longer pending.
        await answering.answer(ferret, { ...request, requestId: String(kernel.ids.mint('answer')) });
        return ok(undefined);
      } catch (error) {
        if (error instanceof SessionAnswerError)
          return err({ code: ANSWER_FAILURES[error.failure].code, message: error.message });
        return err({
          code: error instanceof ApiError ? (error.code ?? 'answer_refused') : 'session_answer_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    compactAt: async ferret => await compactAtSetting.get(ferret).catch(compactAtAbsent),
    setCompactAt: async (ferret, patch) => {
      try {
        return ok(await compactAtSetting.set(ferret, patch.compactAt));
      } catch (error) {
        if (error instanceof SessionCompactAtError)
          return err({
            code: error.reason === 'not-found' ? 'not-found' : 'invalid_compact_at',
            message: error.message,
          });
        if (error instanceof ApiError) return err({ code: error.code ?? 'compact_at_refused', message: error.message });
        throw error;
      }
    },
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
    ownerChat: new SessionOwnerChat(queue, ledger),
    mailboxHost: { queue: queueStore, ledger },
    hypermediaRecorded: async ferret => await hypermediaSwitch.recorded(ferret),
    withdrawQuestion: async ferret => {
      questionWatch.forget(ferret);
      const stored = await kernel.state.read(QUESTION_STATE, ferret);
      await clearAskedQuestion(kernel.state, questionSerial, ferret);
      // Only the question that was stored when the withdrawal began: a newer one is its own.
      if (stored.ok && stored.value !== undefined) await closeQuestionAsk(ferret, stored.value.toolUseId, 'withdrawn');
    },
    promptChanged: ferret => promptAsks.changed(ferret),
    questions: {
      look: ferret => void questionWatch.look(ferret).catch(() => undefined),
      forget: ferret => questionWatch.forget(ferret),
    },
    onAskAnswered: async ({ ferret, askId }) => {
      await drafts.discard(ferret, askId).catch(() => undefined);
    },
    onAsksChanged: async () => await questionAsks.retryWaiting(),
    applyQuestionAnswer: async answer => {
      // The card's entry names the ferret and the tool-use id together: the question it was raised for, if it still waits.
      let found: { readonly ferret: string; readonly question: Question } | undefined;
      for (const { id } of await ferrets.list()) {
        const read = await kernel.state.read(QUESTION_STATE, id);
        if (read.ok && read.value !== undefined && questionEntry(id, read.value.toolUseId) === answer.entry) {
          found = { ferret: id, question: read.value };
          break;
        }
      }
      if (found === undefined)
        return { refused: 'That question is not waiting any more, so nothing was sent to the ferret.' };
      const mapped = agendaAnswers(found.question, { values: answer.values, text: answer.text });
      if (!mapped.ok) return { refused: `${mapped.reason}. The question is still open.` };
      const { toolUseId } = found.question;
      const key = applyingKey(found.ferret, toolUseId);
      applying.add(key);
      try {
        // One id per Agenda answer: a repeat of the same answer finds the drive already done, never a second one.
        await answering.answer(found.ferret, {
          toolUseId,
          labels: [],
          answers: mapped.answers,
          requestId: `agenda:${answer.id}`,
        });
        return 'applied';
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return { refused: `The answer did not reach the ferret, so the question stays open: ${why}` };
      } finally {
        applying.delete(key);
      }
    },
    turns: {
      look: (ferret, phase) => {
        boundaries.look(ferret, phase, kernel.clock.now());
        const id = tryParseSessionId(ferret);
        if (id !== undefined) {
          // Only a CHANGE moves the stamp: the guard compares it with when a send was typed.
          const state = phase === 'working' ? 'working' : 'idle';
          if (turnStates.get(id)?.state !== state) turnStates.set(id, { state, at: kernel.clock.now() });
        }
        // A turn boundary is when a held or queued send is read or dropped: one tracker look, only for a ferret with sends open.
        if (id === undefined || phase === 'working') return;
        void tracker
          .watching(id)
          .then(async watching => {
            if (watching) await tracker.check(id);
          })
          .catch(() => undefined);
      },
      forget: ferret => {
        boundaries.forget(ferret);
        const id = tryParseSessionId(ferret);
        if (id !== undefined) turnStates.delete(id);
      },
    },
    stop: () => {
      cancelQuestionWatch?.();
      send.stop();
    },
  };
}
