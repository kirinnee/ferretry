/**
 * THE CHAT: one ferret's conversation — the transcript, the question it is asking, and the composer — and the slots
 * where the rest of the ferret's screen is drawn by the plugins that own it (§5.2).
 *
 * Today's session page drew the whole workspace: the top bar, Info, Actions, the terminal deck, the browser, the
 * agenda, the board, approvals, analytics. On 5.0 each of those is another plugin's panel, mounted here and never
 * imported: `ferret.toolbar` above the conversation (Ferrets' name and status) with the ferret's one menu at its end
 * (Info and Actions from `ferrets.menu`, then `conversation.modes`: Agenda mode, Hypermedia, Passive lessons, Compact memory at, the lessons scan), `ferret.side` beside it (the queue, terminals, browser, cards, agenda, skills), and `composer.tools` inside
 * the composer (attachments, dictation, the runtime picker). What stays is the conversation, copied from the page's
 * `chat` column with its order of operations: the issue line, the search, the transcript, the question form or the
 * composer.
 *
 * Masked text stays masked: every word drawn here is the daemon's own redacted text (`guard: 'secrets'` routes), and
 * nothing on this page holds or indexes a transcript beyond the rows on screen.
 */

import {
  type ChatScrollSlot,
  FerretWorkspace,
  LiveStreamIndicator,
  type LiveStreamIndicatorProps,
  PanelReplace,
  PanelSlot,
} from '@ferretry/app';
import { ReferenceSurfaceProvider, TERMINAL_STATUSES, statusMark, useAppHook, useLiveActivity } from '@ferretry/app';
import type { LiveActivityFeed } from '@ferretry/app';
import {
  FERRETS_FILE_OPEN_HOOK,
  FERRETS_PLUGIN,
  type FerretLiveActivity,
  isFerretsFileOpen,
} from '@ferretry/core-ferrets/contract';
import { useChatFleet } from './chat-fleet.ts';
import { FilesPanelBridge } from './files-panel-bridge.tsx';
import { type ChatSession, isUnread } from './chat-session.ts';
import {
  CONVERSATION_ABOVE_COMPOSER_SLOT,
  CONVERSATION_COMPOSER_SLOT,
  type ComposerAccount,
} from '../../contract/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentGalleryProvider } from '../composer/attachment-gallery.tsx';
import { composerApi } from '../composer/composer-api.ts';
import { Composer, type ComposerSent } from '../composer/composer.tsx';
import { useComposerPreferences } from '../composer/use-composer-preferences.ts';
import { daemonConnection, withReferencePrefix } from '../composer/seam.ts';
import {
  type PendingQuestion,
  type QuestionAnswerApi,
  QuestionForm,
  questionAnswerApi,
} from '../questions/question-form.tsx';
import { QuestionDrawer, questionTopic } from '../questions/question-drawer.tsx';
import { ChatSearch, type ChatSearchPort } from '../search/chat-search.tsx';
import { displayCallsign, isRecordedHarness } from '@ferretry/core-ferrets/contract';
import { usePaneActivity } from '../transcript/live-activity.tsx';
import { paneFrameReader } from '../transcript/pane-frame-reader.ts';
import { sessionTurn } from '../transcript/session-activity.ts';
import { ChatTurnContext, useChatTurnReading } from './chat-turn-context.ts';
import { aboveComposerProps } from './above-composer-props.ts';
import { readHandoff } from './chat-reads.ts';
import type { LedgerSendRecord } from './send-ledger.ts';
import type { ChatWidthPreference } from '@ferretry/app';
import { CompactionChip } from './compaction-card.tsx';
import { HandoffSourceProvider } from './handoff-message.tsx';
import type { SendCancel, SendRetry, SendSubmit } from './ledger-message.tsx';
import { chatFileProof, chatReferenceSurface } from './reference-surface.ts';
import { ModesMenu } from '../toolbar/modes-menu.tsx';
import { RowSlotProvider } from './row-slots.tsx';
import type { SendDismiss, SendExpand } from './settled-send-note.tsx';
import { Transcript } from './transcript.tsx';
import type { TranscriptEntry } from './transcript-entries.ts';
import type { TranscriptHistoryControl } from './transcript-history-row.tsx';
import { TranscriptUnboundNotice } from './transcript-unbound-notice.tsx';
import { useChatScrollbarGutter } from './use-chat-scrollbar-gutter.ts';
import { hideWaiting } from './waiting-fold.ts';

/**
 * The ask this conversation is drawn under (Agenda's `agenda.conversation` slot): what the owner types here is a reply
 * to THAT item, so the composer keeps the item's own draft (never the ferret's chat box), the message carries its
 * reference (`!A3 …`, delivered as `[re !A3 …]`), and the host hears once a message about it was accepted.
 */
export interface AskReply {
  /** The item the reply is about (`A3`). */
  readonly id: string;
  /** A message about the item was accepted. */
  readonly onReplied?: ((sent: ComposerSent) => void) | undefined;
  /** The words of a reply that was taken back: they go in the box once. */
  readonly restore?: string | undefined;
  readonly onRestored?: (() => void) | undefined;
  /**
   * The item is a form card: Send answers THE FORM (the picks on the card and the words in the box, as one answer through
   * the Agenda's answer route) instead of sending a message. It may throw the one sentence the composer shows.
   */
  readonly answerForm?: (() => void) | undefined;
  /** Bumped when a pick on the open form changes, so the "nothing to send" line goes away with it. */
  readonly formChanges?: number | undefined;
}

export interface SessionChatPageProps {
  readonly daemonId: string;
  readonly session: ChatSession;
  readonly entries: readonly TranscriptEntry[];
  readonly client: Pick<PluginClient, 'call'>;
  /**
   * The question the ferret is waiting on, as Conversation's own `GET /v1/ferrets/:ferretId/question` answered it, or
   * null when it asks none. Absent: the chat has not read it yet, and the status alone decides the notice.
   */
  readonly question?: PendingQuestion | null;
  /**
   * The ferret's send ledger as the daemon answered it. Only each send's id and acceptance instant reach the
   * `conversation.above-composer` slot (`ConversationAboveComposerProps.sends`), never its words. Absent: no sends.
   */
  readonly sends?: readonly LedgerSendRecord[];
  readonly canControl?: boolean;
  /**
   * A ready-to-read sentence, or null. Rendered VERBATIM and NOT as a live region: the chat screen owns the one
   * announcement for a refresh failure, and a second `role=status` here made assistive tech say it twice.
   */
  readonly refreshError?: string | null;
  /**
   * The daemon can prove no transcript is this ferret's own. Shown as its own notice with its remedies in place of the
   * one-line issue, because waiting never fixes it and re-sending makes it worse.
   */
  readonly transcriptUnbound?: boolean;
  /** Where this ferret's reading position is kept, so Back and a reload return to it. */
  readonly readingPosition?: ChatScrollSlot;
  /** What the top of the transcript offers, and how to load older messages (`transcript-history.ts`). */
  readonly history?: TranscriptHistoryControl;
  /** Search within the conversation — the whole transcript — and jump to a match. Absent: no search. */
  readonly conversationSearch?: ChatSearchPort;
  /** The reader's chat measure (this device's `chat-width` setting). */
  readonly chatWidth?: ChatWidthPreference;
  /** A phone's drawer layout: the composer is compact. */
  readonly compact?: boolean;
  /**
   * Drawn UNDER something else (an agenda item's ask): only the conversation — issue line, transcript, question or
   * composer. No `ferret.toolbar` and no `ferret.side` (terminals, browser, files, Warden…): viewing an item must not
   * open a terminal, which would ask for a passkey, and the item is not the ferret's page.
   */
  readonly embedded?: boolean;
  /** Drawn under an agenda item's ask: the composer is that item's reply box ({@link AskReply}). */
  readonly ask?: AskReply | undefined;
  readonly onRefresh?: () => void;
  /** Re-sends a send under its original id from its row in the transcript. */
  readonly onRetry?: SendRetry;
  /** Takes a send back from its row in the transcript. */
  readonly onCancel?: SendCancel;
  /** Presses Enter once for a send typed in the agent's composer, from its row. */
  readonly onSubmit?: SendSubmit;
  /** Puts a send that is not delivered away on this device. */
  readonly onDismiss?: SendDismiss;
  /** Opens or folds a settled send's one-line note. */
  readonly onExpand?: SendExpand;
  /** In-app navigation for a proved agent reference. */
  readonly onNavigate?: (to: string) => void;
  /** This ferret's live-feed state and the reader's manual reconnect. Absent: no feed is measured, nothing is drawn. */
  readonly liveStream?: LiveStreamIndicatorProps;
  /** This ferret's live readout, for the working line's token counts and the compaction card. Absent: none. */
  readonly liveActivity?: LiveActivityFeed<FerretLiveActivity>;
}

/**
 * The account a ferret runs on, as the composer's tools may read it: its name and the usage its monitor stamped. None while
 * the login is not known (a ferret the chat could not read, or one with no login).
 */
const composerAccountOf = (session: ChatSession): ComposerAccount | undefined => {
  const login = session.config.login;
  const { state } = session;
  const usage = {
    ...(state.usageAuthOk === undefined ? {} : { usageAuthOk: state.usageAuthOk }),
    ...(state.usage5hPercent === undefined ? {} : { usage5hPercent: state.usage5hPercent }),
    ...(state.usageWeeklyPercent === undefined ? {} : { usageWeeklyPercent: state.usageWeeklyPercent }),
    ...(state.usageAtLimit === undefined ? {} : { usageAtLimit: state.usageAtLimit }),
    ...(state.usage5hResetAt === undefined ? {} : { usage5hResetAt: state.usage5hResetAt }),
    ...(state.usageWeeklyResetAt === undefined ? {} : { usageWeeklyResetAt: state.usageWeeklyResetAt }),
  };
  if (login === undefined && Object.keys(usage).length === 0) return undefined;
  return { ...(login === undefined ? {} : { agent: login }), ...(Object.keys(usage).length === 0 ? {} : { usage }) };
};

/** A ferret as its words name it: the callsign, else the task's name, else the id (today's `sessionDisplayName`). */
const ferretDisplayName = (session: ChatSession): string =>
  displayCallsign(session.config.teammate) || session.config.name || session.config.id;

/**
 * A refresh failure that is NOT an outage, said in one line. The whole sentence is one tap away, because a clipped
 * error with no way to read the rest is worse than a long one.
 */
function CompactIssue({ sentence }: { readonly sentence: string }) {
  return (
    <details className="group min-w-0 px-3 py-1 text-meta text-warn" data-session-issue="">
      <summary className="cursor-pointer truncate group-open:whitespace-normal">{sentence}</summary>
    </details>
  );
}

/** One shared empty ledger, so a page given none does not rebuild the slot's props on every render. */
const NO_SENDS: readonly LedgerSendRecord[] = [];

export function SessionChatPage({
  daemonId,
  session,
  entries,
  client,
  question: asked,
  sends = NO_SENDS,
  canControl = true,
  refreshError = null,
  transcriptUnbound = false,
  readingPosition,
  history,
  conversationSearch,
  chatWidth = 'readable',
  compact = false,
  embedded = false,
  ask,
  onRefresh,
  onRetry,
  onCancel,
  onSubmit,
  onDismiss,
  onExpand,
  onNavigate,
  liveStream,
  liveActivity,
}: SessionChatPageProps) {
  const ferretId = session.config.id;
  const agentName = ferretDisplayName(session);
  const account = composerAccountOf(session);
  // This device's Enter-key choices, Vim mode and suggestion families, from the one device-controls store.
  const composerPreferences = useComposerPreferences(daemonId);
  // The ONE reference surface for every Markdown reader in this conversation, rebuilt only with the daemon, the ferret
  // or the navigator — never with a status tick, which would re-parse every rendered block.
  // `:agent` is proved from this daemon's fleet; `@file` only where Ferrets offers an opener AND a workspace shows Files.
  const fleet = useChatFleet(client);
  const fileOpenHook = useAppHook(daemonId, FERRETS_FILE_OPEN_HOOK, FERRETS_PLUGIN);
  const fileOpen = !embedded && isFerretsFileOpen(fileOpenHook) ? fileOpenHook : undefined;
  const showFiles = useRef<(() => void) | undefined>(undefined);
  // The `@file` proof reads this ferret's folder only, so it is built apart from the surface: a fleet change that leaves
  // the folder alone (another ferret came or went) rebuilds the surface but keeps this value, and no folder is re-listed.
  const cwd = fleet?.folders.get(ferretId);
  const files = useMemo(
    () => chatFileProof({ ferretId, client, fileOpen, cwd, showFiles: () => showFiles.current?.() }),
    [ferretId, client, fileOpen, cwd],
  );
  const references = useMemo(
    () =>
      chatReferenceSurface({
        daemonId,
        ferretId,
        client,
        fleet,
        files,
        ...(onNavigate === undefined ? {} : { onNavigate }),
      }),
    // `fleet` keeps its identity until a fact the proof reads changes (an id, a callsign, a ferret going live or
    // dormant, a folder), so a working <-> idle tick keeps the surface.
    [daemonId, ferretId, client, fleet, files, onNavigate],
  );
  // A message handed to the agent through a file is read back through the same client, so the transcript shows what
  // the person sent rather than the pointer the agent was typed.
  const handoffs = useMemo(
    () => ({
      daemon: daemonConnection(daemonId),
      sessionId: ferretId,
      read: async (name: string) => await readHandoff(client, ferretId, name),
    }),
    [client, daemonId, ferretId],
  );
  // A message still waiting to go into the ferret is on the queue panel, not in the chat (`waiting-fold.ts`).
  const shownEntries = useMemo(() => hideWaiting(entries), [entries]);
  // Bumped when the reader sends: they want to watch the reply arrive, so the transcript returns to the tail and
  // follows again even if they had scrolled up to re-read while composing.
  const [pinSignal, setPinSignal] = useState(0);
  const askId = ask?.id;
  const askReplied = ask?.onReplied;
  const answerForm = ask?.answerForm;
  const forForm = answerForm !== undefined;
  const onSent = useCallback(
    (sent?: ComposerSent) => {
      setPinSignal(signal => signal + 1);
      onRefresh?.();
      // A form's Send is an answer, not a reply to the ask: the Inbox is told nothing.
      if (sent !== undefined && !forForm) askReplied?.(sent);
    },
    [onRefresh, askReplied, forForm],
  );
  // The ask's reply carries its reference; the ferret's own chat box has none, and keeps the composer's default calls.
  const askApi = useMemo(
    () => (askId === undefined ? undefined : withReferencePrefix(composerApi(client), () => [askId])),
    [client, askId],
  );
  // LIVE is not WORKING. `running` means the agent's terminal is up; whose turn it is comes from the daemon's turn
  // watcher (`state.turnState`, read through `session-activity.ts`). The pane is Terminals' to read, and the line says
  // what the harness itself says on it, so the page reads one visible frame through Terminals' snapshot route while the
  // ferret works. A page drawn under an agenda item reads none: viewing an item must not open a terminal.
  const working = session.state.turnState === 'working';
  const readPane = useMemo(
    () => (embedded ? undefined : paneFrameReader(client, ferretId)),
    [client, ferretId, embedded],
  );
  const pane = usePaneActivity(readPane, working, undefined, session.config.harness);
  // A ferret the chat could not read claims nothing: no spinner over a turn nobody saw start.
  const statusLive =
    !isUnread(session) && session.state.turnState === undefined && statusMark(session).klass === 'active';
  const liveSample = useLiveActivity(liveActivity);
  const turn = sessionTurn(session, pane);
  const compacting = liveSample?.compaction?.phase === 'running';
  const outerTurn = useChatTurnReading();
  const toolbarTurn = useMemo(
    () => (outerTurn === null ? null : { ...outerTurn, compacting }),
    [outerTurn, compacting],
  );
  const busy = turn === 'working' || (turn === null && statusLive);
  const question = TERMINAL_STATUSES.has(session.state.status) ? null : (asked ?? null);
  const awaitingAnswer = question !== null || session.state.status === 'awaiting_question';
  // What the slot above the composer is handed. `live`: this page's ferret was read from the daemon and the latest
  // refresh did not fail, so a contributor never acts on an unread or stale turn.
  const ended = TERMINAL_STATUSES.has(session.state.status);
  const aboveComposer = useMemo(
    () =>
      aboveComposerProps({
        session,
        entries: shownEntries,
        sends,
        question,
        ended,
        live: !isUnread(session) && refreshError === null,
      }),
    [session, shownEntries, sends, question, ended, refreshError],
  );
  // The ferret's own chat box gives way to the question's form (a typed message would not answer it). An agenda item's
  // reply box is not that box: it answers THE ITEM, through the Agenda's answer route, so a question the ferret is
  // waiting on never takes it away (the item is a card of that very question as often as not).
  const showComposer = askId !== undefined || !awaitingAnswer;
  // The answer goes through the question form's own route reader; the chat re-reads once it lands.
  const questionApi = useMemo<QuestionAnswerApi>(() => {
    const api = questionAnswerApi(client);
    return {
      answer: async (...args) => {
        const answer = await api.answer(...args);
        onRefresh?.();
        return answer;
      },
    };
  }, [client, onRefresh]);

  // ---- SEARCH WITHIN THE CONVERSATION (`search/chat-search.tsx`) ---------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  /** Bumped to put the caret back in the search box. */
  const [searchFocus, setSearchFocus] = useState(0);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchFocus(count => count + 1);
  }, []);
  // Ctrl/Cmd-F in this chat searches the conversation instead of the page — which holds only what is loaded. Only
  // while focus is in the chat or nowhere, so the browser's own find still serves other panes.
  useEffect(() => {
    if (conversationSearch === undefined) return;
    const find = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'f' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      const surface = messagesRef.current?.closest('.kt-chat-surface') ?? messagesRef.current?.parentElement;
      const focus = document.activeElement;
      if (focus !== null && focus !== document.body && surface?.contains(focus) !== true) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener('keydown', find);
    return () => window.removeEventListener('keydown', find);
  }, [conversationSearch, openSearch]);
  const chatSurface = useRef<HTMLDivElement | null>(null);
  useChatScrollbarGutter(chatSurface, ferretId);

  // The composer, or whatever stands in front of it (`conversation.composer`: Voice's voice mode). Never under an agenda item's
  // reply box: that box answers the item, not the ferret, so voice mode (which sends to the ferret) has no place there.
  const composerSlot = (composer: ReactNode) =>
    askId !== undefined ? (
      composer
    ) : (
      <PanelReplace
        daemon={daemonId}
        fallback={composer}
        props={{ turn: aboveComposer.turn }}
        slot={CONVERSATION_COMPOSER_SLOT}
        subject={ferretId}
      />
    );

  const header = (
    <>
      {embedded ? null : (
        // The toolbar's turn word is told of a compaction the page's live sample says is running.
        // The main line is the name and the status; Info, Actions and every mode are one click behind the one menu button at its end.
        <div className="flex min-w-0 items-center" data-ferret-header="">
          <div className="min-w-0 flex-1">
            <ChatTurnContext.Provider value={toolbarTurn}>
              <PanelSlot daemon={daemonId} slot="ferret.toolbar" subject={ferretId} />
            </ChatTurnContext.Provider>
          </div>
          <ModesMenu daemon={daemonId} ferret={ferretId} />
        </div>
      )}
      {liveSample?.compaction?.phase === 'running' || liveStream !== undefined ? (
        <div className="flex items-center gap-2 px-3" data-chat-status="">
          {liveSample?.compaction?.phase === 'running' ? <CompactionChip compaction={liveSample.compaction} /> : null}
          {/* THE LIVE FEED'S OWN STATE: nothing visible while it is healthy, a word and Reconnect once it is not. */}
          {liveStream === undefined ? null : <LiveStreamIndicator {...liveStream} compact={compact} quiet />}
        </div>
      ) : null}
      {/* Independent failures: an unprovable transcript never hides that the session itself could not be read. */}
      {transcriptUnbound ? <TranscriptUnboundNotice onCheckAgain={() => onRefresh?.()} /> : null}
      {refreshError === null ? null : <CompactIssue sentence={refreshError} />}
    </>
  );

  const chat = (
    <div className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col" data-chat-width={chatWidth} ref={chatSurface}>
      {conversationSearch !== undefined && searchOpen ? (
        <ChatSearch
          agentName={agentName}
          focusSignal={searchFocus}
          onClose={() => setSearchOpen(false)}
          port={conversationSearch}
          transcript={messagesRef}
        />
      ) : null}
      <div className="fy-chat-log">
        <div className="fy-chat-log__messages" data-chat-messages="" ref={messagesRef}>
          <Transcript
            activity={pane.activity}
            activityFallback={session.state.activity ?? null}
            live={liveSample}
            turnStartedAt={working ? (session.state.turnStateAt ?? null) : null}
            agentName={agentName}
            busy={busy}
            daemonId={daemonId}
            entries={shownEntries}
            {...(onRetry === undefined ? {} : { onRetry })}
            {...(onCancel === undefined ? {} : { onCancel })}
            {...(onSubmit === undefined ? {} : { onSubmit })}
            {...(onDismiss === undefined ? {} : { onDismiss })}
            {...(onExpand === undefined ? {} : { onExpand })}
            pinSignal={pinSignal}
            {...(readingPosition === undefined ? {} : { readingPosition })}
            {...(history === undefined ? {} : { history })}
            sessionId={ferretId}
          />
        </div>
      </div>
      <div className="fy-chat-input" data-safe-bottom="" data-session-input="">
        <div className="fy-chat-input__column">
          {/* What the ferret is stopped on (Claude Code's permission and dialog cards): drawn by their plugin, above the composer. */}
          <PanelSlot
            daemon={daemonId}
            props={{ ...aboveComposer }}
            slot={CONVERSATION_ABOVE_COMPOSER_SLOT}
            subject={ferretId}
          />
          {question !== null && canControl ? (
            askId === undefined ? (
              /* On the ferret's own page the question is ONE LINE above the composer; the form opens on a click. */
              <QuestionDrawer
                agentName={agentName}
                key={`${daemonId}:${ferretId}:${question.toolUseId}`}
                label="Answer the ferret's questions"
                topic={questionTopic(question)}
              >
                <QuestionForm
                  api={questionApi}
                  daemon={daemonId}
                  ferretId={ferretId}
                  onAnswered={onSent}
                  question={question}
                />
              </QuestionDrawer>
            ) : (
              <QuestionForm
                api={questionApi}
                daemon={daemonId}
                ferretId={ferretId}
                key={`${daemonId}:${ferretId}:${question.toolUseId}`}
                onAnswered={onSent}
                question={question}
              />
            )
          ) : awaitingAnswer ? (
            /* Status without a validated payload is damaged or incomplete evidence, never an empty question. Keep the
               recovery action visible, but do not invent options or send an unbound answer. */
            <QuestionDrawer
              action="Details"
              agentName={agentName}
              label="Structured question"
              topic=""
              variant="unavailable"
            >
              <section
                aria-label="Structured question"
                className="fy-question-form"
                data-question-unavailable=""
                role="status"
              >
                <p className="m-0">
                  This session reports a structured question, but its complete validated prompt is unavailable. No
                  answer can be sent safely; refresh the session or interrupt the turn to abandon it.
                </p>
              </section>
            </QuestionDrawer>
          ) : null}
          {showComposer ? (
            <>
              {isUnread(session) ? (
                <p className="m-0 px-3 py-1 text-meta text-warn" data-composer-unread="" role="status">
                  This ferret could not be read, so nothing can be sent to it until it can.
                </p>
              ) : null}
              {composerSlot(
                <Composer
                  busy={busy}
                  compact={compact}
                  compacting={liveSample?.compaction?.phase === 'running'}
                  {...(session.context === undefined ? {} : { context: session.context })}
                  daemon={daemonConnection(daemonId)}
                  {...composerPreferences}
                  disabled={TERMINAL_STATUSES.has(session.state.status) || !canControl || isUnread(session)}
                  ferretId={ferretId}
                  {...(account === undefined ? {} : { account })}
                  {...(askApi === undefined ? {} : { api: askApi })}
                  {...(session.config.harness === undefined
                    ? {}
                    : isRecordedHarness(session.config.harness)
                      ? { harness: session.config.harness }
                      : { harness: { unreadable: session.config.harness } })}
                  {...(askId === undefined ? {} : { draftSlot: askId })}
                  {...(forForm
                    ? {
                        allowEmptySend: true,
                        // A form card's Send answers THE FORM, from the press itself: never a chat message, never the outbox.
                        onFormSend: answerForm,
                        ...(ask?.formChanges === undefined ? {} : { clearErrorOn: ask.formChanges }),
                      }
                    : {})}
                  {...(ask?.restore === undefined ? {} : { restore: ask.restore })}
                  {...(ask?.onRestored === undefined ? {} : { onRestored: ask.onRestored })}
                  onSent={onSent}
                />,
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );

  return (
    // Every Markdown reader inside the conversation reads references through this one surface.
    <ReferenceSurfaceProvider surface={references}>
      <HandoffSourceProvider source={handoffs}>
        {/* One blob cache for every picture on the page, so the full-screen viewer reuses what the thumbnails hold. */}
        <AttachmentGalleryProvider>
          <RowSlotProvider daemon={daemonId} ferret={ferretId}>
            {/* `overflow-clip`, not `-hidden`: a hidden box is still a scroll container. */}
            <main
              className="flex h-full min-h-0 min-w-0 flex-col overflow-clip"
              data-daemon={daemonId}
              {...(embedded ? { 'data-embedded': '' } : {})}
              data-session={ferretId}
            >
              {header}
              {/* The chat and the `ferret.side` panels: side by side wide; on a phone one at a time behind chips and "+". */}
              {embedded ? (
                chat
              ) : (
                <FerretWorkspace
                  canControl={canControl}
                  chat={
                    <>
                      <FilesPanelBridge ferretId={ferretId} target={showFiles} />
                      {chat}
                    </>
                  }
                  daemon={daemonId}
                  subject={ferretId}
                />
              )}
            </main>
          </RowSlotProvider>
        </AttachmentGalleryProvider>
      </HandoffSourceProvider>
    </ReferenceSurfaceProvider>
  );
}
