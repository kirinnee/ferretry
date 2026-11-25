/**
 * Terminal tab content for the session screen. Ported from
 * `ui/src/components/TerminalView.tsx`, keeping its three deliberate
 * behaviours:
 *
 *  - polling is gated on the document being visible, so a backgrounded tab
 *    costs the daemon nothing;
 *  - it sticks to the bottom unless the reader scrolled up — kteam's follow model
 *    (`useStickToBottom`), shared with the Chat transcript: it opens at the tail,
 *    follows each new capture, stops only for a scroll-up the reader made, and
 *    resumes when they come back down or press "jump to latest";
 *  - the header states the tmux session plus a "cached · updated <n>s ago"
 *    hint, so freshness is never a guess.
 *
 * ON EVERY SCREEN two more things hold. The pane FITS ITS WIDTH by default when that keeps the text at 10px or more — the text
 * is sized so the widest captured line fits (`fitFontPx`), instead of being cut at the right edge
 * behind a sideways scroll; a narrower pane opens in Scroll at full size — with a Fit / Scroll toggle in the header for the reader who wants 12px
 * and a scrollbar (a host that asks for `wrapLines`, the Console, gets a third way: the lines WRAP at the pane's edge, which is the
 * default there when fitting would be unreadable, so no word is ever cut off at the right). And the header is one short row: the terminal glyph and a "live" dot, its words
 * kept for screen readers and the tooltip.
 *
 * What changed for Ferretry: the read is bound to one paired daemon. The
 * original polled a page-global client, which cannot be right when two daemons
 * are paired and both know a session by that id.
 */

import { Terminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStickToBottom } from '@ferretry/app';
import { JumpToLatest, useLinkBehaviour } from '@ferretry/app/ui';
import { type DaemonConnection, type DaemonSessionScope, daemonSessionKey } from '../shell.ts';
import { splitLinkedRuns } from '../lib/terminal-links.ts';
import {
  describeSnapshotError,
  fitFontPx,
  fitIsReadable,
  formatSnapshotAge,
  formatSnapshotClock,
  paneColumns,
  trimBlankTail,
} from './terminal-snapshot-model.ts';

/** The `<pre>`'s horizontal padding (`px-3`), which the fitted text does not get to use. */
const PANE_PADDING_X_PX = 24;

const POLL_MS = 3_000;

/** The daemon read, injected so tests and the visual harness never open a socket. */
export type PaneSnapshotReader = (daemon: DaemonConnection, scope: DaemonSessionScope) => Promise<string>;

export interface TerminalSnapshotViewProps {
  daemon: DaemonConnection;
  scope: DaemonSessionScope;
  /** Optional host-runtime identity. Remote readers deliberately cannot call
   * the loopback-only attach route, so absence is rendered as absence rather
   * than replacing it with the public session id. */
  tmuxSession?: string;
  /** Overridable so a test can drive the clock instead of waiting on it. */
  now?: () => number;
  /** The daemon read: this half's client (`readPaneSnapshot`), supplied by the host, so a view never reaches a daemon itself. */
  readSnapshot: PaneSnapshotReader;
  /** Changing this captures the pane now rather than at the next poll — the Console bumps it after a write. */
  refreshKey?: number;
  /** The pane's font, when the host draws it with something other than the theme's monospace stack. */
  fontFamily?: string;
  /** The reader is a live capture rather than the stored frame, so the header says "live", not "cached". */
  live?: boolean;
  /** Offer Wrap (long lines break at the pane's edge) and open in it where Fit would shrink the text: for a narrow side pane. */
  wrapLines?: boolean;
}

/** How the pane's text meets its edge. */
type PaneMode = 'fit' | 'wrap' | 'scroll';

export const TerminalSnapshotView = ({
  daemon,
  scope,
  tmuxSession,
  now = Date.now,
  readSnapshot,
  refreshKey = 0,
  fontFamily,
  live = false,
  wrapLines = false,
}: TerminalSnapshotViewProps) => {
  const [text, setText] = useState('');
  // `stale` is a failed read; whether it is "stale" or "unreadable" depends on whether a snapshot was ever read
  // (`lastUpdatedAt`): a failure before the first one has nothing to be stale.
  const [stale, setStale] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(() => now());

  // The whole pane belongs to exactly one (daemon, session): switching either
  // must not leave the previous daemon's text on screen for even one frame.
  // Adjusting during render rather than in an effect is what makes that true —
  // an effect would repaint the old daemon's output once before clearing it.
  const key = daemonSessionKey(scope);
  const [renderedKey, setRenderedKey] = useState(key);
  if (renderedKey !== key) {
    setRenderedKey(key);
    setText('');
    setStale(false);
    setErrorMessage(null);
    setLastUpdatedAt(null);
  }
  // STICK TO THE BOTTOM, NEVER TO THE LEFT. New output arrives at the end, and a reader who is there
  // wants to stay there; a new (daemon, session) opens at the tail. The horizontal offset is the
  // reader's: a terminal line is routinely wider than the pane, and resetting `scrollLeft` yanked
  // anyone reading the right-hand end of a line back to column 0 every poll. The pin is a layout
  // effect on the new text, so it reaches the height the new capture actually laid out to.
  const { viewportRef, contentRef, jumpShown, onScroll, jumpToLatest } = useStickToBottom({
    resetKey: key,
    contentKeys: [text],
  });

  const poll = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const snapshot = await readSnapshot(daemon, scope);
      setText(trimBlankTail(snapshot));
      setLastUpdatedAt(now());
      setStale(false);
      setErrorMessage(null);
    } catch (error) {
      // Keep the last good content and say so: a momentarily unreachable
      // daemon is not an empty terminal.
      setStale(true);
      setErrorMessage(describeSnapshotError(error, live ? 'the Console' : 'this terminal'));
    }
  }, [daemon, live, now, readSnapshot, scope]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer !== null) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  // A write just landed: show what it did now, not up to a poll interval later.
  useEffect(() => {
    if (refreshKey > 0) void poll();
  }, [poll, refreshKey]);

  // One re-render a second keeps "updated <n>s ago" honest without touching
  // the daemon.
  useEffect(() => {
    const timer = setInterval(() => setTick(now()), 1_000);
    return () => clearInterval(timer);
  }, [now]);

  // FIT TO WIDTH: the default while the fitted text stays readable (>= 10px; a side pane or phone that would shrink it further opens in Scroll at full size), the reader's choice after one tap. The pane's width is measured
  // and re-measured as it resizes (rotation, the keyboard); a browser without ResizeObserver keeps the
  // first measurement.
  const [modeChoice, setModeChoice] = useState<PaneMode | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const textWidth = paneWidth - PANE_PADDING_X_PX;
  const fitted = fitIsReadable(paneColumns(text), textWidth);
  const mode: PaneMode = modeChoice ?? (fitted ? 'fit' : wrapLines ? 'wrap' : 'scroll');
  const fit = mode === 'fit';
  const wrap = mode === 'wrap';
  /** What one tap on the toggle moves to: Fit and Scroll swap; where lines may wrap, Fit goes to Wrap, then Scroll, then Fit. */
  const nextMode: PaneMode = wrapLines ? (fit ? 'wrap' : wrap ? 'scroll' : 'fit') : fit ? 'scroll' : 'fit';
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const measure = (): void => setPaneWidth(viewport.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewportRef]);
  const fontSize = fit ? fitFontPx(paneColumns(text), textWidth) : undefined;
  // Addresses in the capture are real anchors, opened by the one "Open links in" decision. The text
  // is unchanged, so the fit measurement above and the copied selection read exactly what was captured.
  const links = useLinkBehaviour();
  const runs = useMemo(() => splitLinkedRuns(text), [text]);
  const preStyle = {
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(fontSize === undefined ? {} : { fontSize: `${fontSize}px` }),
  };

  const age = lastUpdatedAt === null ? '—' : formatSnapshotAge(tick - lastUpdatedAt);
  const absolute = lastUpdatedAt === null ? '' : formatSnapshotClock(lastUpdatedAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft bg-surface-2 px-3 py-1.5 text-[11.5px] text-fg-soft">
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Terminal size={13} className="text-muted" aria-hidden="true" />
          <span className="font-semibold text-fg max-md:sr-only">Terminal</span>
        </span>
        {tmuxSession === undefined ? (
          <span className="mono min-w-0 max-w-[18rem] truncate text-muted max-md:hidden">managed session pane</span>
        ) : (
          <span className="mono min-w-0 max-w-[18rem] truncate text-muted max-md:hidden" title={tmuxSession}>
            tmux: {tmuxSession}
          </span>
        )}
        <span className="mono ml-auto inline-flex min-w-0 max-w-full items-center gap-1.5 text-[11px]" role="status">
          {stale ? (
            <span className="text-warn" title={errorMessage ?? 'stale'}>
              {lastUpdatedAt === null ? 'unreadable' : 'stale'}
              <span className="max-md:sr-only">
                {lastUpdatedAt === null ? '' : ` · last update ${age} ago`}
                {errorMessage ? ` · ${errorMessage}` : ''}
              </span>
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-muted"
              title={`updated ${age} ago${absolute === '' ? '' : ` (${absolute})`}`}
            >
              {live ? (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-ok" data-terminal-live-dot="" />
              ) : null}
              {live ? 'live' : 'cached'}
              <span className="max-md:sr-only"> · updated {age} ago</span>
            </span>
          )}
        </span>
        <button
          type="button"
          aria-pressed={fit}
          aria-label={wrapLines ? 'How long lines meet the pane edge' : 'Fit the pane to the screen width'}
          className="mono h-6 rounded-sm border border-border-soft px-2 text-[11px] text-muted hover:text-fg"
          data-terminal-fit=""
          onClick={() => setModeChoice(nextMode)}
          title={
            fit
              ? `Fitted to the screen — tap to ${wrapLines ? 'wrap long lines' : 'scroll sideways at full size'}`
              : wrap
                ? 'Long lines wrap — tap to scroll sideways at full size'
                : 'Full size — tap to fit the screen width'
          }
        >
          {fit ? 'Fit' : wrap ? 'Wrap' : 'Scroll'}
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-auto bg-code-bg text-fg-soft"
          data-testid="terminal-snapshot-scroller"
        >
          <div className={wrap ? 'min-w-0' : 'min-w-max'} ref={contentRef}>
            <pre
              className={`mono m-0 px-3 py-2 text-[12px] leading-[1.5] ${
                wrap ? 'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]' : 'min-w-max whitespace-pre'
              }`}
              data-terminal-fit-px={fontSize}
              style={preStyle}
            >
              {text === ''
                ? '(no snapshot yet)'
                : runs.map(run =>
                    run.kind === 'text' ? (
                      run.text
                    ) : (
                      <a
                        className="text-accent underline-offset-2 hover:underline focus-visible:underline"
                        data-terminal-link=""
                        href={run.href}
                        key={run.at}
                        onClick={event => links.activate(event, { href: run.href, element: event.currentTarget })}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {run.text}
                      </a>
                    ),
                  )}
            </pre>
            {links.sheet}
          </div>
        </div>
        <JumpToLatest onJump={jumpToLatest} shown={jumpShown} />
      </div>
    </div>
  );
};
