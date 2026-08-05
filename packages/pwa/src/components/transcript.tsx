import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import { type ContextMenuEventLike, textContextMenuEventAllowed } from '../lib/context-menu-policy.ts';
import { daemonId as toDaemonId } from '../lib/daemon-connection.ts';
import { quoteSelectionIntoComposer } from '../lib/quote.ts';
import type { LedgerSendRecord } from '../lib/send-ledger.ts';
import { type TranscriptEntry, transcriptIsFollowing } from '../lib/session-screens.ts';
import { ContextMenu, type ContextMenuItem } from '../shell/context-menu.tsx';
import { TranscriptRow } from './transcript-row.tsx';

export interface TranscriptProps {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly entries: readonly TranscriptEntry[];
  readonly busy?: boolean;
  readonly label?: string;
  /** The instant ledger rows read their badges against; injectable for tests. */
  readonly asOf?: number;
  /** Offered on ledger rows. Absent means resend is not available here. */
  readonly onResend?: (record: LedgerSendRecord) => Promise<boolean>;
}

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
  asOf,
  onResend,
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
          {entries.map((entry, index) => (
            <TranscriptRow
              asOf={asOf}
              entry={entry}
              isLast={index === entries.length - 1}
              key={entry.id}
              live={busy}
              onResend={onResend}
              previous={entries[index - 1]}
            />
          ))}
          {busy ? (
            <p className="fy-thinking" data-transcript-density="chrome">
              Working…
            </p>
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
