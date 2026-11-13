/**
 * THE CHAT SCREEN (`screens.chat`, `/ferrets/:ferret/chat`): one ferret's conversation, kept fresh. Today's
 * `SessionRoute` in `App.tsx`, cut down to what is Conversation's: the refresh that reads the ferret's view, its
 * transcript pages, its send ledger and its queue (`chat-refresh.ts`); the ledger rows placed into the transcript;
 * Retry, Cancel and Press Enter on a row; the queue's Edit and Cancel; the question it is asking; and the device
 * outbox every composer below saves into first.
 *
 * Everything else today's route read — the agenda, the board's tasks, the terminal deck, Warden, Learning, the
 * Hypermedia, Pack and Agenda switches, the browser sign-in, the account picker — is another plugin's panel in the
 * slots the page mounts, and is not read here.
 *
 * GAPs, each said where it bites:
 *   - GAP(app-shell): no live event stream yet. Today's route subscribed `/v1/events` for the transcript's "something
 *     moved" frames and the working turn's live readout; on 5.0 the half hears its own wake-ups and Ferrets'
 *     (`client.subscribe`) and nudges the poll with each, and draws no live-feed state, because there is no feed whose
 *     state it could honestly report.
 *   - GAP(app-shell): no device copy of the transcript. Today's chat drew the last copy this device saw first and said
 *     "Updating…" over it; the shell has no session cache, so the chat opens on "Opening…" until the first read.
 *   - GAP(app-shell): a lost carrier is not told apart from a refusal (`isCarrierOutage`), so every failed read is said.
 *   - GAP(ferrets, Q1): "Clear stuck messages" is built (`use-stuck-message-actions.tsx`) and listed by nothing until
 *     the Ferrets Actions menu lists contributions.
 */

import { useChatScrollSlot, useDaemonControls, useOptionalRouter } from '@ferretry/app';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import type { PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  MessageSent,
  QuestionAnswered,
  QuestionAsked,
  QueueChanged,
  type QueuedMessage,
} from '../../contract/index.ts';
import { useConversationClient, useConversationDaemon } from '../client.ts';
import { ConversationOutbox } from '../composer/conversation-outbox.tsx';
import {
  clearForegroundPinScope,
  daemonConnection,
  daemonFerretKey,
  daemonFerretScope,
  setForegroundPinScope,
} from '../composer/seam.ts';
import { useSendOutbox } from '../composer/send-outbox-wiring.ts';
import { QueueActionsContext } from '../queue/queue-actions-context.tsx';
import { joinOutbox, joinQueue, queueActions } from '../queue/send-queue.ts';
import { useSendView } from '../queue/use-send-view.ts';
import { pendingQuestionOf, type PendingQuestion } from '../questions/question-form.tsx';
import { logSearchOf, type ChatSearchPort } from '../search/chat-search.tsx';
import { chatReadApi, readQuestion } from './chat-reads.ts';
import { type ChatSession, unreadChatSession } from './chat-session.ts';
import {
  type ChatRefreshControl,
  type ChatRefreshEnvironment,
  queueWatcher,
  sendCanceller,
  sendRetrier,
  sendSubmitter,
  startChatRefresh,
} from './chat-refresh.ts';
import type { SendCancel, SendRetry, SendSubmit } from './ledger-message.tsx';
import { placeLedgerRows } from './ledger-placement.ts';
import { type LedgerSendRecord, ledgerFeed, parseLedgerSendsResponse } from './send-ledger.ts';
import { SessionChatPage } from './session-chat-page.tsx';
import type { SendDismiss, SendExpand } from './settled-send-note.tsx';
import type { TranscriptEntry } from './transcript-entries.ts';
import type { TranscriptHistoryStatus } from './transcript-history.ts';
import type { TranscriptHistoryControl } from './transcript-history-row.tsx';
import { useStuckMessageActions } from './use-stuck-message-actions.tsx';

/** The browser's clock, timers and visibility, for the refresh (today's `browserWorkspaceRefreshEnvironment`). */
const browserChatRefreshEnvironment: ChatRefreshEnvironment = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: handle => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  onVisibility: callback => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

type ChatState = 'opening' | 'connected' | 'failed';

/**
 * Said by the two live regions that outlive every loading, error and content swap — so a reader hears the chat
 * open, and hears it fail, exactly once.
 */
const CHAT_STATE_MESSAGE: Readonly<Record<ChatState, string>> = {
  opening: 'Opening this ferret’s conversation…',
  connected: 'This ferret’s conversation is open.',
  failed: 'This ferret’s conversation could not be opened.',
};

export function ChatScreen({ params }: ScreenProps): ReactNode {
  const client = useConversationClient();
  const daemonId = useConversationDaemon();
  const ferretId = params['ferret'];
  if (ferretId === undefined || ferretId.trim() === '' || daemonId === undefined)
    return (
      <p className="fy-shell-line fy-shell-line--info" role="status">
        This link names no ferret on this machine.
      </p>
    );
  return (
    // Every composer below saves a send on this device first and hands it to the daemon second.
    <ConversationOutbox>
      {/* Keyed on the daemon and the ferret: another ferret is another chat, with nothing carried over. */}
      <ChatRoute client={client} daemonId={daemonId} ferretId={ferretId} key={`${daemonId}\u0000${ferretId}`} />
    </ConversationOutbox>
  );
}

interface ChatRouteProps {
  readonly client: PluginClient;
  readonly daemonId: string;
  readonly ferretId: string;
}

function ChatRoute({ client, daemonId, ferretId }: ChatRouteProps) {
  const router = useOptionalRouter();
  const navigate = router?.navigate;
  const { controls } = useDaemonControls(daemonId);
  const scope = useMemo(() => daemonFerretScope(daemonConnection(daemonId), ferretId), [daemonId, ferretId]);
  // Per ferret, not per history entry: coming back to a conversation by any route finds the reading position.
  const readingPosition = useChatScrollSlot(daemonFerretKey(scope));
  const [view, setView] = useState<ChatSession | null>(null);
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
  /** The ferret's send ledger — where each message the reader (or a teammate) sent actually went. */
  const [sends, setSends] = useState<readonly LedgerSendRecord[]>([]);
  /** The ferret's durable queue — the first ticks of a message, before the ledger has it (`queue/send-queue.ts`). */
  const [queue, setQueue] = useState<readonly QueuedMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The daemon can prove no transcript is this ferret's: Chat cannot fill and no send can be confirmed. */
  const [transcriptUnbound, setTranscriptUnbound] = useState(false);
  /** What the top of the chat offers: older messages to load, the first message, or nothing to page. */
  const [historyStatus, setHistoryStatus] = useState<TranscriptHistoryStatus>('unavailable');
  const refreshControl = useRef<ChatRefreshControl | null>(null);
  /** Bumped to read the question again (a wake-up, or a refresh after a failed read). */
  const [questionTick, setQuestionTick] = useState(0);
  /** Whether the last question read FAILED: the summary's status cannot say it changed, so a refresh retries it. */
  const questionFailed = useRef(false);
  const history = useMemo<TranscriptHistoryControl>(
    () => ({ status: historyStatus, loadOlder: () => void refreshControl.current?.loadOlder() }),
    [historyStatus],
  );

  useEffect(() => {
    const ledger = ledgerFeed(setSends);
    const control = startChatRefresh({
      api: chatReadApi(client),
      ferretId,
      environment: browserChatRefreshEnvironment,
      onTranscript: setEntries,
      onHistory: setHistoryStatus,
      onSends: rows => ledger.onSends(parseLedgerSendsResponse(rows)),
      onSendsFailed: ledger.onSendsFailed,
      onQueue: setQueue,
      onSession: session => {
        setView(session);
        // Working and idle are one status here, so a failed question read is retried on the next read of the ferret.
        if (questionFailed.current) setQuestionTick(tick => tick + 1);
      },
      onError: setError,
      onTranscriptUnbound: setTranscriptUnbound,
    });
    refreshControl.current = control;
    return () => {
      control.stop();
      if (refreshControl.current === control) refreshControl.current = null;
    };
  }, [client, ferretId]);

  /**
   * THE WAKE-UPS. A send landing, the queue moving, a question asked or answered, the ferret changing state: each
   * nudges the poll at once rather than waiting for its next tick. None is relied on — the reads are the truth.
   */
  useEffect(() => {
    const mine = (payload: { readonly ferret: string }): boolean => payload.ferret === ferretId;
    const nudge = (payload: { readonly ferret: string }): void => {
      if (mine(payload)) refreshControl.current?.nudge();
    };
    const asked = (payload: { readonly ferret: string }): void => {
      if (!mine(payload)) return;
      setQuestionTick(tick => tick + 1);
      refreshControl.current?.nudge();
    };
    const cancels = [
      client.subscribe(QueueChanged, nudge),
      client.subscribe(MessageSent, nudge),
      client.subscribe(QuestionAsked, asked),
      client.subscribe(QuestionAnswered, asked),
      client.subscribe(FerretsChanged, nudge),
    ];
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [client, ferretId]);

  /**
   * THE QUESTION, read from Conversation's own route — proved against the transcript — whenever the ferret's status
   * moves or a question wake-up arrives, and again on the next refresh of the ferret after a read that failed (the
   * summary's status does not move between working and idle, so it cannot be the only trigger). A failed read leaves the
   * last answer: the status alone still says a question is waiting, and the page says it cannot be answered safely
   * rather than inventing one.
   */
  const status = view?.state.status;
  const [question, setQuestion] = useState<PendingQuestion | null | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the status and the tick are re-read triggers, by design.
  useEffect(() => {
    if (status === undefined) return;
    let current = true;
    readQuestion(client, ferretId)
      .then(asked => {
        questionFailed.current = false;
        if (current) setQuestion(asked === null ? null : pendingQuestionOf(asked));
      })
      .catch(() => {
        if (current) questionFailed.current = true;
      });
    return () => {
      current = false;
    };
  }, [client, ferretId, status, questionTick]);

  /** Search the whole conversation, and load the chat back to a match (`search/chat-search.tsx`). */
  const conversationSearch = useMemo<ChatSearchPort>(
    () => ({
      search: logSearchOf(client, ferretId),
      reach: async (offset, file) => (await refreshControl.current?.loadUntil(offset, file)) ?? false,
    }),
    [client, ferretId],
  );

  /**
   * The transcript with the send ledger IN it: delivered sends chip the message they became, and every send not yet
   * in the conversation sits after it with a chip saying where it is.
   */
  const outbox = useSendOutbox();
  const noOutbox = useCallback(() => () => undefined, []);
  const outboxAll = useSyncOutbox(outbox, noOutbox);
  const outboxEntries = useMemo(
    () => outboxAll.filter(entry => entry.daemonId === daemonId && entry.ferretId === ferretId),
    [outboxAll, daemonId, ferretId],
  );
  const joinedSends = useMemo(() => joinOutbox(joinQueue(sends, queue), outboxEntries), [sends, queue, outboxEntries]);
  const {
    view: sendViewState,
    tick: settledTick,
    dismiss: dismissSends,
    setExpanded: expandSend,
  } = useSendView(joinedSends);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `settledTick` re-places the rows when one folds on its own.
  const placedEntries = useMemo(
    () => placeLedgerRows(entries, joinedSends, Date.now(), sendViewState),
    [entries, joinedSends, sendViewState, settledTick],
  );
  /** A row's × — puts one undelivered send away on this device; the daemon's ledger is never told. */
  const dismissSend = useCallback<SendDismiss>(record => dismissSends([record.sendId]), [dismissSends]);
  const toggleSend = useCallback<SendExpand>((record, open) => expandSend(record.sendId, open), [expandSend]);
  /** Asks for fresh evidence at once. Stable, so what is built over it is not rebuilt for nothing. */
  const refreshSends = useCallback(() => void refreshControl.current?.refresh(true), []);
  /** A row's Retry, under the send's ORIGINAL id — see `sendRetrier`. */
  const retrySend = useMemo<SendRetry>(
    () => sendRetrier(client, ferretId, refreshSends),
    [client, ferretId, refreshSends],
  );
  /** A row's Cancel — takes the send back; the daemon says what that did on the agent's screen. */
  const cancelSend = useMemo<SendCancel>(
    () => sendCanceller(client, ferretId, refreshSends),
    [client, ferretId, refreshSends],
  );
  /** A row's Press Enter — for a message typed into the agent's composer and never submitted. */
  const submitSend = useMemo<SendSubmit>(
    () => sendSubmitter(client, ferretId, refreshSends),
    [client, ferretId, refreshSends],
  );
  /** Edit and Cancel for a message still in the queue; the bubble reaches them through a context, not props. */
  const queueActionsValue = useMemo(
    () => queueActions(client, ferretId, refreshSends, outbox ?? undefined, queueWatcher(refreshControl)),
    [client, ferretId, refreshSends, outbox],
  );
  // "Clear stuck messages": built for the ferret's Actions menu (GAP(ferrets, Q1): nothing lists it yet).
  useStuckMessageActions({
    client,
    ferretId,
    sends,
    refresh: refreshSends,
    view: sendViewState,
    dismiss: dismissSends,
  });

  // The pane a pinned composer talks to is this ferret while its chat is on screen.
  useEffect(() => {
    setForegroundPinScope(scope);
    return () => clearForegroundPinScope(scope);
  }, [scope]);

  const refresh = useCallback(() => {
    if (questionFailed.current) setQuestionTick(tick => tick + 1);
    refreshControl.current?.acted();
    void refreshControl.current?.refresh(true);
  }, []);

  const chatState: ChatState = view !== null ? 'connected' : error !== null ? 'failed' : 'opening';
  const issue = error === null ? null : `Conversation issue: ${error}`;
  /**
   * DEGRADE, NEVER BLANK. A ferret whose read failed — refused, unreachable, or answered in a shape this build cannot
   * read — still gets its page from the id alone: the toolbar and side panels (theirs to read), the transcript (read on
   * its own route) and the composer, with the issue line naming what failed. Only the very first read is waited on.
   */
  const unread = useMemo(() => unreadChatSession(ferretId), [ferretId]);
  const drawn = view ?? (error === null ? null : unread);

  return (
    <div className="h-full min-h-0 w-full" data-daemon={daemonId} data-session={ferretId}>
      {/* These live regions outlive every loading/error/content swap. */}
      <p aria-live="polite" className="sr-only" data-session-state={chatState} role="status">
        {CHAT_STATE_MESSAGE[chatState]}
      </p>
      <p className="sr-only" data-session-error="" role="alert">
        {issue ?? ''}
      </p>
      {drawn !== null ? (
        <QueueActionsContext.Provider value={queueActionsValue}>
          <SessionChatPage
            chatWidth={controls.chatWidth}
            client={client}
            conversationSearch={conversationSearch}
            daemonId={daemonId}
            entries={placedEntries}
            history={history}
            onCancel={cancelSend}
            onDismiss={dismissSend}
            onExpand={toggleSend}
            {...(navigate === undefined ? {} : { onNavigate: (to: string) => navigate(to) })}
            onRefresh={refresh}
            onRetry={retrySend}
            onSubmit={submitSend}
            {...(question === undefined ? {} : { question })}
            {...(readingPosition === undefined ? {} : { readingPosition })}
            refreshError={issue}
            session={drawn}
            transcriptUnbound={transcriptUnbound}
          />
        </QueueActionsContext.Provider>
      ) : (
        <p className="fy-shell-line fy-shell-line--info" data-session-opening="">
          Opening…
        </p>
      )}
    </div>
  );
}

/** The device outbox's entries, live; none without an outbox (a client the shell recorded no daemon for). */
function useSyncOutbox(
  outbox: ReturnType<typeof useSendOutbox>,
  none: (listener: () => void) => () => void,
): ReturnType<NonNullable<ReturnType<typeof useSendOutbox>>['snapshot']> {
  return useSyncExternalStore(
    outbox?.subscribe ?? none,
    outbox?.snapshot ?? emptyOutbox,
    outbox?.snapshot ?? emptyOutbox,
  );
}

const NO_ENTRIES: readonly never[] = [];
const emptyOutbox = () => NO_ENTRIES;
