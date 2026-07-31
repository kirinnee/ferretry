/**
 * Daemon-scoped remote browser display.
 *
 * The stream ticket is supplied by the pairing/runtime host. It is intentionally
 * not retained here (or in a module cache): a PWA page can switch daemons while
 * preserving the same session id, and a stale viewer must never remain live.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserStatus } from '@ferretry/protocol';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { decodeRemoteBrowserFrame, remoteBrowserStreamUrl } from '../../lib/remote-browser.ts';

export interface RemoteBrowserSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void;
  close(code?: number, reason?: string): void;
}

export type RemoteBrowserSocketFactory = (url: string) => RemoteBrowserSocket;

export interface RemoteBrowserViewerProps {
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** A short-lived, daemon-issued credential; never store it in page memory. */
  readonly streamTicket: string | null;
  readonly status: BrowserStatus | null;
  readonly isActive?: boolean;
  readonly stallAfterMs?: number;
  readonly reconnectAfterMs?: number;
  readonly socketFactory?: RemoteBrowserSocketFactory;
  readonly createObjectUrl?: (frame: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

type DisplayState = 'idle' | 'connecting' | 'live' | 'stalled' | 'disconnected';

const defaultSocketFactory: RemoteBrowserSocketFactory = url => new WebSocket(url);
const defaultCreateObjectUrl = (frame: Blob): string => URL.createObjectURL(frame);
const defaultRevokeObjectUrl = (url: string): void => URL.revokeObjectURL(url);

const activePageId = (status: BrowserStatus | null): string | undefined =>
  status !== null && status.state === 'running' && 'activePageId' in status ? status.activePageId : undefined;

/**
 * Renders only the latest JPEG frame. The daemon already coalesces frames; this
 * extra replacement prevents a slow React paint from turning the PWA into an
 * unbounded client-side queue.
 */
export function RemoteBrowserViewer({
  daemon,
  scope,
  streamTicket,
  status,
  isActive = true,
  stallAfterMs = 4_000,
  reconnectAfterMs = 1_200,
  socketFactory = defaultSocketFactory,
  createObjectUrl = defaultCreateObjectUrl,
  revokeObjectUrl = defaultRevokeObjectUrl,
}: RemoteBrowserViewerProps) {
  const [displayState, setDisplayState] = useState<DisplayState>('idle');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const previousUrlRef = useRef<string | null>(null);
  const previousTransportRef = useRef<string | null>(null);

  const running = status?.state === 'running';
  const currentPageId = activePageId(status);
  const transportIdentity = `${daemon.daemonId}\u0000${scope.daemonId}\u0000${scope.sessionId}\u0000${streamTicket ?? ''}`;
  const streamUrl = useMemo(
    () => (streamTicket && running ? remoteBrowserStreamUrl(daemon, scope, streamTicket) : null),
    [daemon, running, scope, streamTicket],
  );
  const retrying = retry > 0;

  useEffect(
    () => () => {
      if (previousUrlRef.current !== null) revokeObjectUrl(previousUrlRef.current);
    },
    [revokeObjectUrl],
  );

  // A frame is daemon-owned data just as much as a status response is. Remove
  // it synchronously when the transport identity changes so a same-id session
  // on daemon B can never briefly display daemon A's page while it connects.
  useEffect(() => {
    if (previousTransportRef.current === transportIdentity) return;
    previousTransportRef.current = transportIdentity;
    if (previousUrlRef.current !== null) revokeObjectUrl(previousUrlRef.current);
    previousUrlRef.current = null;
    setFrameUrl(null);
    setFrameRevision(0);
  }, [revokeObjectUrl, transportIdentity]);

  useEffect(() => {
    if (!isActive || streamUrl === null) {
      setDisplayState('idle');
      return;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const socket = socketFactory(streamUrl);
    socket.binaryType = 'arraybuffer';
    setDisplayState('connecting');
    setError(retrying ? 'Retrying remote display…' : null);

    socket.addEventListener('open', () => {
      if (!disposed) {
        setDisplayState('live');
        setError(null);
      }
    });
    socket.addEventListener('message', event => {
      if (disposed || !(event instanceof MessageEvent) || !(event.data instanceof ArrayBuffer)) return;
      const frame = decodeRemoteBrowserFrame(event.data);
      if (frame === null) return;
      // A tagged frame is only truthful for the daemon's currently active page.
      // Legacy frames predate that identity and are safe only while there is no
      // active-page marker to contradict them.
      if ((frame.kind === 'tagged' && frame.pageId !== currentPageId) || (frame.kind === 'legacy' && currentPageId))
        return;
      const nextUrl = createObjectUrl(new Blob([frame.jpegBytes], { type: 'image/jpeg' }));
      const previousUrl = previousUrlRef.current;
      previousUrlRef.current = nextUrl;
      setFrameUrl(nextUrl);
      if (previousUrl !== null) revokeObjectUrl(previousUrl);
      setFrameRevision(value => value + 1);
      setDisplayState('live');
      setError(null);
    });
    socket.addEventListener('error', () => {
      if (!disposed) setError('The authenticated remote display connection failed.');
    });
    socket.addEventListener('close', event => {
      if (disposed) return;
      setDisplayState('disconnected');
      if (event instanceof CloseEvent && event.code === 1000) return;
      setError('Remote display disconnected; reconnecting…');
      reconnectTimer = setTimeout(() => {
        if (!disposed) setRetry(value => value + 1);
      }, reconnectAfterMs);
    });
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket.close(1000, 'viewer detached');
    };
  }, [createObjectUrl, currentPageId, isActive, reconnectAfterMs, retrying, revokeObjectUrl, socketFactory, streamUrl]);

  useEffect(() => {
    if (displayState !== 'live' || frameRevision === 0) return;
    const timer = setTimeout(() => setDisplayState('stalled'), stallAfterMs);
    return () => clearTimeout(timer);
  }, [displayState, frameRevision, stallAfterMs]);

  const label =
    displayState === 'live'
      ? 'Live display'
      : displayState === 'connecting'
        ? 'Connecting display…'
        : displayState === 'stalled'
          ? 'Display stalled — waiting for a fresh frame…'
          : displayState === 'disconnected'
            ? 'Display disconnected — reconnecting…'
            : running
              ? 'Display idle'
              : 'Browser is not running';

  return (
    <section className="fy-remote-browser" aria-label="Remote browser display" data-display-state={displayState}>
      <header className="fy-remote-browser-header">
        <span className="fy-eyebrow">Remote browser</span>
        <output aria-live="polite">{label}</output>
      </header>
      <div className="fy-remote-browser-canvas" aria-busy={displayState === 'connecting'}>
        {frameUrl ? (
          <img src={frameUrl} alt="Live remote browser frame" />
        ) : (
          <p>{running ? 'Waiting for the first frame…' : 'Start the browser to view its display.'}</p>
        )}
        {displayState === 'stalled' && (
          <p className="fy-remote-browser-stalled">The last frame is shown while the stream recovers.</p>
        )}
      </div>
      {error && (
        <div className="fy-remote-browser-error" role="status">
          <span>{error}</span>
          <button type="button" onClick={() => setRetry(value => value + 1)}>
            Retry display
          </button>
        </div>
      )}
    </section>
  );
}
