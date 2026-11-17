import { basename, dirname } from 'node:path';
import { ApiError, type KernelPorts } from '@ferretry/kernel/contract';
import { type AttachmentSource, EntriesRetractionProof, harnessEntries, statusOf } from '../contract/index.ts';
import {
  AGENT_ORIGIN,
  type FerretsApi,
  type FerretTurnAuthor,
  type LaunchOrigin,
  type QueueOutcome,
} from '@ferretry/core-ferrets/contract';
import { milliseconds } from '@ferretry/std';
import {
  parseMessageAttachments,
  PEER_MESSAGE_LABELS,
  combinedDelivery,
  peerSender,
  type PeerMessageLabel,
  type QueuedMessage,
  type QueueAuthor,
  type SendRecord,
  type SendResult,
} from '../contract/index.ts';
import type { SendMessageRequest } from './lib/delivery/service.ts';
import { CancellableTimers } from './adapters/cancellable-timers.ts';
import type { ClaudeChannel, MailboxRefusal, SendChannel, SendEvidenceSource, SendLedger } from '../contract/index.ts';
import { ClockSendScheduler } from './adapters/index.ts';
import { type QueuedSend, SendPathDeliveryView, SendPathQueueTransport } from './adapters/send-path-delivery.ts';
import { defaultQueueDeliverySettings, QueueDeliverer, Senders } from './lib/queue/index.ts';
import { type LedgerPath as SendPath } from '../contract/index.ts';
import {
  defaultSendTrackerSettings,
  defaultSessionSendSettings,
  dispositionOf,
  handoffView,
  isDirectSend,
  isFileBackedQueue,
  isUnconfirmedTyping,
  paneMidTurn,
  peerMessageKind,
  peerPreamble,
  queuedPayloadInstruction,
  routeSend,
  type SendTarget,
  type SendTerminal,
  type SendTurnStore,
  TERMINAL_SEND_STATUSES,
  turnInstruction,
  authorizeSend,
  SendDraftRefused,
  SendPending,
  SendRefused,
  sendPayload,
  sendRecordFor,
  sendRecordView,
} from '../contract/index.ts';
import {
  lookBeforeReading,
  AgentSendFailureNotifier,
  SendTracker,
  SessionInterrupt,
  SessionSendService,
} from './lib/delivery/index.ts';
import { SessionSendError } from './lib/delivery/mounts/session-send.ts';
import { answerOf } from '../contract/index.ts';
import { QueueRefused, type SessionQueue, type SessionQueueStore } from '../contract/index.ts';
import {
  type HarnessGate,
  INTERRUPT_UNAVAILABLE,
  MaybeTyped,
  PaneBusy,
  SEND_PATH_UNWIRED,
  SEND_UNAVAILABLE,
  terminalSeam,
  Unconfirmed,
  UnreadableComposer,
} from '../contract/lib/send/harness-seam.ts';
import { startupParkedPending } from './lib/delivery/service.ts';
import { type DeliveredAttachment, deliveredFilename } from './lib/attachments-delivery.ts';
import { harnessSendTerminal } from './send-terminal.ts';
import { harnessFamily } from '../contract/index.ts';
import { KeyedSerialExecutor } from '../contract/index.ts';
import { parseSessionId, type SessionId, tryParseSessionId } from '../contract/index.ts';
import type { ClockPort } from '../contract/index.ts';
import type { SessionHandoff, SessionView } from '../contract/index.ts';

/**
 * The note Ferrets ended every revive's turn document with before it stopped writing one (its old `turnProtocolReminder` default); older documents still carry it. Taken off the words a hand-off
 * shows, because it is the daemon's, not the owner's. GAP: Ferrets owns this fact and offers no read of it, so it is
 * mirrored here; a changed Ferrets setting would show the note until that read exists (end-list).
 */
const TURN_PROTOCOL_REMINDER = 'Continue using the same completion and interaction protocol.';

const pending = (sentence: string): never => {
  throw new ApiError(503, sentence, 'conversation_terminal_unavailable');
};

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
export const refusalCode = (error: unknown): string => {
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
export const actRefusal = (error: unknown): MailboxRefusal => ({
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
export const sendActRefusal = (error: unknown): never => {
  if (error instanceof SendPending) throw new SessionSendError('pending', error.message);
  if (error instanceof SendDraftRefused) throw new SessionSendError('refused', error.message, error.draft);
  return sendRefusal(error);
};

/**
 * The journal fields that reach the log: ids and outcome words only. The queue-wait events carry the refusal's sentence
 * in `reason`, and a sentence may quote a prompt or a person's words, so it is not here.
 */
const JOURNAL_LOG_KEYS = ['sendId', 'outcome', 'effect', 'from', 'by', 'turn', 'direct', 'proof'] as const;

/**
 * What a send can carry beyond its text. `attachmentIds` are handed to the agent as files ({@link deliverAttachments}).
 * `label` is the sender's own (`blocker`, `action`, `fyi`): the queue holds and batches by it, and the banner it is typed under
 * names it.
 */
export interface UnwiredSend {
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

/** A triage label a peer's banner can carry (the route and the port parse it; anything else carries none). */
const bannerLabel = (label: unknown): PeerMessageLabel | undefined =>
  PEER_MESSAGE_LABELS.find(known => known === label);

/** What the send half needs of the daemon half that builds it. */
export interface SendHalfDeps {
  readonly kernel: KernelPorts;
  readonly ferrets: FerretsApi;
  readonly gate: HarnessGate;
  /** `message.before-send`: the one place text enters a send, which a taker may reword or refuse. */
  readonly transformMessage: (input: {
    readonly ferret: SessionId;
    readonly text: string;
  }) => Promise<
    { readonly ok: true; readonly value: { readonly text: string } } | { readonly ok: false; readonly error: string }
  >;
  /** Where a stop marks the round it ended as interrupted (the turn boundaries, which Conversation keeps). */
  readonly boundaries: { markInterrupted(ferret: string): void };
  /** The transcript the tracker proves a send by, for the ferret named. */
  readonly evidence: SendEvidenceSource;
  /** One snapshot of the screen a stuck send met, written where the ferret's files are; the path it is kept at. */
  readonly keepFrame: (ferret: SessionId, frame: string) => Promise<string>;
  /** A cheap token for the log of `queue` or `sends` that moves with every line appended; `absent` when there is none. */
  readonly stamp: (log: 'queue' | 'sends', ferret: SessionId) => Promise<string>;
  readonly clock: ClockPort;
  readonly queue: Pick<SessionQueue, 'list' | 'edit' | 'cancel' | 'enqueue'>;
  /** The queue's log, as the deliverer reads and writes it (the one that announces a change). */
  readonly queueStore: SessionQueueStore;
  readonly ledger: SendLedger;
  readonly channel: SendChannel;
  readonly attachments?: AttachmentSource;
  /** Claude's channel (the MCP server's push). Absent: every message is typed. */
  readonly claude?: ClaudeChannel;
  /** `question.json` as the question watch reads it: a send refuses while the ferret waits on one. */
  readonly askedQuestion: (ferret: string) => Promise<{ readonly toolUseId: string } | undefined>;
}

/**
 * THE SEND HALF of Conversation's daemon half: the typing send, the queue's delivery, the send tracker, the acts on a
 * send already made, and the reads of the queue and the ledger. Lifted out of `host.ts` unchanged, behind the ports it
 * was written against, so the next move (into the Mailbox) is a file move.
 */
export function buildSendHalf(deps: SendHalfDeps) {
  const { kernel, ferrets, gate, clock, queue, ledger, channel, askedQuestion, boundaries, keepFrame, stamp } = deps;
  const scheduler = new ClockSendScheduler(kernel.clock);

  /** The one place text enters a send: `message.before-send` may reword it, or refuse it. */
  const prepared = async (ferret: string, message: string): Promise<string> => {
    const out = await deps.transformMessage({ ferret: parseSessionId(ferret), text: message });
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
   * WHAT THE OWNER SENT behind a pointer the transcript records (v4's `handoff` route). The words are read from the very
   * turn document Ferrets wrote (its `turns().list()`, a best-effort read of the ferret's own folder) and shown by
   * the document's written shapes (`handoffView`); a document that is not there is a 404, so the chat says the file
   * is gone only when it is. A queued message (`queued-<send id>`) lives in the ferret's `channel/` folder, which
   * Ferrets offers no read of yet, so it stays unread (GAP, end-list).
   */
  const handoffOf = async (id: string, name: string): Promise<SessionHandoff> => {
    const gone = (): never => {
      throw new SessionSendError('not_found', 'that hand-off document is not there');
    };
    const ferret = tryParseSessionId(id);
    const turn = /^turn-(\d{1,9})$/u.exec(name)?.[1];
    if (ferret === undefined || turn === undefined) return gone();
    const found = (await (await turnsOf(ferret))?.list())?.find(document => document.turn === Number(turn));
    if (found === undefined) return gone();
    // A delivered copy sits at `<session folder>/attachments/<attachment id>/<file name>`: only such a listed file is
    // this ferret's stored attachment (and so a thumbnail); any other keeps its name as a plain chip.
    const delivered = parseMessageAttachments(found.text.replace(/\n$/u, '')).files.find(
      file => basename(dirname(dirname(file.path))) === 'attachments',
    );
    return handoffView(
      name,
      found.text,
      {
        reminder: TURN_PROTOCOL_REMINDER,
        attachmentRoot: delivered === undefined ? '' : dirname(dirname(delivered.path)),
      },
      found.by,
    );
  };
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
    // A sender arrives as the session id the Gate proved (the tracker's `from`); a reference that names no ferret is none.
    resolveSender: async (reference: string) => {
      const id = tryParseSessionId(reference);
      return id === undefined ? undefined : await readTarget(id).catch(() => undefined);
    },
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
  /**
   * ONE SNAPSHOT of the screen a stuck send met, so the cause can be found afterwards: v4 retried a message for six and a
   * half hours against a frame nobody kept. The runner's capture is MASKED; it is written `0600` to the ferret's own
   * folder as `stuck-frame-1.txt`, the two before it moved to `-2` and `-3` and anything older dropped. Its text never
   * leaves this machine: only its path is logged. `undefined` when the pane could not be captured or the file written.
   */
  const keepStuckFrame = async (
    ferret: SessionId,
    record: { readonly sendId: string },
    waitedMs: number,
  ): Promise<string | undefined> => {
    const captured = await (await ferrets.harness?.(ferret))?.form?.capture();
    if (captured === undefined || !captured.ok) return undefined;
    const frame = captured.value;
    const header = [
      `stuck send ${record.sendId} to ferret ${ferret}, said stuck at ${kernel.clock.now()} after ${Math.round(waitedMs / 1000)} s`,
      `alive=${frame.alive} dead=${frame.dead} promptReady=${frame.promptReady} activeWork=${frame.activeWork} ` +
        `blocking=${frame.blocking ?? 'none'} cursor=${frame.cursorX ?? '?'},${frame.cursorY ?? '?'} (zero-based, on the visible frame)`,
      '--- visible frame (masked) ---',
    ].join('\n');
    return await keepFrame(ferret, `${header}\n${frame.visible}\n`);
  };
  const failureNotifier = new AgentSendFailureNotifier(
    {
      send: async request =>
        await submit(request.id, {
          sendId: request.sendId,
          message: request.message,
          origin: AGENT_ORIGIN,
          notice: true,
        }),
    },
    {
      // The recipient is named by its ferret name in the notice, as a person reads it.
      read: async id => {
        const target = await readTarget(id).catch(() => undefined);
        const name = (await ferrets.get(id).catch(() => undefined))?.name;
        return target === undefined ? undefined : { ...target, ...(name === undefined ? {} : { teammate: name }) };
      },
      resolveSender: sendRepository.resolveSender,
    },
    defaultSessionSendSettings.clientName,
  );
  const tracker = new SendTracker(
    {
      ledger: trackedLedger,
      evidence: deps.evidence,
      terminal: trackedPane,
      repository: sendRepository,
      channel: {
        claimedAt: (id, sendId) => deps.claude?.claimedAt(id, sendId),
        writeBudgetMs: deps.claude?.writeBudgetMs ?? 0,
        bootedAt: deps.claude?.bootedAt ?? 0,
        received: (id, sendId) => {
          deps.claude?.received(id, sendId);
        },
        broken: id => deps.claude?.broken(id) === true,
        fallBackToTyping: async (id, record) => await fallBackToTyping(id, record),
      },
      warn: (message, fields) => {
        kernel.log.warn(message, fields);
      },
      attempts: {
        reattempt: async (id, sendId) => await sendActs.reattempt(id, sendId, { by: 'daemon' }),
        resubmit: async (id, sendId) => await sendActs.resubmit(id, sendId),
      },
      // A failed peer send is told ONCE to its sender (today's AgentSendFailureNotifier): the daemon types a notice into the
      // sender's own session under `send-failed:<recipient>:<send id>` (the ledger keeps one row per id, so a re-derived
      // failure cannot tell it twice), as the daemon with no sender session, so nothing retries it and it never notifies.
      // The log keeps ids and the fate only.
      notifier: {
        notify: async (sender, recipient, record) => {
          kernel.log.info('send.failed', { ferret: recipient, sendId: record.sendId, sender, fate: record.fate });
          await failureNotifier.notify(sender, recipient, record);
        },
      },
      // A send the tracker could not type for `stuckAlarmMs` is said LOUDLY, once: a warning in the daemon's log
      // naming the ferret, the send and the wait. Ids and numbers only, never the message or the screen. The row's
      // `stuckAt` is what the person who sent it sees; the tries go on.
      alarm: {
        stuck: async (recipient, record, waitedMs) => {
          const snapshot = await keepStuckFrame(recipient, record, waitedMs).catch(() => undefined);
          kernel.log.warn(
            `a message to ferret ${recipient} is STUCK: nothing could be typed for it for ${Math.round(waitedMs / 1000)} s, ` +
              "because the agent's input box could not be proven empty. Ferretry keeps trying every " +
              `${Math.round(defaultSendTrackerSettings.untypedLookMs / 1000)} s; the ferret's terminal shows what is in the way` +
              (snapshot === undefined
                ? ' (no snapshot of its screen could be kept)'
                : `; the screen it met is kept at ${snapshot}`),
            { ferret: recipient, sendId: record.sendId, senderKind: record.senderKind ?? 'unknown', waitedMs },
          );
          // An agent has nobody watching its row: it is told, once, that its message is kept and still tried.
          if (record.senderKind === 'agent' && record.from !== undefined)
            await failureNotifier
              .notifyStuck(record.from, recipient, record, waitedMs)
              // Ids only: a refusal's sentence can quote the sender's own draft, and a log line never carries screen text.
              .catch(() =>
                kernel.log.warn('the sender of a stuck send could not be told', {
                  ferret: recipient,
                  sendId: record.sendId,
                  sender: record.from ?? 'unknown',
                }),
              );
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
  const rostered = (async () => {
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
      retraction: new EntriesRetractionProof(harnessEntries(ferrets)),
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
  /** Several ferrets' messages as ONE turn, each under its own banner (today's `combinedDelivery`), oldest first. */
  const combinedText = async (
    ferret: SessionId,
    parts: NonNullable<QueuedSend['parts']>,
  ): Promise<{ readonly text: string; readonly fromName?: string }> => {
    const recipient = await ferrets.get(ferret).catch(() => undefined);
    const senders = await Promise.all(
      parts.map(async part => {
        const id = tryParseSessionId(part.senderReference);
        return id === undefined ? undefined : await ferrets.get(id).catch(() => undefined);
      }),
    );
    const text = combinedDelivery(
      parts.map((part, at) => {
        // A sender that can no longer be found is still named by the reference it sent under.
        const from = { id: (senders[at]?.id ?? part.senderReference) as SessionId, teammate: senders[at]?.name };
        const kind = peerMessageKind(recipient, from.id, part.replyExpected);
        return { sender: peerSender(from, kind, bannerLabel(part.label)), body: payloadOf(part.text) };
      }),
      defaultSessionSendSettings.clientName,
    );
    const first = senders[0]?.name;
    return { text, ...(first === undefined ? {} : { fromName: first }) };
  };
  const typedText = async (
    ferret: SessionId,
    request: Pick<UnwiredSend, 'label' | 'replyExpected'> & {
      readonly message: string;
      readonly senderSessionId?: string | undefined;
      readonly parts?: QueuedSend['parts'];
    },
  ): Promise<{ readonly text: string; readonly fromName?: string }> => {
    if (request.parts !== undefined && request.parts.length > 1) return await combinedText(ferret, request.parts);
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
   * (one question or a tabbed form of several) and from the transcript's open `request_user_input` call for a Codex one.
   * The pane read here remains the second guard for a form the watch has not yet stored (it looks every 2 s).
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
    /** Agenda's turn-end check is speaking (`ConversationCaller` `agenda`): typed bare, recorded as the daemon's own. */
    readonly agenda?: true;
    /**
     * The daemon itself is the sender (a failed-send notice): recorded as the daemon's own under the Delivery feature,
     * with no sender session, so nothing retries it and a notice that cannot be delivered never notifies anybody.
     */
    readonly notice?: true;
    /** The session monitor is waking a ferret whose declared wait ended: Ferretry · Monitor, never reviving a stopped one. */
    readonly monitor?: true;
    /** The queue's own entry under `sendId` is what is delivered, so it is not an earlier send of that id. */
    readonly queued?: true;
    /** Who the daemon is, when it is the sender: the sender chip, in place of the one a flag names. */
    readonly by?: QueueAuthor | undefined;
    /** Two or more ferret messages delivered as one turn (the queue's combined delivery). */
    readonly parts?: QueuedSend['parts'];
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
      senderKind:
        request.warden === true || request.notice === true || request.agenda === true
          ? 'daemon'
          : request.senderSessionId === undefined
            ? 'human'
            : 'agent',
      // The Warden's words are Ferretry's own, shown as such (the sender chip reads `by`), as today's remedies were.
      ...(request.warden === true ? { by: { kind: 'ferretry' as const, feature: 'Warden' } } : {}),
      ...(request.agenda === true ? { by: { kind: 'ferretry' as const, feature: 'Agenda' } } : {}),
      ...(request.notice === true ? { by: { kind: 'ferretry' as const, feature: 'Delivery' } } : {}),
      // What the queue knew of its sender wins over the flag: a Board notice is the Board's, not "Delivery".
      ...(request.by === undefined ? {} : { by: request.by }),
      ...(request.parts === undefined || request.parts.length < 2
        ? {}
        : { batch: request.parts.map(part => ({ queueId: part.queueId, from: part.senderReference })) }),
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
    const repeated = await keptSend(ferret, request.sendId, request.queued === true);
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
  /**
   * Whether this send goes through the Claude channel: a ferret's message or the daemon's own (a failed-send notice, Agenda's
   * check) to a CLAUDE ferret whose MCP server is listening. NEVER the owner's words, the Warden's or a send-now (those
   * type, and a person's message is not a ferret's to route), and never one the channel already failed to carry.
   */
  const channelled = (ferret: SessionId, target: SendTarget, request: TypedSend): boolean =>
    request.warden !== true &&
    request.now !== true &&
    target.harness === 'claude' &&
    (request.senderSessionId !== undefined || request.notice === true || request.agenda === true) &&
    deps.claude?.connected(ferret) === true;
  /**
   * A channel send the transcript never showed Claude receiving (the receipt window ran out; the tracker calls this once
   * per look until it works). NO withdraw-then-new: under the ferret's send lane the SAME ledger row is moved from the
   * channel to the typing path in ONE settle — `direct`, accepted and `untyped`, which the tracker types every second
   * the pane reads safe — and only then is it typed. A crash, a failed bind or a question refusal anywhere after that
   * settle leaves a row the tracker still retries; before it, a channel row it still falls back with.
   *
   * The outbox gives the message back first, but a CLAIMED one is never taken back: the window ran out on it, so the
   * channel is marked broken (nothing more is routed through it until the ferret's server is relaunched) and the message
   * is typed. A server that wakes up and pushes it late is refused: its claim is gone.
   */
  const fallBackToTyping = async (ferret: SessionId, record: { readonly sendId: string }): Promise<void> => {
    const claude = deps.claude;
    if (claude === undefined) return;
    const moved = await lane.run(ferret, async () => {
      const current = (await ledger.list(ferret)).find(entry => entry.sendId === record.sendId);
      if (current?.path !== 'channel' || current.fate !== 'accepted') return false;
      // A claim the server was granted a moment ago may still be written (it writes only within the budget of its own send,
      // which is never after the grant): nothing is typed until that is over. The row stays a channel row; the next look waits.
      const claimedAt = claude.claimedAt(ferret, record.sendId);
      if (claimedAt !== undefined && kernel.clock.nowMs() < claimedAt + claude.writeBudgetMs) return false;
      if (claude.withdraw(ferret, record.sendId) === 'claimed') claude.markBroken(ferret);
      const now = kernel.clock.now();
      const settled = await ledger.settle(ferret, record.sendId, {
        path: 'direct',
        untyped: true,
        attempt: 1,
        attemptAt: now,
        deadlineAt: undefined,
      });
      if (settled === undefined)
        throw new Error(`the ledger row of send ${record.sendId} could not be moved to typing`);
      await sendRepository.journal(ferret, 'control.send_deferred', { sendId: record.sendId, outcome: 'untyped' });
      return true;
    });
    if (!moved) return;
    // The row is recoverable from here: a refusal now (the pane is busy, a question is open, the bind failed) is the
    // tracker's next look, in a second. Said with ids, never swallowed.
    await sendActs.reattempt(ferret, record.sendId, { by: 'daemon' }).catch((error: unknown) => {
      kernel.log.warn('a channel send was moved to typing and will be typed on a later look', {
        ferret,
        sendId: record.sendId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  };
  /**
   * A send NOTHING was typed for is kept open as `untyped`: the tracker types it the first time the pane reads safe, every
   * second, and says so out loud once it has waited too long. `undefined` when the row could not be marked (the send then
   * goes on as it would have), so a failing ledger never loses a message.
   */
  const keepUntyped = async (
    ferret: SessionId,
    sendId: string,
    waitReason: 'unreadable' | 'busy' | 'dialog' | 'draft',
  ): Promise<SendResult | undefined> => {
    const kept = await ledger.settle(ferret, sendId, { untyped: true }).catch(() => undefined);
    if (kept === undefined) return undefined;
    await sendRepository.journal(ferret, 'control.send_deferred', { sendId, outcome: 'untyped' });
    return { ferret, disposition: 'queued', sendId, fate: 'accepted', waitReason };
  };
  /**
   * Why this pane must not be typed into right now, or `undefined` when it may. Compacting (the harness is busy summarising
   * and an Enter would queue behind it), a dialog or consent prompt (a key is an answer to a question nobody read), and — for
   * a ferret's message only — text already in the composer (a person's own draft is the person's to clear, so theirs is refused
   * by the terminal with the Clear/Send choice instead). A pane that cannot be read says nothing here: the terminal's own
   * checks decide.
   */
  const unsafePane = async (
    bound: Awaited<ReturnType<typeof terminal.bind>>,
    request: TypedSend,
  ): Promise<'busy' | 'dialog' | 'draft' | undefined> => {
    const pane = await bound.observe();
    if (pane === undefined) return undefined;
    if (pane.compacting === true) return 'busy';
    if (pane.blockingPrompt !== undefined) return 'dialog';
    if (request.senderSessionId !== undefined && pane.draft !== undefined && pane.draft.trim() !== '') return 'draft';
    return undefined;
  };
  /** The refusal for a message that must never start a stopped ferret: Agenda's own words, and a monitor's wake. */
  const neverRevives = (request: TypedSend): SessionSendError =>
    new SessionSendError(
      'refused',
      `the ferret is stopped and ${request.monitor === true ? 'a wake' : 'an Agenda message'} never revives it, so nothing was typed`,
    );
  const typeLocked = async (ferret: SessionId, request: TypedSend): Promise<SendResult> => {
    // A ferret that has stopped has no pane to type into: the message revives it (see {@link reviveLocked}).
    const first = await readTarget(ferret);
    if (TERMINAL_SEND_STATUSES.has(first.status)) {
      // Agenda's own words and a monitor's wake never revive: a nudge is no reason to start a ferret the owner (or its own end)
      // stopped, and a wake queued behind a gate reaches here after the stop. Refused before any record, so nothing is typed,
      // nothing is kept, and nothing is recorded under the owner's name.
      if (request.agenda === true || request.monitor === true) throw neverRevives(request);
      return await reviveLocked(ferret, request);
    }
    // Opened BEFORE the record: an unknown ferret or a seam that is off types nothing and keeps nothing. No caller goes
    // to Ferrets: a send has no target rule (the path names where it goes, as for every caller); a ferret is a SENDER.
    const bound = await terminal.bind(ferret);
    await refuseWhileAsking(ferret);
    const { text, fromName } = await typedText(ferret, request);
    // SEND-NOW: the turn is stopped FIRST and BEFORE the record exists: a stop that is refused (a hold, a gone pane, a
    // runner that cannot stop) types nothing and keeps nothing, so the id starts over. The pane is READ before any key.
    if (request.now === true) await stopForNow(ferret, bound);
    // A repeat of a send that already has a live row types nothing and writes no document: no orphan for the owner's words.
    const repeated = await keptSend(ferret, request.sendId, request.queued === true);
    if (repeated !== undefined) return repeated;
    // A Claude ferret whose MCP server is listening takes a ferret's or the daemon's own message through its channel: nothing is typed.
    if (deps.claude !== undefined && channelled(ferret, first, request)) {
      const sentThrough = await accepting(ferret, request, text, fromName, { path: 'channel', matchText: text });
      if (!sentThrough.created) return (await keptSend(ferret, request.sendId)) ?? { ferret, disposition: 'sent' };
      const from = deps.claude.senderName(request, fromName);
      deps.claude.push(ferret, { sendId: request.sendId, text, ...(from === undefined ? {} : { from }) });
      return { ferret, disposition: 'sent', sendId: request.sendId, fate: 'accepted', path: 'channel' };
    }
    // The turn document first (today's order): a message that goes by file has its pointer, which the row must name.
    const sent = await turnDocument(
      ferret,
      text,
      request.warden === true
        ? { kind: 'ferretry', feature: 'Warden' }
        : request.agenda === true
          ? { kind: 'ferretry', feature: 'Agenda' }
          : request.notice === true
            ? request.by?.kind === 'ferretry' && request.by.feature !== undefined
              ? { kind: 'ferretry', feature: request.by.feature }
              : { kind: 'ferretry', feature: 'Delivery' }
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
    if (!accepted.created)
      return (await keptSend(ferret, request.sendId, request.queued === true)) ?? { ferret, disposition: 'sent' };
    /** Set once the message went to the harness's own queue: the row's path is then today's busy path. */
    let viaQueue = false;
    // THE PANE MUST BE SAFE BEFORE A KEY GOES (owner ruling 2026-11-15): not compacting, no dialog or consent waiting for an
    // answer, and — for a ferret's message, which has nobody to press a button — nothing in the composer. A pane that is not
    // keeps the send `untyped`, and the tracker looks again every second until it is.
    const unsafe = request.warden === true || request.notice === true ? undefined : await unsafePane(bound, request);
    if (unsafe !== undefined) {
      const kept = await keepUntyped(ferret, request.sendId, unsafe);
      if (kept !== undefined) return kept;
    }
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
      // NEVER DROPPED: a box that could not be proven empty typed nothing, and nothing has changed by refusing. The
      // owner's message and a ferret's are KEPT open as `untyped`, and the tracker types them the first time the box
      // reads clear — saying so out loud past its stuck limit. The Warden re-plans its own and a daemon notice ends here.
      if (error instanceof UnreadableComposer && request.warden !== true && request.notice !== true) {
        const kept = await keepUntyped(ferret, request.sendId, 'unreadable');
        if (kept !== undefined) return kept;
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
  const keptSend = async (
    ferret: SessionId,
    sendId: string | undefined,
    /** The queue's own entry is the message being delivered: only the ledger says whether it was typed already. */
    delivering = false,
  ): Promise<SendResult | undefined> => {
    if (sendId === undefined) return undefined;
    const [rows, queued] = await Promise.all([ledger.list(ferret), queue.list(ferret)]);
    const waiting = delivering ? undefined : queued.find(message => message.id === sendId);
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
      ...(row?.path === 'channel' ? { path: 'channel' as const } : {}),
    };
  };
  /**
   * A cheap token for a log that moves with every line appended: the identity of its file (one `lstat`), `absent` when
   * there is none. The poll's `If-None-Match` is answered from this, so a chat nobody typed into costs a stat.
   */
  const sendsStamp = async (id: string): Promise<string> => {
    const parsed = parseSessionId(id);
    // The same look a read takes first, so a send the pane has settled moves the stamp.
    await lookFirst(parsed);
    return await stamp('sends', parsed);
  };
  const queueStamp = async (id: string): Promise<string> => {
    const ferret = parseSessionId(id);
    const queued = await stamp('queue', ferret);
    // As `queueMessages` answers: a queue nobody ever wrote to, of a ferret nobody knows, is not found, never "unchanged".
    if (queued === 'absent' && (await ferrets.get(ferret)) === undefined)
      throw new SessionSendError('not_found', `session not found: ${id}`);
    return queued;
  };
  const queueMessages = async (id: string): Promise<readonly QueuedMessage[]> => {
    const ferret = parseSessionId(id);
    const held = await queue.list(ferret);
    if (held.length === 0 && (await ferrets.get(ferret)) === undefined)
      throw new SessionSendError('not_found', `session not found: ${id}`);
    return held;
  };
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

  /**
   * THE MAILBOX IS ON. Every send is written to the ferret's queue and answered once it is on disk; the deliverer, the one
   * owner of delivery, hands each to `typeMessage` (below, as the transport's `type`) on its own turn. Armed at boot (a
   * message accepted before a restart is delivered after it), told when a ferret's state changes, stopped with the daemon.
   */
  const timers = new CancellableTimers(kernel.clock);
  /**
   * WHAT THE FIRST LOOK ANSWERED, for the send still waiting on it. A send into a free box is typed within that look and is
   * answered as the direct path answered (its disposition, or the refusal it threw); a message the look held back, or one
   * that goes later, is answered `queued`. Only the sends being awaited are recorded, so nothing here grows.
   */
  const awaiting = new Set<string>();
  const answers = new Map<string, SendResult>();
  const failures = new Map<string, unknown>();
  const deliverer = new QueueDeliverer(
    {
      store: deps.queueStore,
      // The queue's own lock, never the ferret's send lane: the hand-over takes that one.
      serial: new KeyedSerialExecutor(),
      clock,
      // One pending look per ferret, on its own scheduler: the tracker's keeps its own one pending look per ferret.
      scheduler: new ClockSendScheduler(kernel.clock),
      view: async id => await new SendPathDeliveryView(sendRepository, lookAtPane, { launching: () => false }).view(id),
      transport: new SendPathQueueTransport(
        {
          type: async (id, request) => {
            try {
              const typed = await typeMessage(id, request);
              if (awaiting.has(request.sendId)) answers.set(request.sendId, typed);
              return typed;
            } catch (error) {
              if (awaiting.has(request.sendId)) failures.set(request.sendId, error);
              throw error;
            }
          },
          finishOwnDraft: async id => await sendActs.finishOwnDraft(id),
        },
        ledger,
        tracker,
      ),
      sessions: () => [...roster],
      sleep: async milliseconds => await timers.after(milliseconds).done,
    },
    { ...defaultQueueDeliverySettings },
  );
  void rostered.then(async () => {
    if (!stopped) await deliverer.arm();
  });
  /** The ferret's session as the send path reads it, which a message to an unknown ferret is refused on (404). */
  const queueingPorts = {
    queue,
    deliverer,
    direct: {
      send: async (request: SendMessageRequest) =>
        await typeMessage(request.id, {
          sendId: request.sendId,
          message: request.message,
          origin: AGENT_ORIGIN,
          ...(request.by === undefined ? {} : { by: request.by }),
          ...(request.by?.kind === 'ferretry' && request.by.feature === 'Warden'
            ? { warden: true as const }
            : request.by?.kind === 'ferretry' && request.by.feature === 'Agenda'
              ? { agenda: true as const }
              : { notice: true as const }),
          ...(request.by?.kind === 'ferretry' && request.by.feature === 'Monitor' ? { monitor: true as const } : {}),
        }),
      // A message waiting on a person is refused here, as it always was: it is not carried to wait behind a question.
      authorize: async (id: SessionId) => await refuseWhileAsking(id),
    },
    target: async (id: SessionId) => await readTarget(id),
    timer: (milliseconds: number) => timers.after(milliseconds),
  };
  const senders = new Senders(queueingPorts);
  /**
   * EVERY SEND PATH goes in here: the owner, a ferret, the Warden, Agenda and the daemon's own notices. The message is
   * written to the queue, answered as the queue and the ledger say it stands (the same words a repeat of its id gets), and
   * typed by the deliverer on its turn. A daemon notice to an interactive chat keeps the direct path (R3).
   */
  const submit = async (ferret: SessionId, request: TypedSend): Promise<SendResult> => {
    const stopped = TERMINAL_SEND_STATUSES.has((await readTarget(ferret)).status);
    // Agenda's own words and a monitor's wake never revive a stopped ferret: refused before anything is kept.
    if ((request.agenda === true || request.monitor === true) && stopped) throw neverRevives(request);
    // The ferret's terminal is opened first, as the typing send opens it: a ferret with no terminal to reach, or one
    // Ferrets will not let this caller touch, is refused here in plain words, before anything is kept or queued.
    if (!stopped) await terminal.bind(ferret);
    const unnamedAgent = request.origin.kind === 'agent' && request.senderSessionId === undefined;
    const daemon =
      request.warden === true ||
      request.agenda === true ||
      request.notice === true ||
      request.monitor === true ||
      unnamedAgent;
    const sends = senders.pick({ ...request, unnamedAgent });
    // Refused before anything is kept, as the typing send refuses it: a message with nothing in it is no message.
    const message = payloadOf(request.message);
    const label = bannerLabel(request.label);
    awaiting.add(request.sendId);
    try {
      const direct = await sends.send({
        id: ferret,
        sendId: request.sendId,
        message,
        ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
        ...(request.now === true ? { now: true } : {}),
        ...(request.replyExpected === true ? { replyExpected: true } : {}),
        ...(label === undefined ? {} : { label }),
        ...(request.senderSessionId === undefined ? {} : { senderReference: request.senderSessionId }),
        ...(daemon ? { origin: 'daemon' as const } : {}),
      });
      if (direct !== undefined) return direct;
      // The look's own refusal reaches the sender only when it ended the message (failed, or typed and uncertain): one
      // that only made it wait (a draft, a dialog) is the queue's to retry, so the sender is not told to send it again.
      const failure = failures.get(request.sendId);
      const state = (await queue.list(ferret)).find(entry => entry.id === request.sendId)?.state;
      if (failure !== undefined && (state === 'failed' || state === 'typing')) throw failure;
      return (
        answers.get(request.sendId) ??
        (await keptSend(ferret, request.sendId)) ?? {
          ferret,
          disposition: 'queued',
          sendId: request.sendId,
          fate: 'accepted',
        }
      );
    } finally {
      awaiting.delete(request.sendId);
      answers.delete(request.sendId);
      failures.delete(request.sendId);
    }
  };

  return {
    deliverer,
    prepared,
    terminal,
    turnStates,
    handoffOf,
    roster,
    tracker,
    sendActs,
    interruptFerret,
    mayGo,
    deliverAttachments,
    submit,
    keptSend,
    turnsOf,
    sendsStamp,
    queueStamp,
    queueMessages,
    queueFailure,
    lookFirst,
    records,
    waiters,
    awaitStatus,
    /** A ferret's phase was looked at: it feeds the tracker's "a turn started after this send" guard, and a turn that ended is one look at what waits. */
    turnLooked: (ferret: string, phase: string): void => {
      const id = tryParseSessionId(ferret);
      if (id === undefined) return;
      // Only a CHANGE moves the stamp: the guard compares it with when a send was typed.
      const state = phase === 'working' ? 'working' : 'idle';
      if (turnStates.get(id)?.state !== state) turnStates.set(id, { state, at: kernel.clock.now() });
      // A ferret's state moved (a turn ended, a dialog opened): what waits for it in the queue is looked at, if anything does.
      void deliverer.changed(id).catch(() => undefined);
      // A turn boundary is when a held or queued send is read or dropped: one tracker look, only for a ferret with sends open.
      if (phase === 'working') return;
      void tracker
        .watching(id)
        .then(async watching => {
          if (watching) await tracker.check(id);
        })
        .catch(() => undefined);
    },
    /** The ferret is gone: nothing is held for it any more. */
    turnForgotten: (ferret: string): void => {
      const id = tryParseSessionId(ferret);
      if (id !== undefined) turnStates.delete(id);
    },
    isStopped: () => stopped,
    /**
     * Disarms the tracker, ends every parked waiter and cancels the scheduler's pending looks; the deliverer finishes the
     * hand-over it is in the middle of (never half a typing) and starts no other, then no timer of the queue is left.
     */
    stop: async (): Promise<void> => {
      stopped = true;
      disarm?.();
      for (const waiter of [...waiters.values()]) waiter.end();
      scheduler.cancelAll();
      await deliverer.stop();
      timers.cancelAll();
    },
  };
}
