import type { FerretLiveActivity } from '@ferretry/core-ferrets/contract';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranscriptHold } from '@ferretry/app/ui';
import { PULL_TO_PALETTE_IGNORE_ATTR } from '@ferretry/app/ui';
import { useStickToBottom } from './use-stick-to-bottom.ts';
import { compactionStripIndex } from './compaction-readout.ts';
import type { PaneActivity } from '../transcript/pane-activity.ts';
import type { ChatScrollSlot } from '@ferretry/app';
import { agentRuns, type TranscriptEntry, transcriptItems } from './transcript-entries.ts';
import { newTailRows, prependedAbove, prependRestoreTarget } from './transcript-follow.ts';
import { CompactionCard, CompactionStrip } from './compaction-card.tsx';
import { JumpToLatest } from './jump-to-latest.tsx';
import type { SendCancel, SendRetry, SendSubmit } from './ledger-message.tsx';
import { LiveActivityLine } from '../transcript/live-activity.tsx';
import { useQuoteMenu } from '@ferretry/app';
import type { SendDismiss, SendExpand } from './settled-send-note.tsx';
import { type TranscriptHistoryControl, TranscriptHistoryRow, wantsOlder } from './transcript-history-row.tsx';
import { TranscriptRow } from './transcript-row.tsx';
import { STAGED_MARKER_CLASS, watchStagedReadings } from './transcript-staging.ts';
import { RowSlot } from './row-slots.tsx';
import { CONVERSATION_ROW_SLOT } from '../../contract/index.ts';

export interface TranscriptProps {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly entries: readonly TranscriptEntry[];
  readonly busy?: boolean;
  readonly label?: string;
  /** Offered on ledger rows. Absent means retry is not available here. */
  readonly onRetry?: SendRetry;
  /** Offered on ledger rows. Absent means a message cannot be cancelled from here. */
  readonly onCancel?: SendCancel;
  /** Offered on ledger rows. Absent means Enter cannot be pressed for a typed message from here. */
  readonly onSubmit?: SendSubmit;
  /** Offered on a send that is not delivered. Absent means it cannot be put away from here. */
  readonly onDismiss?: SendDismiss;
  /** Opens or folds a settled send's one-line note. */
  readonly onExpand?: SendExpand;
  /** The harness's own live status line while `busy`, when its pane could be read. */
  readonly activity?: PaneActivity | null;
  /** The daemon's activity sentence, shown when the pane said nothing readable. */
  readonly activityFallback?: string | null;
  /** The working turn's start (`state.turnStateAt`), which the live line's clock runs from. */
  readonly turnStartedAt?: string | null;
  /** The latest live sample off the session's stream, for the live line's token counts. */
  readonly live?: FerretLiveActivity | null;
  /** The agent's own name, which every assistant row is labelled with instead of a harness or account. */
  readonly agentName?: string;
  /** The live line is drawn elsewhere (beside the agenda pill above the composer), so not at the foot of the log. */
  readonly liveInRow?: boolean;
  /** The agenda row's slot for the Jump-to-latest pill (`AgendaLine`): with it the transcript keeps no pill row. */
  readonly jumpHost?: HTMLElement | null;
  /**
   * Bumped to put the reader back at the tail and re-engage follow — the reader just SENT something,
   * so they want to watch the reply arrive even if they had scrolled up to re-read while composing.
   * Opening a session needs no bump: a new daemon or session id does the same thing by itself.
   */
  readonly pinSignal?: number;
  /** Where this session's reading position is kept, so coming back finds it (`useStickToBottom`). */
  readonly readingPosition?: ChatScrollSlot;
  /** Older messages above the first one shown, loaded as the reader nears the top. Absent: none offered. */
  readonly history?: TranscriptHistoryControl;
}
/**
 * An assistant row labelled with the agent's name — "Hadi" rather than "Assistant", the harness, or the
 * runtime's account. The row's time is not part of the label: it is the row's own instant, drawn at the
 * foot of the message on the reader's clock.
 */
const withAgentName = (entry: TranscriptEntry, agentName: string): TranscriptEntry =>
  entry.kind !== 'assistant' || agentName === '' ? entry : { ...entry, label: agentName };

/**
 * Return `value`, except while `hold` is engaged — then keep returning what it was when the hold
 * began, and flush to the current one on release.
 *
 * A WebKit selection dies when the element it sits in re-renders, and the block a reader selects
 * from is usually the one still streaming in. So while a selection or a pressed pointer holds the
 * transcript still, it keeps showing what it had and catches up the instant the reader lets go. A
 * ref written during render, deliberately: an effect would be a frame late, and a frame late here is
 * one more mutation under a live selection.
 */
function useHeldStill<T>(value: T, hold: boolean): T {
  const shown = useRef(value);
  if (!hold) shown.current = value;
  return shown.current;
}

/**
 * One scroll controller for transcript content, following kteam's model (`useStickToBottom`): it
 * follows the tail until the reader scrolls up, then counts the rows that arrive for the "N new —
 * jump to latest" pill while the browser's own scroll anchoring holds their place. Rows inserted
 * ABOVE a detached reader restore their distance from the bottom.
 *
 * Its identity includes both daemon and session, so a same-named session cannot inherit another
 * daemon's scroll state, and a new identity always opens at the latest message.
 */
export function Transcript({
  daemonId,
  sessionId,
  entries,
  busy = false,
  label = 'Transcript',
  onRetry,
  onCancel,
  onSubmit,
  onDismiss,
  onExpand,
  activity = null,
  activityFallback = null,
  turnStartedAt = null,
  live = null,
  agentName,
  liveInRow = false,
  jumpHost = null,
  pinSignal = 0,
  readingPosition,
  history,
}: TranscriptProps) {
  const hold = useTranscriptHold();
  const shown = useHeldStill({ entries, busy, activity, activityFallback, turnStartedAt, live }, hold);
  const items = transcriptItems(shown.entries);
  const runs = agentRuns(items);
  // The text still arriving is the last ASSISTANT item, not the last row: a message the owner queued mid-stream sits after it.
  const lastAssistantIndex = items.findLastIndex(item => item.entry.kind === 'assistant');
  const compaction = shown.live?.compaction;
  const stripAt =
    compaction?.phase === 'done'
      ? compactionStripIndex(
          compaction,
          items.map(item => item.entry),
        )
      : null;
  const ids = items.map(item => item.entry.id);
  const lastId = ids.at(-1) ?? null;
  const firstId = ids[0] ?? null;

  // ---- STAGING: an older page stays hidden until its rows are their final height (`transcript-staging.ts`) ----------
  // Decided during the render that brings the page, so no frame ever lays the rows out before they are hidden.
  const [staging, setStaging] = useState<{ readonly before: string; readonly since: number } | null>(null);
  const [seenFirstId, setSeenFirstId] = useState(firstId);
  if (firstId !== seenFirstId) {
    setSeenFirstId(firstId);
    if (staging === null && seenFirstId !== null && prependedAbove(ids, seenFirstId))
      setStaging({ before: seenFirstId, since: performance.now() });
  }
  /** The first row on screen while older rows above it are staged; null when nothing is. */
  const stagedBefore = staging !== null && ids.includes(staging.before) ? staging.before : null;
  const visibleFirstId = stagedBefore ?? firstId;

  const [newCount, setNewCount] = useState(0);
  const prevLastId = useRef<string | null>(null);
  const prevCount = useRef(0);
  const prevFirstId = useRef<string | null>(null);
  const prevVisibleFirstId = useRef<string | null>(null);
  const clearCount = useCallback(() => setNewCount(0), []);
  // A new daemon or session is a newly opened transcript; a bumped `pinSignal` is the reader having
  // just sent something. Either lands at the latest message and follows.
  const { viewportRef, contentRef, following, gap, jumpShown, onScroll, jumpToLatest, scrollTo } = useStickToBottom({
    resetKey: `${daemonId}\u0000${sessionId}\u0000${pinSignal}`,
    // Staged rows going on screen are new content too: a following reader is re-pinned in that commit.
    contentKeys: [shown.entries, shown.busy, stagedBefore],
    onFollow: clearCount,
    ...(readingPosition === undefined ? {} : { memory: readingPosition }),
  });

  // ---- DETACHED: count the rows that arrived at the tail, for the pill -----------------------------
  // Declared after the hook, so a reset in the same commit has already re-engaged follow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the last id and row count are the trigger
  useEffect(() => {
    const added = following.current ? 0 : newTailRows(ids, prevLastId.current, prevCount.current);
    if (added > 0) setNewCount(count => count + added);
    prevLastId.current = lastId;
    prevCount.current = ids.length;
  }, [lastId, ids.length]);

  // The staged rows go on screen together once none of them is still being read, or the patience runs out.
  const stagingSince = staging?.since;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new staging (its start) or its boundary leaving is the trigger
  useEffect(() => {
    if (stagingSince === undefined) return;
    const content = contentRef.current;
    if (content === null || stagedBefore === null) {
      setStaging(null);
      return;
    }
    return watchStagedReadings(content, stagingSince, () => setStaging(null));
  }, [stagingSince, stagedBefore]);

  // ---- PREPEND: hold a detached reader's content still, before paint -------------------------------
  // Twice for a staged page: when it arrives (the first row on screen now has a row before it, which can change its own
  // spacing) and when it is shown (the rows themselves).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first row, the first row on screen and the row count are the trigger
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const onScreen = stagedBefore === null ? ids : ids.slice(ids.indexOf(stagedBefore));
    const moved = prependedAbove(ids, prevFirstId.current) || prependedAbove(onScreen, prevVisibleFirstId.current);
    if (element !== null && !following.current && moved) {
      const target = prependRestoreTarget(element, gap.current);
      if (target !== undefined) scrollTo(target);
    }
    prevFirstId.current = firstId;
    prevVisibleFirstId.current = visibleFirstId;
  }, [firstId, visibleFirstId, ids.length]);

  // ---- OLDER HISTORY: read the page before the first row as the reader nears the top ----------------
  // Asked on every scroll and again after every change to the rows or the status, so a page that added
  // nothing to see — a run of tool calls, a stretch of bookkeeping — is followed by the next one at once,
  // and a transcript too short to scroll keeps loading until it fills the screen or reaches the start.
  // Staged rows are still loading to the reader: the row says so, and nothing older is asked for until they are shown.
  const historyStatus = stagedBefore !== null && history !== undefined ? 'loading' : (history?.status ?? 'unavailable');
  const loadOlder = history?.loadOlder;
  const askOlder = useCallback(() => {
    const element = viewportRef.current;
    if (element !== null && loadOlder !== undefined && wantsOlder(historyStatus, element.scrollTop)) loadOlder();
  }, [historyStatus, loadOlder, viewportRef]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the row count is the trigger
  useEffect(askOlder, [askOlder, ids.length]);
  const onTranscriptScroll = useCallback(() => {
    onScroll();
    askOlder();
  }, [askOlder, onScroll]);

  const quote = useQuoteMenu(
    viewportRef,
    useMemo(() => ({ daemonId, ferretId: sessionId }), [daemonId, sessionId]),
  );

  return (
    <section aria-label={label} className="fy-transcript-shell" data-daemon-id={daemonId} data-session-id={sessionId}>
      <div
        className="fy-transcript"
        /* Pulling down here loads older messages. The global finder gesture must
           not take that away, so this scroller declines it by name. */
        {...{ [PULL_TO_PALETTE_IGNORE_ATTR]: '' }}
        {...quote.handlers}
        onScroll={onTranscriptScroll}
        ref={viewportRef}
        role="log"
        aria-live="polite"
      >
        <div className="fy-transcript-content" ref={contentRef}>
          {history === undefined ? null : (
            <TranscriptHistoryRow control={stagedBefore === null ? history : { ...history, status: historyStatus }} />
          )}
          {items.map((item, index) => (
            <Fragment key={item.entry.id}>
              {item.entry.id === stagedBefore ? <div aria-hidden="true" className={STAGED_MARKER_CLASS} /> : null}
              {compaction?.phase === 'done' && stripAt === index ? <CompactionStrip compaction={compaction} /> : null}
              <TranscriptRow
                answered={item.answered === true}
                entry={agentName === undefined ? item.entry : withAgentName(item.entry, agentName)}
                isLast={index === items.length - 1}
                lastAssistant={index === lastAssistantIndex}
                live={shown.busy}
                onCancel={onCancel}
                onDismiss={onDismiss}
                onExpand={onExpand}
                onRetry={onRetry}
                onSubmit={onSubmit}
                previous={item.previous}
                run={runs[index]}
              />
              <RowSlot entry={item.entry} slot={CONVERSATION_ROW_SLOT} />
            </Fragment>
          ))}
          {compaction?.phase === 'done' && stripAt === items.length ? (
            <CompactionStrip compaction={compaction} />
          ) : null}
          {compaction?.phase === 'running' ? <CompactionCard compaction={compaction} /> : null}
          {shown.busy && !liveInRow && compaction?.phase !== 'running' ? (
            <LiveActivityLine
              activity={shown.activity}
              fallback={shown.activityFallback}
              live={shown.live}
              turnStartedAt={shown.turnStartedAt}
            />
          ) : null}
        </div>
      </div>
      {quote.menu}
      <JumpToLatest count={newCount} host={jumpHost} onJump={jumpToLatest} shown={jumpShown} />
    </section>
  );
}
