/**
 * Terminal tab content for the session screen. Ported from
 * `ui/src/components/TerminalView.tsx`, keeping its three deliberate
 * behaviours:
 *
 *  - polling is gated on the document being visible, so a backgrounded tab
 *    costs the daemon nothing;
 *  - sticky scroll stays put unless the reader is already pinned to the bottom;
 *  - the header states the tmux session plus a "cached · updated <n>s ago"
 *    hint, so freshness is never a guess.
 *
 * What changed for Ferretry: the read is bound to one paired daemon. The
 * original polled a page-global client, which cannot be right when two daemons
 * are paired and both know a session by that id.
 */

import { Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import {
  describeSnapshotError,
  formatSnapshotAge,
  formatSnapshotClock,
  isPinnedToBottom,
  readPaneSnapshot,
} from './terminal-snapshot-model.ts';

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
  readSnapshot?: PaneSnapshotReader;
}

const defaultReader: PaneSnapshotReader = (daemon, scope) => readPaneSnapshot(daemon, scope);

export const TerminalSnapshotView = ({
  daemon,
  scope,
  tmuxSession,
  now = Date.now,
  readSnapshot = defaultReader,
}: TerminalSnapshotViewProps) => {
  const [text, setText] = useState('');
  // `stale` only ever turns true after a successful snapshot, so the initial
  // load cannot flash a "stale" chip before the first poll lands.
  const [stale, setStale] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(() => now());

  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

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
    pinnedRef.current = true;
  }

  const poll = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const snapshot = await readSnapshot(daemon, scope);
      setText(snapshot);
      setLastUpdatedAt(now());
      setStale(false);
      setErrorMessage(null);
      const element = scrollerRef.current;
      // STICK TO THE BOTTOM, NEVER TO THE LEFT.
      //
      // Sticky-bottom is a real behaviour: new output arrives at the end, and a
      // reader who is already there wants to stay there. Sticky-LEFT is not —
      // this pane polls every 3s, and a terminal line is routinely wider than
      // the pane (measured: a 640px `<pre>` in a 370px sheet), so resetting
      // `scrollLeft` here yanked anyone reading the right-hand end of a line
      // back to column 0 before they could finish it. The horizontal offset is
      // the reader's; only the vertical one tracks the tail.
      if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
    } catch (error) {
      // Keep the last good content and say so: a momentarily unreachable
      // daemon is not an empty terminal.
      setStale(true);
      setErrorMessage(describeSnapshotError(error));
    }
  }, [daemon, now, readSnapshot, scope]);

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

  // One re-render a second keeps "updated <n>s ago" honest without touching
  // the daemon.
  useEffect(() => {
    const timer = setInterval(() => setTick(now()), 1_000);
    return () => clearInterval(timer);
  }, [now]);

  // Read from the event's own element rather than the ref: the scroller that
  // fired is by definition mounted, so there is no absent-element case to
  // invent a behaviour for.
  const onScroll = useCallback((event: { currentTarget: HTMLDivElement }) => {
    const element = event.currentTarget;
    pinnedRef.current = isPinnedToBottom(element.scrollHeight, element.scrollTop, element.clientHeight);
  }, []);

  const age = lastUpdatedAt === null ? '—' : formatSnapshotAge(tick - lastUpdatedAt);
  const absolute = lastUpdatedAt === null ? '' : formatSnapshotClock(lastUpdatedAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft bg-surface-2 px-3 py-1.5 text-[11.5px] text-fg-soft">
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Terminal size={13} className="text-muted" aria-hidden="true" />
          <span className="font-semibold text-fg">Terminal</span>
        </span>
        {tmuxSession === undefined ? (
          <span className="mono min-w-0 max-w-[18rem] truncate text-muted">managed session pane</span>
        ) : (
          <span className="mono min-w-0 max-w-[18rem] truncate text-muted" title={tmuxSession}>
            tmux: {tmuxSession}
          </span>
        )}
        <span className="mono ml-auto inline-flex shrink-0 items-center gap-1.5 text-[11px]" role="status">
          {stale ? (
            <span className="text-warn" title={errorMessage ?? 'stale'}>
              stale · last update {age} ago{errorMessage ? ` · ${errorMessage}` : ''}
            </span>
          ) : (
            <span className="text-muted" title={absolute}>
              cached · updated {age} ago
            </span>
          )}
        </span>
      </div>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-code-bg text-fg-soft"
        data-testid="terminal-snapshot-scroller"
      >
        <pre className="mono m-0 min-w-max whitespace-pre px-3 py-2 text-[12px] leading-[1.5]">
          {text || '(no snapshot yet)'}
        </pre>
      </div>
    </div>
  );
};
