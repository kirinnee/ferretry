import type { SessionLiveActivity } from '@ferretry/protocol';
import { Fragment, type MouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import { useTranscriptHold } from '../hooks/use-live-clock.ts';
import { PULL_TO_PALETTE_IGNORE_ATTR } from '../hooks/use-pull-to-palette.ts';
import { useStickToBottom } from '../hooks/use-stick-to-bottom.ts';
import { compactionStripIndex } from '../lib/compaction-readout.ts';
import { type ContextMenuEventLike, textContextMenuEventAllowed } from '../lib/context-menu-policy.ts';
import { daemonId as toDaemonId } from '../lib/daemon-connection.ts';
import type { PaneActivity } from '../lib/pane-activity.ts';
import { quoteSelectionIntoComposer } from '../lib/quote.ts';
import type { ChatScrollSlot } from '../lib/scroll-memory.ts';
import { agentRuns, type TranscriptEntry, transcriptItems } from '../lib/session-screens.ts';
import { newTailRows, prependedAbove, prependRestoreTarget } from '../lib/transcript-follow.ts';
import { ContextMenu, type ContextMenuItem } from '../shell/context-menu.tsx';
import { CompactionCard, CompactionStrip } from './compaction-card.tsx';
import { JumpToLatest } from './jump-to-latest.tsx';
import type { SendCancel, SendRetry, SendSubmit } from './ledger-message.tsx';
import { LiveActivityLine } from './live-activity.tsx';
import type { SendDismiss, SendExpand } from './settled-send-note.tsx';
import { TranscriptRow } from './transcript-row.tsx';

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
  readonly live?: SessionLiveActivity | null;
  /** The agent's own name, which every assistant row is labelled with instead of a harness or account. */
  readonly agentName?: string;
  /** The live line is drawn elsewhere (beside the agenda pill above the composer), so not at the foot of the log. */
  readonly liveInRow?: boolean;
  /**
   * Bumped to put the reader back at the tail and re-engage follow — the reader just SENT something,
   * so they want to watch the reply arrive even if they had scrolled up to re-read while composing.
   * Opening a session needs no bump: a new daemon or session id does the same thing by itself.
   */
  readonly pinSignal?: number;
  /** Where this session's reading position is kept, so coming back finds it (`useStickToBottom`). */
  readonly readingPosition?: ChatScrollSlot;
}
/**
 * An assistant row labelled with the agent's name — "Hadi" rather than "Assistant", the harness, or the
 * runtime's account. The row's time is not part of the label: it is the row's own instant, drawn at the
 * foot of the message on the reader's clock.
 */
export const withAgentName = (entry: TranscriptEntry, agentName: string): TranscriptEntry =>
  entry.kind !== 'assistant' || agentName === '' ? entry : { ...entry, label: agentName };

/** The selection surface needed to decide whether transcript prose is quotable. */
export interface QuoteSelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
  toString(): string;
}

/**
 * Returns a trimmed transcript selection, or an empty string when the browser
 * selection belongs to another surface. Either endpoint inside is enough: a
 * reader may extend a range from text just above the visible transcript.
 */
export const quotableTranscriptSelectionText = (
  selection: QuoteSelectionLike | null,
  contains: (node: Node | null) => boolean,
): string => {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return '';
  if (!contains(selection.anchorNode) && !contains(selection.focusNode)) return '';
  return selection.toString().trim();
};

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
  pinSignal = 0,
  readingPosition,
}: TranscriptProps) {
  const hold = useTranscriptHold();
  const shown = useHeldStill({ entries, busy, activity, activityFallback, turnStartedAt, live }, hold);
  const items = transcriptItems(shown.entries);
  const runs = agentRuns(items);
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

  const [newCount, setNewCount] = useState(0);
  const prevLastId = useRef<string | null>(null);
  const prevCount = useRef(0);
  const prevFirstId = useRef<string | null>(null);
  const clearCount = useCallback(() => setNewCount(0), []);
  // A new daemon or session is a newly opened transcript; a bumped `pinSignal` is the reader having
  // just sent something. Either lands at the latest message and follows.
  const { viewportRef, contentRef, following, gap, detached, onScroll, jumpToLatest, scrollTo } = useStickToBottom({
    resetKey: `${daemonId}\u0000${sessionId}\u0000${pinSignal}`,
    contentKeys: [shown.entries, shown.busy],
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

  // ---- PREPEND: hold a detached reader's content still, before paint -------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first id and row count are the trigger
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element !== null && !following.current && prependedAbove(ids, prevFirstId.current)) {
      const target = prependRestoreTarget(element, gap.current);
      if (target !== undefined) scrollTo(target);
    }
    prevFirstId.current = firstId;
  }, [firstId, ids.length]);

  const lastPointerType = useRef<string | null>(null);
  const quoteTrigger = useRef<HTMLElement | null>(null);
  const [quoteMenu, setQuoteMenu] = useState<{ readonly x: number; readonly y: number; readonly text: string } | null>(
    null,
  );
  const { touchAffected } = useInputModality();

  const onQuoteContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
    const root = viewportRef.current;
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    const text = root
      ? quotableTranscriptSelectionText(
          selection as QuoteSelectionLike | null,
          node => node !== null && root.contains(node),
        )
      : '';
    const allowed = textContextMenuEventAllowed(event.nativeEvent as ContextMenuEventLike, {
      lastPointerType: lastPointerType.current,
      touchAffected,
      hasSelection: text.length > 0,
    });

    // A phone's long-press is the native text-selection gesture. Leaving this
    // event alone preserves its handles and copy menu; session-row long-press
    // handling remains separate in row-context-gesture.ts.
    if (!allowed || !text) return;
    event.preventDefault();
    quoteTrigger.current = event.currentTarget;
    setQuoteMenu({ x: event.clientX, y: event.clientY, text });
  };

  const quoteMenuItems: readonly ContextMenuItem[] =
    quoteMenu === null
      ? []
      : [
          {
            key: 'quote',
            label: 'Quote in composer',
            onSelect: () => quoteSelectionIntoComposer(quoteMenu.text, { daemonId: toDaemonId(daemonId), sessionId }),
          },
        ];

  return (
    <section aria-label={label} className="fy-transcript-shell" data-daemon-id={daemonId} data-session-id={sessionId}>
      <div
        className="fy-transcript"
        /* Pulling down here loads older messages. The global finder gesture must
           not take that away, so this scroller declines it by name. */
        {...{ [PULL_TO_PALETTE_IGNORE_ATTR]: '' }}
        onContextMenu={onQuoteContextMenu}
        onPointerDownCapture={event => {
          lastPointerType.current = event.pointerType || 'unknown';
        }}
        onTouchStartCapture={() => {
          // Some WebKit paths expose the later contextmenu as a plain
          // MouseEvent. This is the touch press that began its long-press.
          lastPointerType.current = 'touch';
        }}
        onScroll={onScroll}
        ref={viewportRef}
        role="log"
        aria-live="polite"
      >
        <div className="fy-transcript-content" ref={contentRef}>
          {items.map((item, index) => (
            <Fragment key={item.entry.id}>
              {compaction?.phase === 'done' && stripAt === index ? <CompactionStrip compaction={compaction} /> : null}
              <TranscriptRow
                answered={item.answered === true}
                entry={agentName === undefined ? item.entry : withAgentName(item.entry, agentName)}
                isLast={index === items.length - 1}
                live={shown.busy}
                onCancel={onCancel}
                onDismiss={onDismiss}
                onExpand={onExpand}
                onRetry={onRetry}
                onSubmit={onSubmit}
                previous={item.previous}
                run={runs[index]}
              />
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
      <ContextMenu
        anchor={quoteMenu ?? { x: 0, y: 0 }}
        ariaLabel="Quote menu"
        items={quoteMenuItems}
        onClose={() => setQuoteMenu(null)}
        open={quoteMenu !== null}
        touch={touchAffected}
        triggerRef={quoteTrigger}
      />
      {detached ? <JumpToLatest count={newCount} onJump={jumpToLatest} /> : null}
    </section>
  );
}
