import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import { PULL_TO_PALETTE_IGNORE_ATTR } from '../hooks/use-pull-to-palette.ts';
import { type ContextMenuEventLike, textContextMenuEventAllowed } from '../lib/context-menu-policy.ts';
import { daemonId as toDaemonId } from '../lib/daemon-connection.ts';
import type { PaneActivity } from '../lib/pane-activity.ts';
import { quoteSelectionIntoComposer } from '../lib/quote.ts';
import { detailsLabel, type TranscriptEntry, transcriptIsFollowing, transcriptItems } from '../lib/session-screens.ts';
import { ContextMenu, type ContextMenuItem } from '../shell/context-menu.tsx';
import type { SendRetry } from './ledger-message.tsx';
import { LiveActivityLine } from './live-activity.tsx';
import { TranscriptRow } from './transcript-row.tsx';

export interface TranscriptProps {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly entries: readonly TranscriptEntry[];
  readonly busy?: boolean;
  readonly label?: string;
  /** Offered on ledger rows. Absent means retry is not available here. */
  readonly onRetry?: SendRetry;
  /** The harness's own live status line while `busy`, when its pane could be read. */
  readonly activity?: PaneActivity | null;
  /** The daemon's activity sentence, shown when the pane said nothing readable. */
  readonly activityFallback?: string | null;
  /** Folded runs start open (Settings › Show details). Each can still be toggled on its own. */
  readonly detailsShown?: boolean;
  /** The agent's own name, which every assistant row is labelled with instead of a harness or account. */
  readonly agentName?: string;
}

/**
 * One folded run of bookkeeping rows. Closed it is a single quiet line — "Show details (2 system
 * events)" — and open it lists every row it holds in the transcript's small mono chrome, so nothing
 * the daemon recorded is ever unreachable, only out of the way.
 */
function TranscriptDetails({
  entries,
  open,
  onToggle,
}: {
  readonly entries: readonly TranscriptEntry[];
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div
      className="fy-transcript-details"
      data-transcript-density="chrome"
      data-transcript-details={open ? 'open' : 'closed'}
    >
      <button aria-expanded={open} className="fy-transcript-details-toggle" onClick={onToggle} type="button">
        {open ? 'Hide details' : `Show details (${detailsLabel(entries.length)})`}
      </button>
      {open ? (
        <ul className="fy-transcript-details-list">
          {entries.map(entry => (
            <li key={entry.id}>
              <span className="fy-transcript-details-label">{entry.label}</span> {entry.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * An assistant row labelled with the agent's name — "Hadi · 10:11:13" rather than "Assistant", the
 * harness, or the runtime's account. The clock the daemon printed is kept.
 */
export const withAgentName = (entry: TranscriptEntry, agentName: string): TranscriptEntry => {
  if (entry.kind !== 'assistant' || agentName === '') return entry;
  const clock = /\u00b7\s*(\d{2}:\d{2}:\d{2})$/u.exec(entry.label ?? '')?.[1];
  return { ...entry, label: clock === undefined ? agentName : `${agentName} · ${clock}` };
};

type ScrollPort = { scrollHeight: number; scrollTop: number; clientHeight: number };

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
 * One scroll controller for transcript content. Its identity includes both
 * daemon and session so a same-named session cannot retain another daemon's
 * scroll/follow state when its host switches connection.
 */
export function Transcript({
  daemonId,
  sessionId,
  entries,
  busy = false,
  label = 'Transcript',
  onRetry,
  activity = null,
  activityFallback = null,
  detailsShown = false,
  agentName,
}: TranscriptProps) {
  const viewport = useRef<ScrollPort | null>(null);
  const viewportElement = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const lastPointerType = useRef<string | null>(null);
  const quoteTrigger = useRef<HTMLElement | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [quoteMenu, setQuoteMenu] = useState<{ readonly x: number; readonly y: number; readonly text: string } | null>(
    null,
  );
  const previousLength = useRef(entries.length);
  // The runs the reader flipped away from the default, so a setting change re-applies to every other run.
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(() => new Set());
  const toggleDetails = useCallback((id: string) => {
    setOpenDetails(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const { touchAffected } = useInputModality();

  // Follow position and the unread counter are browser-local state, but their
  // meaning belongs to the daemon/session transcript currently on screen. A
  // daemon switch can legitimately keep the same session id, so reset before
  // the follow effect runs rather than carrying a detached reader into another
  // daemon's transcript.
  // biome-ignore lint/correctness/useExhaustiveDependencies: daemon/session are deliberate reset triggers
  useEffect(() => {
    following.current = true;
    previousLength.current = entries.length;
    setNewCount(0);
    setOpenDetails(new Set());
  }, [daemonId, sessionId]);

  // These deps are the TRIGGER, not inputs. The body reads only refs, so the rule sees them as
  // unnecessary — but dropping them stops the viewport following new entries, which is the entire
  // purpose of the effect. Re-running on a daemon or session change also resets the scroll for the
  // newly shown transcript.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger deps, see comment above
  useEffect(() => {
    const element = viewport.current;
    if (!element || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [daemonId, sessionId, entries, busy]);

  useEffect(() => {
    if (entries.length <= previousLength.current) {
      previousLength.current = entries.length;
      return;
    }
    if (following.current) setNewCount(0);
    else setNewCount(count => count + entries.length - previousLength.current);
    previousLength.current = entries.length;
  }, [entries.length]);

  const jumpToLatest = () => {
    const element = viewport.current;
    if (!element) return;
    following.current = true;
    setNewCount(0);
    element.scrollTop = element.scrollHeight;
  };

  const onQuoteContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const root = viewportElement.current;
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
    },
    [touchAffected],
  );

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
        onScroll={() => {
          const element = viewport.current;
          if (!element) return;
          following.current = transcriptIsFollowing(element);
          if (following.current) setNewCount(0);
        }}
        ref={element => {
          viewport.current = element as unknown as ScrollPort | null;
          viewportElement.current = element;
        }}
        role="log"
        aria-live="polite"
      >
        <div className="fy-transcript-content">
          {transcriptItems(entries).map((item, index, items) =>
            item.kind === 'details' ? (
              <TranscriptDetails
                entries={item.entries}
                key={item.id}
                onToggle={() => toggleDetails(item.id)}
                open={detailsShown !== openDetails.has(item.id)}
              />
            ) : (
              <TranscriptRow
                entry={agentName === undefined ? item.entry : withAgentName(item.entry, agentName)}
                isLast={index === items.length - 1}
                key={item.entry.id}
                live={busy}
                onRetry={onRetry}
                previous={item.previous}
              />
            ),
          )}
          {busy ? <LiveActivityLine activity={activity} fallback={activityFallback} /> : null}
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
      {newCount > 0 ? (
        <div className="fy-jump-latest-shell">
          <button className="fy-jump-latest" onClick={jumpToLatest} type="button">
            {newCount} new {newCount === 1 ? 'message' : 'messages'} · Jump to latest
          </button>
        </div>
      ) : null}
    </section>
  );
}
