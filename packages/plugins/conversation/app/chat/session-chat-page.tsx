/**
 * THE CHAT: one ferret's conversation — the transcript, the question it is asking, and the composer — and the slots
 * where the rest of the ferret's screen is drawn by the plugins that own it (§5.2).
 *
 * Today's session page drew the whole workspace: the top bar, Info, Actions, the terminal deck, the browser, the
 * agenda, the board, approvals, analytics. On 5.0 each of those is another plugin's panel, mounted here and never
 * imported: `ferret.toolbar` above the conversation (Ferrets' header and actions, Conversation's compaction setting,
 * Lessons), `ferret.side` beside it (the queue, terminals, browser, cards, agenda, skills), and `composer.tools` inside
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
  PanelSlot,
} from '@ferretry/app';
import { ReferenceSurfaceProvider, TERMINAL_STATUSES, statusMark, useLiveActivity } from '@ferretry/app';
import type { LiveActivityFeed } from '@ferretry/app';
import type { FerretLiveActivity } from '@ferretry/core-ferrets/contract';
import { type ChatSession, isUnread } from './chat-session.ts';
import { CONVERSATION_ABOVE_COMPOSER_SLOT, type ComposerAccount } from '../../contract/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentGalleryProvider } from '../composer/attachment-gallery.tsx';
import { Composer } from '../composer/composer.tsx';
import { useComposerPreferences } from '../composer/use-composer-preferences.ts';
import { daemonConnection } from '../composer/seam.ts';
import {
  type PendingQuestion,
  type QuestionAnswerApi,
  QuestionForm,
  questionAnswerApi,
} from '../questions/question-form.tsx';
import { ChatSearch, type ChatSearchPort } from '../search/chat-search.tsx';
import { displayCallsign } from '../transcript/callsign.ts';
import { sessionTurn, UNREAD_PANE } from '../transcript/session-activity.ts';
import { readHandoff } from './chat-reads.ts';
import type { ChatWidthPreference } from '@ferretry/app';
import { CompactionChip } from './compaction-card.tsx';
import { HandoffSourceProvider } from './handoff-message.tsx';
import type { SendCancel, SendRetry, SendSubmit } from './ledger-message.tsx';
import { chatReferenceSurface } from './reference-surface.ts';
import { RowSlotProvider } from './row-slots.tsx';
import type { SendDismiss, SendExpand } from './settled-send-note.tsx';
import { Transcript } from './transcript.tsx';
import type { TranscriptEntry } from './transcript-entries.ts';
import type { TranscriptHistoryControl } from './transcript-history-row.tsx';
import { TranscriptUnboundNotice } from './transcript-unbound-notice.tsx';
import { useChatScrollbarGutter } from './use-chat-scrollbar-gutter.ts';
import { hideWaiting } from './waiting-fold.ts';

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
 * the runtime is not known (a ferret the chat could not read).
 */
const composerAccountOf = (session: ChatSession): ComposerAccount | undefined => {
  const agent = session.config.agent;
  if (agent === undefined) return undefined;
  const { state } = session;
  const usage = {
    ...(state.usageAuthOk === undefined ? {} : { usageAuthOk: state.usageAuthOk }),
    ...(state.usage5hPercent === undefined ? {} : { usage5hPercent: state.usage5hPercent }),
    ...(state.usageWeeklyPercent === undefined ? {} : { usageWeeklyPercent: state.usageWeeklyPercent }),
    ...(state.usageAtLimit === undefined ? {} : { usageAtLimit: state.usageAtLimit }),
    ...(state.usage5hResetAt === undefined ? {} : { usage5hResetAt: state.usage5hResetAt }),
    ...(state.usageWeeklyResetAt === undefined ? {} : { usageWeeklyResetAt: state.usageWeeklyResetAt }),
  };
  return { agent, ...(Object.keys(usage).length === 0 ? {} : { usage }) };
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

export function SessionChatPage({
  daemonId,
  session,
  entries,
  client,
  question: asked,
  canControl = true,
  refreshError = null,
  transcriptUnbound = false,
  readingPosition,
  history,
  conversationSearch,
  chatWidth = 'readable',
  compact = false,
  embedded = false,
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
  const references = useMemo(
    () => chatReferenceSurface({ daemonId, ferretId, ...(onNavigate === undefined ? {} : { onNavigate }) }),
    [daemonId, ferretId, onNavigate],
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
  const onSent = useCallback(() => {
    setPinSignal(signal => signal + 1);
    onRefresh?.();
  }, [onRefresh]);
  // LIVE is not WORKING. `running` means the agent's terminal is up; whose turn it is comes from the daemon's turn
  // watcher (`state.turnState`, read through `session-activity.ts`). The pane is the Terminals plugin's to read, so the
  // chat reads none (`UNREAD_PANE`) and a ferret with no `turnState` falls back to its status mark.
  const working = session.state.turnState === 'working';
  // A ferret the chat could not read claims nothing: no spinner over a turn nobody saw start.
  const statusLive =
    !isUnread(session) && session.state.turnState === undefined && statusMark(session).klass === 'active';
  const liveSample = useLiveActivity(liveActivity);
  const turn = sessionTurn(session, UNREAD_PANE);
  const busy = turn === 'working' || (turn === null && statusLive);
  const question = TERMINAL_STATUSES.has(session.state.status) ? null : (asked ?? null);
  const awaitingAnswer = question !== null || session.state.status === 'awaiting_question';
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

  const header = (
    <>
      {embedded ? null : <PanelSlot daemon={daemonId} slot="ferret.toolbar" subject={ferretId} />}
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
            activity={null}
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
          <PanelSlot daemon={daemonId} slot={CONVERSATION_ABOVE_COMPOSER_SLOT} subject={ferretId} />
          {question !== null && canControl ? (
            <QuestionForm
              api={questionApi}
              daemon={daemonId}
              ferretId={ferretId}
              key={`${daemonId}:${ferretId}:${question.toolUseId}`}
              onAnswered={onSent}
              question={question}
            />
          ) : awaitingAnswer ? (
            /* Status without a validated payload is damaged or incomplete evidence, never an empty question. Keep the
               recovery action visible, but do not invent options or send an unbound answer. */
            <section
              aria-label="Structured question"
              className="fy-question-form"
              data-question-unavailable=""
              role="status"
            >
              <p className="m-0">
                This session reports a structured question, but its complete validated prompt is unavailable. No answer
                can be sent safely; refresh the session or interrupt the turn to abandon it.
              </p>
            </section>
          ) : (
            <>
              {isUnread(session) ? (
                <p className="m-0 px-3 py-1 text-meta text-warn" data-composer-unread="" role="status">
                  This ferret could not be read, so nothing can be sent to it until it can.
                </p>
              ) : null}
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
                onSent={onSent}
              />
            </>
          )}
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
              {embedded ? chat : <FerretWorkspace chat={chat} daemon={daemonId} subject={ferretId} />}
            </main>
          </RowSlotProvider>
        </AttachmentGalleryProvider>
      </HandoffSourceProvider>
    </ReferenceSurfaceProvider>
  );
}
