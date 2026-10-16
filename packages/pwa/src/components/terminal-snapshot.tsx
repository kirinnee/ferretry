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
 * What changed for Ferretry: the read is bound to one paired daemon. The
 * original polled a page-global client, which cannot be right when two daemons
 * are paired and both know a session by that id.
 */

import { Terminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStickToBottom } from '../hooks/use-stick-to-bottom.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import { useDaemonFetch } from '../lib/store.tsx';
import { JumpToLatest } from './jump-to-latest.tsx';
import {
  describeSnapshotError,
  formatSnapshotAge,
  formatSnapshotClock,
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
  /** Changing this captures the pane now rather than at the next poll — the Console bumps it after a write. */
  refreshKey?: number;
  /** The pane's font, when the host draws it with something other than the theme's monospace stack. */
  fontFamily?: string;
  /** The reader is a live capture rather than the stored frame, so the header says "live", not "cached". */
  live?: boolean;
}

export const TerminalSnapshotView = ({
  daemon,
  scope,
  tmuxSession,
  now = Date.now,
  readSnapshot: injectedReader,
  refreshKey = 0,
  fontFamily,
  live = false,
}: TerminalSnapshotViewProps) => {
  // Through the carrier router by default: a paired device has no bearer value of its own to read with.
  const fetcher = useDaemonFetch();
  const readSnapshot = useMemo<PaneSnapshotReader>(
    () => injectedReader ?? ((daemon, scope) => readPaneSnapshot(daemon, scope, undefined, fetcher)),
    [fetcher, injectedReader],
  );
  const [text, setText] = useState('');
  // `stale` only ever turns true after a successful snapshot, so the initial
  // load cannot flash a "stale" chip before the first poll lands.
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
  const { viewportRef, contentRef, detached, onScroll, jumpToLatest } = useStickToBottom({
    resetKey: key,
    contentKeys: [text],
  });

  const poll = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const snapshot = await readSnapshot(daemon, scope);
      setText(snapshot);
      setLastUpdatedAt(now());
      setStale(false);
      setErrorMessage(null);
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
              {live ? 'live' : 'cached'} · updated {age} ago
            </span>
          )}
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-auto bg-code-bg text-fg-soft"
          data-testid="terminal-snapshot-scroller"
        >
          <div className="min-w-max" ref={contentRef}>
            <pre
              className="mono m-0 min-w-max whitespace-pre px-3 py-2 text-[12px] leading-[1.5]"
              {...(fontFamily === undefined ? {} : { style: { fontFamily } })}
            >
              {text || '(no snapshot yet)'}
            </pre>
          </div>
        </div>
        {detached ? <JumpToLatest onJump={jumpToLatest} /> : null}
      </div>
    </div>
  );
};
