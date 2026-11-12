import { ApiError, type KernelPorts, type RouteHandler, type SocketAccept } from '@ferretry/kernel/contract';
import { type AskId, AskIdSchema, type AsksApi } from '@ferretry/core-asks/contract';
import {
  AGENT_ORIGIN,
  type FerretsApi,
  type FerretSummary,
  type FerretTurnAuthor,
  type LaunchOrigin,
  PERSON_ORIGIN,
  type QueueOutcome,
  type SitrepLineSource,
} from '@ferretry/core-ferrets/contract';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import type { Instant } from '@ferretry/std';
import { err, milliseconds, ok } from '@ferretry/std';
import {
  type ConversationApi,
  type ConversationCaller,
  type ConversationRefusal,
  MessageBeforeSend,
  PEER_MESSAGE_LABELS,
  type PeerMessageLabel,
  QueueChanged,
  QuestionAnswered,
  QuestionAsked,
  type QueuedMessage,
  QUESTION_ANSWERED_STATE,
  QUESTION_STATE,
  type Question,
  type SendRecord,
  type SendResult,
  TurnEnded,
} from '../contract/index.ts';
import {
  ClockSendScheduler,
  EntriesSendEvidence,
  StateSendChannel,
  StateSendLedger,
} from './delivery/adapters/index.ts';
import {
  defaultSendTrackerSettings,
  defaultSessionSendSettings,
  dispositionOf,
  isDirectSend,
  isFileBackedQueue,
  isUnconfirmedTyping,
  lookBeforeReading,
  paneMidTurn,
  peerMessageKind,
  peerPreamble,
  queuedPayloadInstruction,
  routeSend,
  type SendPath,
  SendTracker,
  type SendTarget,
  type SendTerminal,
  type SendTurnStore,
  TERMINAL_SEND_STATUSES,
  turnInstruction,
  authorizeSend,
  SendDraftRefused,
  SendPending,
  SendRefused,
  SessionInterrupt,
  SessionSendService,
  sendPayload,
  sendRecordFor,
  sendRecordView,
} from './delivery/lib/index.ts';
import type { SessionStatus } from './seams/ferret-types.ts';
import { sentDraftClearer, sharedDraftRoutes, sharedDraftSocketRoutes } from './drafts/lib/mounts/shared-drafts.ts';
import { SessionSendError, sessionSendRoutes } from './delivery/lib/mounts/session-send.ts';
import { StateDraftRepository } from './drafts/adapters/index.ts';
import { buildQuestionAnswering, clearAskedQuestion, writeAskedQuestion } from './questions/adapters/index.ts';
import { ANSWER_FAILURES, SessionAnswerError } from './questions/lib/mounts/session-answer.ts';
import { QUESTION_WATCH_MS, QuestionWatch } from './questions/lib/watch.ts';
import { OwnerWordsReader, TurnBoundaries, type TurnPhase } from './turns/lib/index.ts';
import { SharedDraftPresence, SharedDraftService, sharedDraftOrigin } from './drafts/lib/index.ts';
import { StateQueueStore } from './queue/adapters/index.ts';
import { answerOf } from './queue/lib/answer.ts';
import { NotifyingSessionQueueStore, QueueRefused, SessionQueueService } from './queue/lib/index.ts';
import { sessionAnswerRoutes } from './questions/lib/mounts/session-answer.ts';
import { sessionCompactAtRoutes } from './turns/lib/mounts/session-compact-at.ts';
import { StateHypermediaSwitch } from './hypermedia/adapters/index.ts';
import { hypermediaDefault, SessionHypermediaService, sessionHypermediaRoutes } from './hypermedia/lib/index.ts';
import {
  type HarnessGate,
  INTERRUPT_UNAVAILABLE,
  MaybeTyped,
  PaneBusy,
  SEND_PATH_UNWIRED,
  SEND_UNAVAILABLE,
  terminalSeam,
  Unconfirmed,
} from './harness-seam.ts';
import { startupParkedPending } from './delivery/lib/service.ts';
import { type DeliveredAttachment, deliveredFilename, messageWithAttachments } from './attachments/lib/delivery.ts';
import { harnessSendTerminal } from './send-terminal.ts';
import { harnessFamily } from './seams/harness-family.ts';
import { KeyedSerialExecutor } from './seams/keyed-serial-executor.ts';
import { type MountRoute, routeTable, socketTable } from './seams/api.ts';
import { parseSessionId, type SessionId, tryParseSessionId } from './seams/ferret-id.ts';
import type { ClockPort } from './seams/ports.ts';
import type { SessionView } from './seams/protocol.ts';

/** Said by every route that needs the ferret's terminal and is not connected to it: an explicit send retry, the compact-at setting, a handover. Not in 5.0 yet (cards &F3456, &F3455). */
const TERMINAL_PENDING =
  'Not in 5.0 yet: typing a send again (Retry), the compact-at setting and a handover. Drive the ferret from its terminal for now.';

const pending = (sentence: string = TERMINAL_PENDING): never => {
  throw new ApiError(503, sentence, 'conversation_terminal_unavailable');
};
const pendingRefusal = (): ConversationRefusal => ({
  code: 'conversation_terminal_unavailable',
  message: TERMINAL_PENDING,
});

/** Said by a repeat of a send that was typed and not proven: it is not typed again, and the answer names it. */
const UNCONFIRMED_AGAIN =
  "this message was already typed into the agent's box and nothing proved it landed, so it was not typed again. Check the ferret's terminal before sending it again";

/** Said after a typed, unproven send whose record could not be marked so: a repeat of its id would read as sent. */
const UNSETTLED_SENTENCE =
  'Its record could not be marked unconfirmed, so a repeat of this send may wrongly read as sent; check the ferret’s terminal instead';

/**
 * The code a refusal answers with on the port: the route's own code, else the word the send route answers for that
 * refusal (`composer_occupied` for a draft in the way, `send_unconfirmed` for a typed send nothing proved).
 */
const refusalCode = (error: unknown): string => {
  if (error instanceof ApiError) return error.code ?? 'send_refused';
  if (!(error instanceof SessionSendError)) return 'send_refused';
  if (error.failure === 'refused' && error.draft !== undefined) return 'composer_occupied';
  return (
    (
      {
        invalid: 'invalid',
        not_found: 'not_found',
        refused: 'send_refused',
        pending: 'session_launching',
        unconfirmed: 'send_unconfirmed',
        failed: 'session_send_failed',
      } as Readonly<Record<string, string>>
    )[error.failure] ?? 'send_refused'
  );
};

/** A refusal of one of the send path's acts, as the port answers it: the route's own code, and the words. */
const actRefusal = (error: unknown): ConversationRefusal => ({
  code: refusalCode(error),
  message: error instanceof Error ? error.message : String(error),
});

/** Today's session-layer refusals (`SendRefused` and its kinds), in the send route's taxonomy. */
const sendRefusal = (error: unknown): never => {
  if (error instanceof SendRefused) throw new SessionSendError('refused', error.message);
  throw error;
};

/**
 * The send path's own refusals (`SessionSendService`'s acts), in the send route's taxonomy: a person's draft rides along
 * so the app can act on exactly that text, and a launch still in flight is pending (503), not refused.
 */
const sendActRefusal = (error: unknown): never => {
  if (error instanceof SendPending) throw new SessionSendError('pending', error.message);
  if (error instanceof SendDraftRefused) throw new SessionSendError('refused', error.message, error.draft);
  return sendRefusal(error);
};

/**
 * The journal fields that reach the log: ids and outcome words only. The queue-wait events carry the refusal's sentence
 * in `reason`, and a sentence may quote a prompt or a person's words, so it is not here.
 */
const JOURNAL_LOG_KEYS = ['sendId', 'outcome', 'effect', 'from', 'by', 'turn', 'direct', 'proof'] as const;

/** A ferret's lifecycle state, as the session status the interrupt's refusals are written against. */
const statusOf = (ferret: FerretSummary): SessionStatus => {
  switch (ferret.state) {
    case 'starting':
      return 'starting';
    case 'working':
      return 'running';
    case 'idle':
      return 'awaiting_user';
    case 'stopped':
      return ferret.cause?.kind === 'completed'
        ? 'completed'
        : ferret.cause === undefined || ferret.cause.kind === 'stopped' || ferret.cause.kind === 'clean_exit'
          ? 'stopped'
          : 'failed';
  }
};

/** The stored original of one attachment of a ferret, its digest re-checked (part b's store). */
export interface AttachmentSource {
  download(
    ferret: string,
    id: string,
  ): Promise<{
    readonly attachment: { readonly id: string; readonly filename: string; readonly mime: string };
    readonly bytes: Uint8Array;
  }>;
}

/**
 * What a send can carry beyond its text. `attachmentIds` are handed to the agent as files ({@link deliverAttachments}).
 * `label` is typed under its banner whatever it is: `fyi` too, as v4 did with its queue off (holding an fyi to the
 * receiver's turn end waits on the queue deliverer, which this host does not wire).
 */
interface UnwiredSend {
  /**
   * Who a revive this send causes is FOR: the admitted credential's, never the sender's attribution. Required, so a caller
   * that does not say who is sending does not compile.
   */
  readonly origin: LaunchOrigin;
  readonly attachmentIds?: readonly string[] | undefined;
  readonly label?: unknown;
  readonly now?: boolean | undefined;
  readonly replyExpected?: boolean | undefined;
}

/** The message a send carries (today's `sendPayload`, trimmed), an empty one refused 409 before anything is kept. */
const payloadOf = (message: string): string => {
  try {
    return sendPayload(message);
  } catch (error) {
    return sendRefusal(error);
  }
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

/** A triage label a peer's banner can carry (the route and the port parse it; anything else carries none). */
const bannerLabel = (label: unknown): PeerMessageLabel | undefined =>
  PEER_MESSAGE_LABELS.find(known => known === label);

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
  /** The hypermedia switch the owner set for a ferret, or `undefined` when none (the launch reads it). */
  hypermediaRecorded(ferret: string): Promise<boolean | undefined>;
  /** The ferret stopped or went away: the question it was asking is withdrawn, so `question.json` goes. */
  withdrawQuestion(ferret: string): Promise<void>;
  /** An ask was answered: the draft of its item goes with it. */
  onAskAnswered(answered: { readonly ferret: string; readonly askId: AskId }): Promise<void>;
  /** What Ferrets says of a ferret's phase, for `turn.ended`. */
  readonly turns: { look(ferret: string, phase: TurnPhase): void; forget(ferret: string): void };
  /** The question watch: one look at a ferret (a state change), and what is forgotten about a ferret that stopped. */
  readonly questions: { look(ferret: string): void; forget(ferret: string): void };
  stop(): void;
}

/**
 * Part a of Conversation's daemon half: the queue, the send ledger, questions, turns and the shared draft, on the
 * kernel's state, clock, events and ids. A send and an interrupt go through Ferrets' harness seam, which answers a
 * closed refusal for a send and presses the harness's own stop key (`deps.gate` can still hold either back, 503).
 * The composer actions, a send's cancel and Enter, and answering a question's form (the structured-question drive over
 * the harness's form seam) are wired too. What is not (a send's explicit retry, the harness's own compact-at setting) is
 * wired to a refusal that says so; the queue, the ledger reads, the shared draft and its stream are real.
 */
export function buildConversationA(deps: {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
  readonly asks: Pick<AsksApi, 'get'>;
  readonly hooks: Pick<HookInvoker, 'observe' | 'transform'>;
  /** Which of the harness seam's two actions are live (see {@link HarnessGate}). */
  readonly gate: HarnessGate;
  /** The stored originals a send may name (part b's store). Absent: a send that names a file is refused. */
  readonly attachments?: AttachmentSource;
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
   * the structured-question drive (`answering`, below), which types through the harness's form seam the same way.
   */
  const terminal = terminalSeam(ferrets);
  /**
   * THE ONE LANE PER FERRET (as today's `serial.run(id, …)`): a typed send, a send-now's stop, cancel, Enter, the person's
   * draft, the tracker's re-submit and an interrupt all run one at a time on a ferret, so a Cancel can never clear a
   * message while its typing is still between paste and Enter, and a stop never lands between two keys of a send.
   */
  const lane = new KeyedSerialExecutor();
  /**
   * The whose-turn watcher's last word per ferret (today's `turnState` / `turnStateAt`): `working` or `idle`, and the instant
   * it last CHANGED. Fed by every look Ferrets' phase gets ({@link ConversationAHalf.turns}); the tracker's "a turn started
   * after this send" guard reads it, so a send the transcript matcher missed but the agent took is held, not typed twice.
   */
  const turnStates = new Map<SessionId, { readonly state: 'working' | 'idle'; readonly at: string }>();
  /** One ferret as the send path reads it; a ferret Ferrets does not know is 404. */
  const readTarget = async (id: SessionId): Promise<SendTarget> => {
    const ferret = await ferrets.get(id);
    if (ferret === undefined) throw new SessionSendError('not_found', `session not found: ${id}`);
    const question = await askedQuestion(id);
    const watched = turnStates.get(id);
    return {
      id,
      status: statusOf(ferret),
      mode: ferret.mode ?? 'auto',
      // The send policy names today's two families (`claude`, `codex`); Ferrets' key for the first is `claude-code`.
      harness: harnessFamily(ferret.harness),
      // Ferrets keeps no turn count (turns are named by when they began), so none is claimed.
      turn: 0,
      ...(watched === undefined ? {} : { turnState: watched.state, turnStateAt: watched.at }),
      ...(question === undefined ? {} : { pendingQuestion: { toolUseId: question.toolUseId } }),
    };
  };
  /**
   * TODAY'S INTERRUPT (`SessionInterrupt`, the session layer's `interruptLocked`) over Ferrets' harness stop. The
   * session's own refusals come first — an unconfirmed shutdown, a pending structured question (`question.json`), a
   * ferret with no running turn — so the harness is never asked to press at a question; the harness then presses its
   * own stop key under its own rule, and says whether the pane still shows work, which decides `awaiting_user` (an
   * interactive pane handed back) from `interrupted`.
   */
  const interrupts = new SessionInterrupt({
    serial: lane,
    repository: {
      read: readTarget,
      transition: async (id, change) => {
        // The round the stop ended ends as interrupted, whichever way the ferret then settles (a round in progress
        // only: a stop at an idle ferret interrupted no round).
        boundaries.markInterrupted(id);
        return { id, status: change.status ?? 'interrupted', mode: 'auto', turn: 0 };
      },
    },
    stopTurn: async id => await (await terminal.bind(id)).interrupt(),
  });
  /**
   * TODAY'S SEND-PATH ACTS on a send already made (`SessionSendService`: cancel, Enter, the person's draft, the tracker's
   * re-submit), over the ferret's terminal through the harness seam (`harnessSendTerminal`, so every key is the runner's
   * own act on the exact pane). They share the ledger the send writes and the one lane per ferret (`lane`, above). What is NOT wired is what
   * only a TYPING send needs — the turn documents, the revive and the declared wait — so those ports refuse; the
   * service's `send` and `reattempt` are not called from here (a send is `typeMessage`, below).
   */
  const unwiredTyping = (): never => pending(SEND_PATH_UNWIRED);
  /** The ferret's turn documents and the files Ferrets writes for it; none when Ferrets offers none (or refuses the look). */
  const turnsOf = async (ferret: SessionId) => await ferrets.turns?.(ferret).catch(() => undefined);
  /**
   * The send path's turn store, over Ferrets' writer: the act that presses Enter (a person's, the Warden's, the tracker's
   * re-submit) starts the turn a typed pointer named, and that clears the markers the turn that ended left. The numbered
   * writers belong to a TYPING send, which this host does not run through the service (see {@link typeMessage}), so they
   * refuse as before.
   */
  const turnStore: SendTurnStore = {
    writeTurn: unwiredTyping,
    writeQueuedPayload: unwiredTyping,
    clearMarkers: async id => {
      await (await turnsOf(id))?.clearMarkers?.();
    },
  };
  /** The send path's pane look and composer acts over the harness seam; the send-now reads the pane through it. */
  const lookAtPane = harnessSendTerminal(ferrets);
  /** What the send path's acts and the tracker read of a ferret, and the journal they write (one object, shared). */
  const sendRepository = {
    read: async (id: SessionId) => await readTarget(id).catch(() => undefined),
    resolveSender: async () => undefined,
    // Names and ids only: an act's outcome, never a message's words, a refusal's sentence or a person's draft. Only
    // the keys of JOURNAL_LOG_KEYS are kept, so a field a later event adds is never logged by default.
    journal: async (id: SessionId, event: string, data: Readonly<Record<string, unknown>>) => {
      const fields: Record<string, string | number | boolean> = { ferret: id };
      for (const key of JOURNAL_LOG_KEYS) {
        const value = data[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fields[key] = value;
      }
      kernel.log.info(event, fields);
    },
    // Ferrets' turn watch owns whose turn it is; an act here changes no state of its own.
    transition: readTarget,
  };
  /**
   * THE SEND TRACKER (#45(c), today's `SendTracker`): only proof moves a fate. It is event-driven, never a loop: `track`
   * after each send looks once at `firstCheckMs`, each look schedules the next only for a send still open (at that
   * send's own deadline), a ledger read asks for a bounded look first ({@link lookBeforeReading}), a ferret's turn
   * boundary asks for one, and `arm` re-derives every send at boot, one ferret at a time. Its own lane, so a look that
   * reads a whole transcript never holds the ferret's send lane. The proof is the transcript (`EntriesSendEvidence`,
   * through Ferrets' harness seam) and the pane (`lookAtPane`).
   */
  /** The ferrets at boot: all `arm` walks. A ferret made later is looked at by its own sends (`track`), never by the walk. */
  const roster = new Set<SessionId>();
  /**
   * The ledger as the tracker reads it: the words a send is looked for by are MASKED the way the harness plugin hands the
   * transcript back (a secret the vault holds reads masked there), so a message that carried one still matches its own
   * record. Without this a delivered message would be proven "absent" and typed a second time. Writes pass through untouched.
   */
  const trackedLedger: Pick<typeof ledger, 'list' | 'settle'> = {
    settle: async (id, sendId, patch) => await ledger.settle(id, sendId, patch),
    list: async id => {
      const records = await ledger.list(id);
      return await kernel.redaction.read(scope =>
        records.map(record => ({
          ...record,
          message: scope.text(record.message),
          ...(record.matchText === undefined ? {} : { matchText: scope.text(record.matchText) }),
        })),
      );
    },
  };
  /**
   * The pane as the tracker looks at it. The tracker holds the MASKED words of a send (the transcript is masked), but the
   * pane is not: a send that carried a secret would be seen nowhere. So the pane is asked for the row's own words, found
   * by the masked ones the tracker names.
   */
  const trackedPane: Pick<SendTerminal, 'observe' | 'heldAt'> = {
    observe: async id => await lookAtPane.observe(id),
    heldAt: async (id, text) => {
      const records = await ledger.list(id);
      const own = await kernel.redaction.read(scope =>
        records.find(record => record.matchText !== undefined && scope.text(record.matchText) === text),
      );
      return await lookAtPane.heldAt(id, own?.matchText ?? text);
    },
  };
  const tracker = new SendTracker(
    {
      ledger: trackedLedger,
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
      terminal: trackedPane,
      repository: sendRepository,
      attempts: {
        reattempt: async (id, sendId) => await sendActs.reattempt(id, sendId, { by: 'daemon' }),
        resubmit: async (id, sendId) => await sendActs.resubmit(id, sendId),
      },
      // A failed peer send is not told to its sender yet: the sender's id and the send's are logged, nothing else.
      notifier: {
        notify: async (sender, recipient, record) => {
          kernel.log.info('send.failed', { ferret: recipient, sendId: record.sendId, sender, fate: record.fate });
        },
      },
      scheduler,
      roster: { sessions: () => [...roster] },
      serial: new KeyedSerialExecutor(),
      clock,
    },
    defaultSendTrackerSettings,
  );
  /**
   * Armed once at boot: every ferret's open sends are re-derived from the transcript, one ferret at a time, so a daemon
   * that restarted with sends in flight settles them instead of leaving them `accepted` for good. Nothing is retyped
   * here (a retype is the tracker's own, and only for a send proven absent). Disarmed by {@link ConversationAHalf.stop};
   * a roster that cannot be read arms nothing (the sends are then re-derived the first time a read or a send asks).
   */
  let stopped = false;
  let disarm: (() => void) | undefined;
  void (async () => {
    const all = await ferrets.list();
    if (stopped) return;
    for (const summary of all) roster.add(parseSessionId(summary.id));
    disarm = tracker.arm();
  })().catch(() => undefined);
  const sendActs: SessionSendService = new SessionSendService(
    {
      repository: sendRepository,
      ledger,
      terminal: lookAtPane,
      turns: turnStore,
      channel,
      gate: { launching: () => false, awaitSettled: async () => true },
      // A send that revives is `reviveLocked`'s (below), not the service's; the service's acts never revive.
      reviver: { revive: unwiredTyping },
      peerWaits: { endPeerWait: async () => undefined },
      serial: lane,
      clock,
      tracking: tracker,
    },
    defaultSessionSendSettings,
  );
  /**
   * Stops the ferret's turn and answers its view, with the status the stop really left (`interrupted`, or
   * `awaiting_user` for an interactive pane handed back to its person). A closed gate answers before anything is read.
   */
  const interruptFerret = async (ferret: string): Promise<SessionView> => {
    if (!gate.interrupt) return pending(INTERRUPT_UNAVAILABLE);
    const after = await interrupts.interrupt(parseSessionId(ferret)).catch(sendRefusal);
    return { id: after.id, status: after.status, turn: after.turn, health: 'idle' };
  };
  /**
   * Whether a send may be typed at all, before its text is prepared, opened or kept (a repeat of a kept id is answered
   * without it). A closed gate refuses it. A send-now is refused while the interrupt gate is closed, as it presses a stop
   * key. Files and every label type: files are handed to the agent first ({@link deliverAttachments}), and an `fyi` is
   * typed at once under its banner like any other label.
   */
  const mayGo = (request: Omit<UnwiredSend, 'origin'>): void => {
    if (!gate.send) pending(SEND_UNAVAILABLE);
    // A send-now presses a stop key: with the interrupt gate closed (a stop could quit the agent) it presses nothing, so
    // it types nothing either.
    if (request.now === true && !gate.interrupt) pending(INTERRUPT_UNAVAILABLE);
  };
  /** Said when a send names a file this daemon has no store for. */
  const NO_ATTACHMENTS = 'this daemon cannot take attachments with a send: the plugin that owns them is off';
  /**
   * THE FILE HAND-OFF (v4 `deliverAttachments`). Each named stored original is read back through the store (which
   * re-checks its digest against the manifest, and finds only THIS ferret's) and written, by the ferret's harness seam,
   * into the ferret's OWN session `attachments/` folder (`0700`; `0600` per file): the one place an agent reads a file it
   * is sent without asking. Each file sits in a folder named by its FULL attachment id (v4's layout), under the file's own name reduced to
   * plain characters: two different files of one name never overwrite each other (an eight-character digest prefix
   * could alias two ids) and the same file twice is one path. Answers
   * the paths and types the message then lists. A file that is not this ferret's, or cannot be handed over, refuses the
   * whole send (400 `invalid`) BEFORE anything is typed, because "see the screenshot" with no screenshot is the worse
   * outcome. Nothing of the file but its path and type reaches the pane or the log.
   */
  const deliverAttachments = async (
    ferret: SessionId,
    ids: readonly string[] | undefined,
  ): Promise<readonly DeliveredAttachment[]> => {
    const wanted = [...new Set(ids ?? [])];
    if (wanted.length === 0) return [];
    const refuse = (why: string): never => {
      throw new SessionSendError('invalid', `an attached file could not be handed to the agent: ${why}`);
    };
    const source = deps.attachments;
    if (source === undefined) return refuse(NO_ATTACHMENTS);
    const files: { name: string; folder: string; contents: Uint8Array; mime: string }[] = [];
    for (const id of wanted) {
      const found = await source.download(ferret, id).catch((error: unknown) => {
        return refuse(error instanceof Error ? error.message : 'it could not be read');
      });
      files.push({
        name: deliveredFilename(found.attachment.filename),
        folder: found.attachment.id,
        contents: found.bytes,
        mime: found.attachment.mime,
      });
    }
    const harness = await ferrets.harness?.(ferret).catch(() => undefined);
    if (harness?.deliverFiles === undefined) return refuse("this ferret's files cannot be written from here");
    const paths = await harness
      .deliverFiles(files.map(({ name, folder, contents }) => ({ name, folder, contents })))
      .catch(() => refuse('they could not be written'));
    return files.map((file, at) => ({ path: paths[at] as string, mime: file.mime }));
  };
  /**
   * THE TEXT THE AGENT READS (today's `payload()`): the message, trimmed, and — when a FERRET sent it — the protocol's
   * peer banner first, naming the sender and its label. A ferret reads only the message text, so attribution must live
   * in it: without the banner every peer message reads as the owner speaking, and a ferret that cannot tell a peer from
   * its owner cannot judge whether to comply, push back or escalate. The app reads the same banner back
   * (`parsePeerEnvelope`) to show the message as FROM that ferret.
   *
   * Added AFTER `message.before-send`, so no transform can drop or reword it. The sender's name is its ferret name; a
   * sender Ferrets cannot find now is still named by its id (the caller was proved to be that ferret), never dropped
   * to the owner's voice. The recipient is read only to tell a REPLY it is parked on from a new message; one that
   * cannot be read degrades to the plainer kind rather than failing the send. A ferret sending to itself gets none.
   */
  const typedText = async (
    ferret: SessionId,
    request: Pick<UnwiredSend, 'label' | 'replyExpected'> & {
      readonly message: string;
      readonly senderSessionId?: string | undefined;
    },
  ): Promise<{ readonly text: string; readonly fromName?: string }> => {
    const message = payloadOf(request.message);
    const senderId = request.senderSessionId;
    if (senderId === undefined || senderId === ferret) return { text: message };
    const parsed = tryParseSessionId(senderId);
    const [from, recipient] = await Promise.all([
      parsed === undefined ? undefined : ferrets.get(parsed).catch(() => undefined),
      ferrets.get(ferret).catch(() => undefined),
    ]);
    const sender = { id: parsed ?? (senderId as SessionId), ...(from === undefined ? {} : { teammate: from.name }) };
    const kind = peerMessageKind(recipient, senderId, request.replyExpected === true);
    const banner = peerPreamble(sender, kind, defaultSessionSendSettings.clientName, bannerLabel(request.label));
    return { text: `${banner}${message}`, ...(from === undefined ? {} : { fromName: from.name }) };
  };
  /**
   * TODAY'S TWO TRANSPORTS: typed at the prompt, or — when the agent is still working on its turn — put in the harness's
   * own queue, which submits it at the next turn boundary (today's busy path, `routeSend` → `queue`). The queue is
   * tried ONCE and only after `deliver` proved it typed NOTHING (`PaneBusy`), so a message cannot reach the pane twice.
   * A runner that cannot queue, or a long message whose file could not be written, typed nothing and leaves the busy
   * refusal standing (the same send may go again). `sendId` names the send row, so a message that goes by file is
   * `channel/queued-<sendId>.md`. `onQueue` is told before the first key of the queue.
   */
  const deliverOrQueue = async (
    bound: Awaited<ReturnType<typeof terminal.bind>>,
    text: string,
    sendId: string,
    onQueue: () => Promise<string | undefined>,
  ): Promise<QueueOutcome | undefined> => {
    try {
      await bound.deliver(text);
      return undefined;
    } catch (error) {
      if (!(error instanceof PaneBusy)) throw error;
      // What the queue is typed: the message, or — for a long one — the pointer to the file written (and ledgered) first.
      // `undefined` types nothing: a file that could not be written leaves the busy refusal standing.
      const queued = await onQueue();
      if (queued === undefined) throw error.answer;
      const outcome = await bound.queue(queued, sendId);
      if (outcome === undefined) throw error.answer;
      return outcome;
    }
  };
  /**
   * TODAY'S SEND-NOW STOP (`locked`: `request.now === true && first.activeWork`, after `observe` and `refuseWhileParked`).
   * The pane is READ before any key, and the stop key is pressed only for a pane that is busy and nothing else:
   *  - a pane Codex holds a submission on until startup ends is PENDING (nothing pressed, nothing typed);
   *  - an idle pane is not pressed: nothing is running, and the pane may be parked on a prompt the stop would answer;
   *  - a pane behind a blocking prompt (a permission, a picker) is not pressed: Escape would answer it for the person;
   * Where it does not press, the send goes on as any send does, and the delivery decides (type, queue, or refuse).
   * A ferret holding a pending structured question never reaches here: {@link refuseWhileAsking} refuses every send to it
   * first. That check reads `question.json`, which the question watch writes from the hook's file for a Claude Code ferret
   * (one question or a tabbed form of several). A Codex `request_user_input` is not detected (no hook; see the
   * claude-code line in `ports-pending.json`), so for Codex only this pane read stands between a send-now and a form.
   */
  const stopForNow = async (ferret: SessionId, bound: Awaited<ReturnType<typeof terminal.bind>>): Promise<void> => {
    const pane = await lookAtPane.observe(ferret);
    // Pending, as the route and the port answer a launch still in flight (503 `session_launching`).
    if (pane.startupParked === true) throw new SessionSendError('pending', startupParkedPending(ferret).message);
    if (!pane.activeWork || pane.blockingPrompt !== undefined) return;
    await bound.stopActive();
  };
  /**
   * TODAY'S `authorizeSend` REFUSAL, for every send (plain or now): a ferret holding an unanswered structured question
   * is showing a form, not a composer, and typing prose into it selects whichever option the keys land on. Nothing is
   * typed, nothing is kept, and the sentence is today's (`SendUnavailable`, answered as the route answers every
   * session-side refusal: 409 `send_refused`). Live for every Claude Code question the watch has stored (see {@link stopForNow}).
   */
  const refuseWhileAsking = async (ferret: SessionId): Promise<void> => {
    try {
      authorizeSend(await readTarget(ferret), []);
    } catch (error) {
      sendRefusal(error);
    }
  };
  /**
   * Types one message. The send is ledgered as accepted BEFORE a key goes (the same id twice is one message), and a
   * refusal that typed nothing takes the record back so the id may start over. A send that was typed and not proven is
   * settled `unaccounted` and answered `send_unconfirmed` with its id, never typed again; a runner failure nobody could
   * classify keeps the record as it is, because what reached the pane is uncertain. Proof that the harness took it is
   * the tracker's, so a delivered send's fate stays `accepted` here. A send to a ferret still working on its turn goes
   * to the harness's own queue ({@link deliverOrQueue}): `queued` once the pane shows it held there.
   */
  type TypedSend = UnwiredSend & {
    readonly message: string;
    readonly sendId: string;
    readonly senderSessionId?: string | undefined;
    /** The Warden is speaking (`ConversationCaller` `warden`): typed bare, recorded as the daemon's own. */
    readonly warden?: true;
  };
  /** One typed send on the ferret's one lane ({@link lane}): nothing else presses a key on this ferret meanwhile. */
  const typeMessage = async (ferret: SessionId, request: TypedSend): Promise<SendResult> => {
    try {
      return await lane.run(ferret, async () => await typeLocked(ferret, request));
    } finally {
      // Every transport finished (or refused), tracked or not: the tracker looks once soon, and again only for a send
      // that is still open (a ferret with nothing in flight costs one ledger read).
      tracker.track(ferret);
    }
  };
  /** Said when the turn document a message goes by could not be written: nothing is typed or kept. */
  const TURN_NOT_WRITTEN = 'the message could not be written for the agent to read, so nothing was typed. Try again';
  /**
   * TODAY'S `deliver` (#45(b)): the message becomes the next numbered turn document (`turns/turn-NNN.md`, by Ferrets'
   * writer), on both transports; then it is typed in full when {@link isDirectSend} says so (a one-line message under the
   * ceiling, or a multi-line one pasted whole into Claude Code up to `directPasteMaxChars`), and otherwise ONLY the
   * pointer to that file is typed, so a long or peer message never rides the composer as a paste it can mangle.
   *
   * It is written only for a pane that is free to take it: a pane the ONE look shows mid-turn (or one that cannot be
   * read) is the queue's, where no turn starts (today's `routeSend`). A pane that turns busy between the look and the
   * typing leaves a document nobody was pointed at; its number stays on the send's row, so the owner's words count it once.
   * Without a writer on this daemon's Ferrets the message is typed as it is.
   */
  const turnDocument = async (
    ferret: SessionId,
    text: string,
    by: FerretTurnAuthor | undefined,
  ): Promise<{ readonly typed: string; readonly path: 'direct' | 'turn-file'; readonly turn?: number }> => {
    const inline = { typed: text, path: 'direct' } as const;
    const turns = await turnsOf(ferret);
    if (turns?.write === undefined) return inline;
    const target = await readTarget(ferret);
    const pane = await lookAtPane.observe(ferret).catch(() => undefined);
    if (pane === undefined || routeSend(target, pane) !== 'idle' || paneMidTurn(target, pane)) return inline;
    // The author rides beside the document, so the owner's words never include a peer's or the Warden's.
    const written = await turns
      .write({ document: `${text}\n`, ...(by === undefined ? {} : { by }) })
      .catch(() => undefined);
    if (written === undefined) throw new SessionSendError('failed', TURN_NOT_WRITTEN);
    return isDirectSend(target, text, defaultSessionSendSettings)
      ? { typed: text, path: 'direct', turn: written.turn }
      : { typed: turnInstruction(written.file), path: 'turn-file', turn: written.turn };
  };
  /**
   * The text the harness's own queue is typed for a message that met a busy pane (#45(c), BG-053; today's `queue`): the
   * message as it is, or — over {@link isFileBackedQueue}'s ceiling — the pointer to `channel/queued-<send id>.md`, which is
   * WRITTEN FIRST and the row REVISED to `native-file` (matchText = the pointer, payloadFile = the path) before any key, so
   * the tracker, the stranded-pointer guard and the Warden look for exactly what the pane holds. `undefined`: nothing may be
   * typed (a file that could not be written, a row that could not be revised): the busy refusal stands.
   */
  const queuedText = async (
    ferret: SessionId,
    sendId: string,
    text: string,
    sent: { readonly path: 'direct' | 'turn-file' },
  ): Promise<{ readonly typed: string; readonly path: SendPath } | undefined> => {
    const filing = isFileBackedQueue(text, defaultSessionSendSettings)
      ? (await turnsOf(ferret))?.writeQueued
      : undefined;
    if (filing === undefined) {
      // Typed as it is. A turn pointer the row names (the pane turned busy after the document was written) is not what
      // goes into the queue, so the row says what does.
      if (sent.path === 'direct') return { typed: text, path: 'native-inline' };
      const revised = await ledger
        .revise(ferret, sendId, { path: 'native-inline', matchText: text })
        .catch(() => undefined);
      return revised === undefined ? undefined : { typed: text, path: 'native-inline' };
    }
    const file = await filing(sendId, text).catch(() => undefined);
    if (file === undefined) return undefined;
    const pointer = queuedPayloadInstruction(file);
    const revised = await ledger
      .revise(ferret, sendId, { path: 'native-file', matchText: pointer, payloadFile: file })
      .catch(() => undefined);
    return revised === undefined ? undefined : { typed: pointer, path: 'native-file' };
  };
  /** What the row of a send is made of, whichever way it travels: who sent it, what it said, and when. */
  const accepting = async (
    ferret: SessionId,
    request: TypedSend,
    text: string,
    fromName: string | undefined,
    shape: { readonly path: SendPath; readonly matchText?: string; readonly turn?: number },
  ) => {
    const at = kernel.clock.now();
    return await ledger.accept(ferret, {
      sendId: request.sendId,
      acceptedAt: at,
      acceptedTurn: 0,
      path: shape.path,
      // What the agent reads, banner and all, as today's ledger keeps it: the row is the record of what was typed.
      message: text,
      ...(shape.matchText === undefined ? {} : { matchText: shape.matchText }),
      ...(shape.turn === undefined ? {} : { turn: shape.turn }),
      fate: 'accepted',
      attempt: 1,
      attemptAt: at,
      senderKind: request.warden === true ? 'daemon' : request.senderSessionId === undefined ? 'human' : 'agent',
      // The Warden's words are Ferretry's own, shown as such (the sender chip reads `by`), as today's remedies were.
      ...(request.warden === true ? { by: { kind: 'ferretry' as const, feature: 'Warden' } } : {}),
      ...(request.senderSessionId === undefined ? {} : { from: request.senderSessionId }),
      ...(fromName === undefined ? {} : { fromName }),
    });
  };
  /** Said when a send meant to revive a ferret handed the relaunch nothing to type: the id may go again. */
  const NOT_CARRIED =
    'the ferret came up, or could not be handed a turn, before this message was carried to it, so nothing was typed. Send it again';
  /**
   * TODAY'S REVIVE-ON-SEND (`SessionSendService.revive`): a send to a ferret that has stopped relaunches it with the message
   * as its first turn. The row is accepted as `revive` BEFORE the relaunch (the same id twice is one message), Ferrets
   * writes the message to the next numbered turn document and types the pointer at it, and tells this send what it typed
   * (`onCarried`): that pointer, not the message, is what the transcript will record, so the row is settled to look for
   * it (and for that turn) from then on. A relaunch Ferrets refuses, or one that carried nothing, typed nothing: the row
   * is taken back and the id starts over.
   */
  const reviveLocked = async (ferret: SessionId, request: TypedSend): Promise<SendResult> => {
    const { text, fromName } = await typedText(ferret, request);
    const repeated = await keptSend(ferret, request.sendId);
    if (repeated !== undefined) return repeated;
    const accepted = await accepting(ferret, request, text, fromName, { path: 'revive' });
    if (!accepted.created) return { ferret, disposition: 'sent' };
    const told: { typed?: { readonly text: string; readonly turn: number } } = {};
    const resumed = await ferrets
      .resume(ferret, text, {
        // The origin of the send itself: the credential's, carried from the route or the port, so a revive keeps it.
        origin: request.origin,
        onCarried: typed => {
          told.typed = typed;
        },
        // Attribution only (the author beside the revive's turn): the Warden, else a ferret's send; the owner's names none.
        ...(request.warden === true
          ? { actor: 'warden' as const }
          : request.senderSessionId === undefined
            ? {}
            : { actor: 'peer' as const }),
      })
      .catch((): undefined => undefined);
    if (told.typed === undefined) {
      await ledger.withdraw(ferret, request.sendId, 'nothing was typed').catch(() => undefined);
      throw new SessionSendError(
        'refused',
        resumed?.ok === false ? `the ferret could not be revived: ${resumed.error.reason}` : NOT_CARRIED,
      );
    }
    await ledger.settle(ferret, request.sendId, {
      matchText: told.typed.text,
      turn: told.typed.turn,
      attemptAt: kernel.clock.now(),
    });
    return { ferret, disposition: 'revived', sendId: request.sendId, fate: 'accepted' };
  };
  const typeLocked = async (ferret: SessionId, request: TypedSend): Promise<SendResult> => {
    // A ferret that has stopped has no pane to type into: the message revives it (see {@link reviveLocked}).
    if (TERMINAL_SEND_STATUSES.has((await readTarget(ferret)).status)) return await reviveLocked(ferret, request);
    // Opened BEFORE the record: an unknown ferret or a seam that is off types nothing and keeps nothing. No caller goes
    // to Ferrets: a send has no target rule (the path names where it goes, as for every caller); a ferret is a SENDER.
    const bound = await terminal.bind(ferret);
    await refuseWhileAsking(ferret);
    const { text, fromName } = await typedText(ferret, request);
    // SEND-NOW: the turn is stopped FIRST and BEFORE the record exists: a stop that is refused (a hold, a gone pane, a
    // runner that cannot stop) types nothing and keeps nothing, so the id starts over. The pane is READ before any key.
    if (request.now === true) await stopForNow(ferret, bound);
    // A repeat of a send that already has a live row types nothing and writes no document: no orphan for the owner's words.
    const repeated = await keptSend(ferret, request.sendId);
    if (repeated !== undefined) return repeated;
    // The turn document first (today's order): a message that goes by file has its pointer, which the row must name.
    const sent = await turnDocument(
      ferret,
      text,
      request.warden === true
        ? { kind: 'ferretry', feature: 'Warden' }
        : request.senderSessionId === undefined
          ? undefined
          : { kind: 'ferret', ...(fromName === undefined ? {} : { name: fromName }) },
    );
    // What the transcript will hold is the message, or the pointer typed for it.
    const accepted = await accepting(ferret, request, text, fromName, {
      path: sent.path,
      matchText: sent.typed,
      ...(sent.turn === undefined ? {} : { turn: sent.turn }),
    });
    if (!accepted.created) return (await keptSend(ferret, request.sendId)) ?? { ferret, disposition: 'sent' };
    /** Set once the message went to the harness's own queue: the row's path is then today's busy path. */
    let viaQueue = false;
    let busyPath: { readonly path: SendPath; readonly busyTyped: true } = { path: 'native-inline', busyTyped: true };
    let queued: QueueOutcome | undefined;
    try {
      queued = await deliverOrQueue(bound, sent.typed, request.sendId, async () => {
        viaQueue = true;
        const going = await queuedText(ferret, request.sendId, text, sent);
        if (going !== undefined) busyPath = { path: going.path, busyTyped: true };
        return going?.typed;
      });
      // Still in the composer after the submit and queue keys: the TUI will not send it at the turn's end by itself.
      if (queued === 'typed') throw new Unconfirmed(true);
    } catch (error) {
      if (error instanceof MaybeTyped) throw error.answer;
      if (error instanceof Unconfirmed) {
        // Typed, not proven: never withdrawn (that would invite a second copy), settled so a retry of this id says so.
        // A settle that fails leaves the row `accepted`, which a retry of this id would read as sent: that is the
        // uncertain 500 instead (the record is kept, nothing is typed again), never a quiet unconfirmed answer.
        await ledger
          .settle(ferret, request.sendId, {
            fate: 'unaccounted',
            fateAt: kernel.clock.now(),
            unaccountedReason: 'landing_unconfirmed',
            ...(error.stranded ? { typedNotSent: true } : {}),
            ...(viaQueue ? busyPath : {}),
          })
          .catch(() => {
            throw new SessionSendError('failed', `${error.message}. ${UNSETTLED_SENTENCE}`);
          });
        throw new SessionSendError('unconfirmed', error.message, undefined, request.sendId);
      }
      await ledger.withdraw(ferret, request.sendId, 'nothing was typed').catch(() => undefined);
      throw error;
    }
    if (queued === undefined) {
      // The prompt is in: the completion markers the turn that just ended left belong to it, not to this one (today's
      // `turnStarted`). A marker that cannot be cleared never fails a send that already landed.
      if (sent.turn !== undefined) await (await turnsOf(ferret))?.clearMarkers?.().catch(() => undefined);
      return { ferret, disposition: 'sent', sendId: request.sendId, fate: 'accepted' };
    }
    // In the harness's queue. `held` is proved by the pane (today's `queued`, proof `pane`); `left` left the composer
    // and no queue shows it, so it stays `accepted` (only a transcript can say where it went). A settle that fails is
    // deliberately NOT surfaced, unlike the unconfirmed settle above: the message IS in the harness's queue, and an
    // error would invite the caller to send it again under a new id, a second copy. The row then stays `accepted` on
    // the direct path, so a repeat of this id is answered as a typed direct send (`delivered`, fate `accepted`, not `queued`) and types
    // nothing (tested).
    const held = queued === 'held';
    const settledAt = kernel.clock.now();
    await ledger
      .settle(ferret, request.sendId, {
        ...busyPath,
        ...(held ? { fate: 'queued', fateAt: settledAt, queuedAt: settledAt, queueProof: 'pane' } : {}),
      })
      .catch(() => undefined);
    return {
      ferret,
      disposition: dispositionOf(busyPath.path, held),
      sendId: request.sendId,
      fate: held ? 'queued' : 'accepted',
    };
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
    // A send typed and not proven is answered as it was the first time: unconfirmed, with its id, never `sent`.
    if (isUnconfirmedTyping(row)) throw new SessionSendError('unconfirmed', UNCONFIRMED_AGAIN, undefined, sendId);
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
  /** What the owner said to a ferret: the queue, the send ledger and its turn documents (Ferrets reads them back). */
  const ownerWords = new OwnerWordsReader({
    queue,
    sends: ledger,
    turns: { list: async (id, options) => (await (await turnsOf(id))?.list(options)) ?? [] },
    // An unknown ferret (one the registry has since removed) was not started by a ferret, as today's parent lookup answers.
    startedByFerret: async id => (await ferrets.get(id))?.parent !== undefined,
  });

  const queueMessages = async (id: string): Promise<readonly QueuedMessage[]> => await queue.list(parseSessionId(id));
  const queueFailure = (error: unknown): never => {
    if (error instanceof QueueRefused)
      throw new SessionSendError(error.refusal === 'not_found' ? 'not_found' : 'refused', error.message);
    throw error;
  };
  /**
   * A READ IS A LOOK — BOUNDED (today's `lookBeforeReading`): asking where a send went asks the tracker to look first, and
   * answers with the ledger as it is once the look has run for `SEND_READ_LOOK_BUDGET_MS`. A tracker with nothing in flight
   * for the ferret takes no look.
   */
  const lookFirst = async (ferret: SessionId): Promise<void> => {
    await lookBeforeReading(
      tracker,
      ferret,
      async ms =>
        await new Promise<void>(resolve => {
          kernel.clock.after(milliseconds(ms), resolve);
        }),
    ).catch(() => undefined);
  };
  const records = async (id: string): Promise<readonly SendRecord[]> => {
    const parsed = parseSessionId(id);
    await lookFirst(parsed);
    return (await ledger.list(parsed)).map(sendRecordView);
  };
  /** The fates a waiting caller stops at: where a send has SETTLED, one way or the other (the CLI's own list). */
  const SETTLED_FATES: ReadonlySet<string> = new Set(['delivered', 'timed_out', 'unaccounted', 'cancelled']);
  /** How often a waiting `sendStatus` reads the ledger again; the tracker's own looks are what settle a fate. */
  const WAIT_READ_MS = 1_000;
  /** How many sends one caller may wait on at once, and how many waiters this daemon holds in all. */
  const MAX_WAITERS_PER_CALLER = 8;
  const MAX_WAITERS = 64;
  /** The waiters now parked (`fy send --wait`): one per caller and send, each ended when the daemon stops. */
  const waiters = new Map<string, { readonly caller: string; end(): void }>();
  /** The send's row after a bounded look, or `undefined` when it has none: not in the ledger, not in Ferretry's queue. */
  const statusNow = async (ferret: SessionId, sendId: string): Promise<SendRecord | undefined> => {
    await lookFirst(ferret);
    return sendRecordFor(await ledger.list(ferret), await queue.list(ferret), sendId);
  };
  const noSuchSend = (sendId: string): SessionSendError =>
    new SessionSendError('not_found', `no send ${sendId} on this ferret`);
  /**
   * One send's row, optionally HELD until its fate settles or `waitMs` has passed (`fy send --wait`; the shell gives a plugin
   * no clock, so the daemon waits). One waiter per caller and send: a second request for the same pair ends the first
   * (answering the row as it then is), so a caller that retries never stacks waiters; and every waiter ends when the daemon
   * stops. A row that settles is answered at once, and an id that is neither a row nor a message in Ferretry's queue is 404
   * at once, however long the caller asked to wait: nothing is parked for a send that does not exist. The waiters are
   * capped per caller and in all, and the excess is refused (429) with the sentence that says so.
   */
  const awaitStatus = async (
    ferret: SessionId,
    sendId: string,
    options: { readonly waitMs?: number; readonly caller: string } | undefined,
  ): Promise<SendRecord> => {
    let found = await statusNow(ferret, sendId);
    if (found === undefined) throw noSuchSend(sendId);
    if (options?.waitMs === undefined || SETTLED_FATES.has(found.fate)) return found;
    const key = `${options.caller}\u0000${ferret}\u0000${sendId}`;
    const replaced = waiters.get(key);
    // A second request for the same pair takes the first one's place, so it never counts twice.
    if (
      replaced === undefined &&
      (waiters.size >= MAX_WAITERS ||
        [...waiters.values()].filter(w => w.caller === options.caller).length >= MAX_WAITERS_PER_CALLER)
    )
      throw new ApiError(
        429,
        'too many sends are being waited on right now; read the send again without waiting, or try again in a moment',
        'too_many_waiters',
      );
    replaced?.end();
    let over = false;
    let wake: () => void = () => undefined;
    const mine = {
      caller: options.caller,
      end: () => {
        over = true;
        wake();
      },
    };
    waiters.set(key, mine);
    const deadline = kernel.clock.nowMs() + options.waitMs;
    try {
      while (!over && !SETTLED_FATES.has(found.fate) && kernel.clock.nowMs() < deadline) {
        let cancel: () => void = () => undefined;
        await new Promise<void>(resolve => {
          wake = resolve;
          cancel = kernel.clock.after(milliseconds(Math.min(WAIT_READ_MS, deadline - kernel.clock.nowMs())), resolve);
        });
        cancel();
        // A row does not un-exist: a read that finds none keeps the last one.
        if (!over) found = (await statusNow(ferret, sendId)) ?? found;
      }
    } finally {
      if (waiters.get(key) === mine) waiters.delete(key);
    }
    return found;
  };

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
    publishAnswered: async (ferret, toolUseId) => await kernel.events.publish(QuestionAnswered, { ferret, toolUseId }),
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
    asked: async (ferret, toolUseId) => {
      await kernel.events.publish(QuestionAsked, { ferret: parseSessionId(ferret), toolUseId });
    },
    answered: async (ferret, toolUseId) => {
      await kernel.events.publish(QuestionAnswered, { ferret: parseSessionId(ferret), toolUseId });
    },
  });
  let cancelQuestionWatch: (() => void) | undefined;
  const watchQuestions = (): void => {
    if (stopped) return;
    cancelQuestionWatch = kernel.clock.after(milliseconds(QUESTION_WATCH_MS), () => {
      void questionWatch
        .sweep()
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
        sendStatus: async (id, sendId, options) => await awaitStatus(parseSessionId(id), sendId, options),
        queue: queueMessages,
        editQueued: async (id, messageId, text) =>
          await queue.edit(parseSessionId(id), messageId, text).catch(queueFailure),
        cancelQueued: async (id, messageId) => await queue.cancel(parseSessionId(id), messageId).catch(queueFailure),
        retry: async () => pending(),
        cancel: async (id, sendId) =>
          sendRecordView(await sendActs.cancel(parseSessionId(id), sendId).catch(sendActRefusal)),
        submit: async (id, sendId) =>
          sendRecordView(await sendActs.submit(parseSessionId(id), sendId).catch(sendActRefusal)),
        composer: async (id, request) => ({
          action: request.action,
          outcome: await sendActs.resolveDraft(parseSessionId(id), request.action, request.draft).catch(sendActRefusal),
        }),
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
    retrySend: async () => err(pendingRefusal()),
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
    withdrawQuestion: async ferret => {
      questionWatch.forget(ferret);
      await clearAskedQuestion(kernel.state, questionSerial, ferret);
    },
    questions: {
      look: ferret => void questionWatch.look(ferret).catch(() => undefined),
      forget: ferret => questionWatch.forget(ferret),
    },
    onAskAnswered: async ({ ferret, askId }) => {
      await drafts.discard(ferret, askId).catch(() => undefined);
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
      stopped = true;
      cancelQuestionWatch?.();
      disarm?.();
      for (const waiter of [...waiters.values()]) waiter.end();
      scheduler.cancelAll();
    },
  };
}
