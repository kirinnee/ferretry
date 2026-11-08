import { ApiError, type KernelPorts, type RouteHandler, type SocketAccept } from '@ferretry/kernel/contract';
import { type AskId, AskIdSchema, type AsksApi } from '@ferretry/core-asks/contract';
import type { FerretsApi, FerretSummary, QueueOutcome, SitrepLineSource } from '@ferretry/core-ferrets/contract';
import type { HookInvoker } from '@ferretry/kernel/manifest';
import type { Instant } from '@ferretry/std';
import { err, milliseconds, ok } from '@ferretry/std';
import {
  type ConversationApi,
  type ConversationRefusal,
  MessageBeforeSend,
  PEER_MESSAGE_LABELS,
  type PeerMessageLabel,
  QueueChanged,
  type QueuedMessage,
  QUESTION_STATE,
  type Question,
  type SendRecord,
  type SendResult,
  TurnEnded,
} from '../contract/index.ts';
import { ClockSendScheduler, StateSendChannel, StateSendLedger } from './delivery/adapters/index.ts';
import {
  defaultSessionSendSettings,
  dispositionOf,
  peerMessageKind,
  peerPreamble,
  type SendTarget,
  SendRefused,
  SessionInterrupt,
  sendPayload,
  sendRecordFor,
  sendRecordView,
} from './delivery/lib/index.ts';
import type { SessionStatus } from './seams/ferret-types.ts';
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
  PaneBusy,
  SEND_EXTRAS_UNAVAILABLE,
  SEND_UNAVAILABLE,
  terminalSeam,
  Unconfirmed,
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
        not_found: 'not_found',
        refused: 'send_refused',
        pending: 'session_launching',
        unconfirmed: 'send_unconfirmed',
        failed: 'session_send_failed',
      } as Readonly<Record<string, string>>
    )[error.failure] ?? 'send_refused'
  );
};

/** Today's session-layer refusals (`SendRefused` and its kinds), in the send route's taxonomy. */
const sendRefusal = (error: unknown): never => {
  if (error instanceof SendRefused) throw new SessionSendError('refused', error.message);
  throw error;
};

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

/**
 * What a send can carry that the harness seam does not type yet. `label` is read only for `fyi`, the one label that
 * changes WHEN a message goes (held to the turn's end); `action` and `blocker` type at once, as the seam does.
 */
interface UnwiredSend {
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

/** A triage label a peer's banner can carry (the route and the port parse it; anything else carries none). */
const bannerLabel = (label: unknown): PeerMessageLabel | undefined =>
  PEER_MESSAGE_LABELS.find(known => known === label);

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
 * kernel's state, clock, events and ids. A send and an interrupt go through Ferrets' harness seam, which answers a
 * closed refusal for a send and presses the harness's own stop key (`deps.gate` can still hold either back, 503).
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
   * TODAY'S INTERRUPT (`SessionInterrupt`, the session layer's `interruptLocked`) over Ferrets' harness stop. The
   * session's own refusals come first — an unconfirmed shutdown, a pending structured question (`question.json`), a
   * ferret with no running turn — so the harness is never asked to press at a question; the harness then presses its
   * own stop key under its own rule, and says whether the pane still shows work, which decides `awaiting_user` (an
   * interactive pane handed back) from `interrupted`.
   */
  const interrupts = new SessionInterrupt({
    serial: new KeyedSerialExecutor(),
    repository: {
      read: async (id): Promise<SendTarget> => {
        const ferret = await ferrets.get(id);
        if (ferret === undefined) throw new SessionSendError('not_found', `session not found: ${id}`);
        const question = await askedQuestion(id);
        return {
          id,
          status: statusOf(ferret),
          mode: ferret.mode ?? 'auto',
          harness: ferret.harness,
          // Ferrets keeps no turn count (turns are named by when they began), so none is claimed.
          turn: 0,
          ...(question === undefined ? {} : { pendingQuestion: { toolUseId: question.toolUseId } }),
        };
      },
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
   * without it). A closed gate refuses it. And refuses what the harness seam does not type yet: files, an fyi message
   * (held to the turn's end), the send-now flag and a reply request would be dropped, and the send answered `sent` all
   * the same (U3 carries them). A field is refused only when it asks for something: the CLI always sends `now: false`
   * and a label (`action` by default), and those type exactly as the seam types.
   */
  const mayGo = (request: UnwiredSend): void => {
    if (!gate.send) pending(SEND_UNAVAILABLE);
    if (
      (request.attachmentIds?.length ?? 0) > 0 ||
      request.label === 'fyi' ||
      request.now === true ||
      request.replyExpected === true
    )
      pending(SEND_EXTRAS_UNAVAILABLE);
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
   * A runner that cannot queue leaves the busy refusal standing. `onQueue` is told before the first key of the queue.
   */
  const deliverOrQueue = async (
    bound: Awaited<ReturnType<typeof terminal.bind>>,
    text: string,
    onQueue: () => void,
  ): Promise<QueueOutcome | undefined> => {
    try {
      await bound.deliver(text);
      return undefined;
    } catch (error) {
      if (!(error instanceof PaneBusy)) throw error;
      onQueue();
      const outcome = await bound.queue(text);
      if (outcome === undefined) throw error.answer;
      return outcome;
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
  const typeMessage = async (
    ferret: SessionId,
    request: UnwiredSend & {
      readonly message: string;
      readonly sendId: string;
      readonly senderSessionId?: string | undefined;
    },
  ): Promise<SendResult> => {
    // Opened BEFORE the record: an unknown ferret or a seam that is off types nothing and keeps nothing. No caller goes
    // to Ferrets: a send has no target rule (the path names where it goes, as for every caller); a ferret is a SENDER.
    const bound = await terminal.bind(ferret);
    const { text, fromName } = await typedText(ferret, request);
    const at = kernel.clock.now();
    const accepted = await ledger.accept(ferret, {
      sendId: request.sendId,
      acceptedAt: at,
      acceptedTurn: 0,
      path: 'direct',
      // What the agent reads, banner and all, as today's ledger keeps it: the row is the record of what was typed.
      message: text,
      matchText: text,
      fate: 'accepted',
      attempt: 1,
      attemptAt: at,
      senderKind: request.senderSessionId === undefined ? 'human' : 'agent',
      ...(request.senderSessionId === undefined ? {} : { from: request.senderSessionId }),
      ...(fromName === undefined ? {} : { fromName }),
    });
    if (!accepted.created) return (await keptSend(ferret, request.sendId)) ?? { ferret, disposition: 'sent' };
    /** Set once the message went to the harness's own queue: the row's path is then today's busy path. */
    let viaQueue = false;
    const busyPath = { path: 'native-inline', busyTyped: true } as const;
    let queued: QueueOutcome | undefined;
    try {
      queued = await deliverOrQueue(bound, text, () => {
        viaQueue = true;
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
    if (queued === undefined) return { ferret, disposition: 'sent', sendId: request.sendId, fate: 'accepted' };
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
    if (row?.fate === 'unaccounted' && row.unaccountedReason === 'landing_unconfirmed')
      throw new SessionSendError('unconfirmed', UNCONFIRMED_AGAIN, undefined, sendId);
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
        ) => {
          const kept = await keptSend(parseSessionId(id), request.sendId);
          if (kept !== undefined) return kept;
          // Asked before the text is prepared: a refused send runs no `message.before-send` transform.
          mayGo(request);
          return await typeMessage(parseSessionId(id), { ...request, message: await prepared(id, request.message) });
        },
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
        // Asked before an id is minted or the text is prepared: a refused send runs no transform and spends nothing.
        mayGo(request);
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
