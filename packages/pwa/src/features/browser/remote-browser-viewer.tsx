/**
 * Daemon-scoped remote browser display and its input channel.
 *
 * The stream ticket is supplied by the pairing/runtime host. It is intentionally
 * not retained here (or in a module cache): a PWA page can switch daemons while
 * preserving the same session id, and a stale viewer must never remain live.
 */

import type { BrowserInputEvent, BrowserStatus } from '@ferretry/protocol';
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  Ref,
} from 'react';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type DaemonConnection, sameDaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import {
  decodeRemoteBrowserFrame,
  isLocalPasteChord,
  nextRemoteClickRun,
  type RemoteClickRun,
  type RemoteKeyEvent,
  type RemotePointerButton,
  remoteBrowserStreamUrl,
  remoteCanvasPoint,
  remoteInputModifiers,
  remoteKeyInput,
  remoteKeyRelease,
  remotePointerButton,
} from '../../lib/remote-browser.ts';

export interface RemoteBrowserSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RemoteBrowserSocketFactory = (url: string) => RemoteBrowserSocket;

/** The frame's on-screen box; a DOM fact, so it is injectable for tests. */
export interface RemoteFrameRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type RemoteHumanActivity = 'pointer' | 'keyboard' | 'paste';

/** What the display is doing right now; the host maps it onto its own chrome. */
export type RemoteBrowserDisplayState = 'idle' | 'connecting' | 'live' | 'stalled' | 'disconnected';

/**
 * The narrow imperative seam a host needs to type into the page from OUTSIDE
 * the frame — a clipboard button, or the mobile text field a virtual keyboard
 * can actually reach. Deliberately three named methods on a ref rather than a
 * module-level socket registry: only the component that mounted this viewer can
 * drive it, and it disappears with the viewer.
 *
 * Each method reports whether the live transport accepted the input, so a caller
 * can tell "sent" apart from "silently dropped while disconnected".
 */
export interface RemoteBrowserViewerHandle {
  readonly insertText: (text: string, activity?: RemoteHumanActivity) => boolean;
  readonly sendKey: (event: RemoteKeyEvent, type: 'keyDown' | 'keyUp') => boolean;
  readonly releaseKeys: () => void;
}

export interface RemoteBrowserViewerProps {
  readonly ref?: Ref<RemoteBrowserViewerHandle>;
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** A short-lived, daemon-issued credential; never store it in page memory. */
  readonly streamTicket: string | null;
  readonly status: BrowserStatus | null;
  readonly isActive?: boolean;
  /** Off by default: a read-only viewer must not be able to drive the page. */
  readonly interactive?: boolean;
  /** Fit scales the frame into its box; 1:1 shows its true pixels and scrolls. */
  readonly fit?: boolean;
  /** Standalone viewers label themselves; composed panes can use their own status bar. */
  readonly showHeader?: boolean;
  readonly stallAfterMs?: number;
  readonly reconnectAfterMs?: number;
  readonly socketFactory?: RemoteBrowserSocketFactory;
  readonly createObjectUrl?: (frame: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly measureFrame?: () => RemoteFrameRect | null;
  /** Lets the host attribute the page's last actor without this owning HTTP. */
  readonly onHumanActivity?: (kind: RemoteHumanActivity) => void;
  /** Lets a touch surface focus the host-owned, mobile-keyboard-capable text field. */
  readonly onTouchInputFocus?: () => void;
  /** Publishes the transport state so the host's chrome can stay truthful. */
  readonly onDisplayStateChange?: (state: RemoteBrowserDisplayState) => void;
  readonly now?: () => number;
}

const defaultSocketFactory: RemoteBrowserSocketFactory = url => new WebSocket(url);
const defaultCreateObjectUrl = (frame: Blob): string => URL.createObjectURL(frame);
const defaultRevokeObjectUrl = (url: string): void => URL.revokeObjectURL(url);

const activePageId = (status: BrowserStatus | null): string | undefined =>
  status !== null && status.state === 'running' && 'activePageId' in status ? status.activePageId : undefined;

/**
 * Everything that decides which socket, and therefore which pixels, are this
 * viewer's. Deliberately NOT `(daemonId, sessionId)`: a re-pair keeps the daemon
 * id while rotating the base URL or the device token, and the frames arriving
 * over the old grant are then a different daemon-side browser's.
 */
interface ViewerTransport {
  readonly connection: DaemonConnection;
  readonly scopeDaemonId: string;
  readonly sessionId: string;
  readonly streamTicket: string | null;
}

const sameViewerTransport = (left: ViewerTransport, right: ViewerTransport): boolean =>
  left.scopeDaemonId === right.scopeDaemonId &&
  left.sessionId === right.sessionId &&
  left.streamTicket === right.streamTicket &&
  sameDaemonConnection(left.connection, right.connection);

/**
 * Renders only the latest JPEG frame. The daemon already coalesces frames; this
 * extra replacement prevents a slow React paint from turning the PWA into an
 * unbounded client-side queue.
 */
export function RemoteBrowserViewer({
  ref,
  daemon,
  scope,
  streamTicket,
  status,
  isActive = true,
  interactive = false,
  fit = true,
  showHeader = true,
  stallAfterMs = 4_000,
  reconnectAfterMs = 1_200,
  socketFactory = defaultSocketFactory,
  createObjectUrl = defaultCreateObjectUrl,
  revokeObjectUrl = defaultRevokeObjectUrl,
  measureFrame,
  onHumanActivity,
  onTouchInputFocus,
  onDisplayStateChange,
  now = Date.now,
}: RemoteBrowserViewerProps) {
  const [displayState, setDisplayState] = useState<RemoteBrowserDisplayState>('idle');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameRevision, setFrameRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const previousUrlRef = useRef<string | null>(null);
  const previousTransportRef = useRef(0);
  const previousPageRef = useRef<string | undefined>(undefined);
  const identityRef = useRef(0);
  const transportRef = useRef<{ readonly identity: ViewerTransport; readonly generation: number } | null>(null);
  const activePageRef = useRef<string | undefined>(undefined);
  const frameContainerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<RemoteBrowserSocket | null>(null);
  const pressedKeysRef = useRef(new Map<string, BrowserInputEvent>());
  const pressedPointersRef = useRef(new Map<number, RemotePointerButton>());
  const clickRunRef = useRef<RemoteClickRun | null>(null);
  const [inputRect, setInputRect] = useState<RemoteFrameRect | null>(null);

  const running = status?.state === 'running';
  const currentPageId = activePageId(status);
  // A MONOTONIC GENERATION, not a key string. This transport's identity includes
  // the device token, and a token belongs in no value that can reach a DOM
  // attribute, a persisted key or a log line — so the fields are compared and
  // only the resulting counter is carried around as the identity.
  const currentTransport: ViewerTransport = {
    connection: daemon,
    scopeDaemonId: scope.daemonId,
    sessionId: scope.sessionId,
    streamTicket: streamTicket ?? null,
  };
  if (transportRef.current === null || !sameViewerTransport(transportRef.current.identity, currentTransport)) {
    transportRef.current = { identity: currentTransport, generation: (transportRef.current?.generation ?? 0) + 1 };
  }
  const transportIdentity = transportRef.current.generation;
  const [renderedIdentity, setRenderedIdentity] = useState(transportIdentity);
  const [renderedPageId, setRenderedPageId] = useState(currentPageId);

  // Applied DURING RENDER, not in an effect. An effect runs after the commit, so
  // clearing there would still paint the previous connection's pixels once under
  // the new one's identity — the precise confusion this generation exists to
  // prevent. Only state is adjusted here; revoking the object URL and detaching
  // the socket are side effects and stay in the effects below.
  if (renderedIdentity !== transportIdentity) {
    setRenderedIdentity(transportIdentity);
    setRenderedPageId(currentPageId);
    setFrameUrl(null);
    setFrameRevision(0);
    setDisplayState('idle');
    setError(null);
  } else if (renderedPageId !== currentPageId) {
    // A status commit naming page B must never retain page A's already-painted
    // pixels. Doing this during render prevents that stale frame from reaching
    // even one commit while the one session socket remains attached.
    setRenderedPageId(currentPageId);
    setFrameUrl(null);
    setFrameRevision(0);
  }
  // Read by the socket listeners: a message, close or error that a superseded
  // transport delivers between this render and its own teardown must not be
  // able to repopulate the frame it was just cleared of.
  identityRef.current = transportIdentity;
  activePageRef.current = currentPageId;

  const streamUrl = useMemo(
    () => (streamTicket && running ? remoteBrowserStreamUrl(daemon, scope, streamTicket) : null),
    [daemon, running, scope, streamTicket],
  );
  const viewport = status?.viewport;
  const canInteract = interactive && running && displayState !== 'idle';

  /** Answers whether the live transport actually accepted the input. */
  const sendInput = useCallback((input: BrowserInputEvent): boolean => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(input));
    return true;
  }, []);

  /**
   * Releases every key the page still believes is held. A transport loss can
   * happen between a key-down and its key-up, and losing focus mid-chord is
   * routine; without this the remote Chrome stays stuck in a modifier state.
   */
  const releasePressedKeys = useCallback(() => {
    const held = [...pressedKeysRef.current.values()].reverse();
    pressedKeysRef.current.clear();
    for (const pressed of held) {
      const release = remoteKeyRelease(pressed);
      if (release !== null) sendInput(release);
    }
  }, [sendInput]);

  /**
   * The one place a key becomes remote input, shared by the frame's own handlers
   * and by the host's handle. Retaining the key-down here is what lets EVERY
   * release path — blur, transport loss, unmount — unstick the remote Chrome,
   * including for keys that arrived from a host's mobile text field.
   */
  const pressKey = useCallback(
    (event: RemoteKeyEvent, type: 'keyDown' | 'keyUp'): boolean => {
      const input = remoteKeyInput(event, type);
      const id = event.code || event.key;
      if (type === 'keyDown') pressedKeysRef.current.set(id, input);
      else pressedKeysRef.current.delete(id);
      const delivered = sendInput(input);
      if (delivered) onHumanActivity?.('keyboard');
      return delivered;
    },
    [onHumanActivity, sendInput],
  );

  /**
   * Commits whole text instead of synthesized keystrokes. A virtual keyboard, an
   * IME and a clipboard all produce text that has no truthful key sequence, so
   * inventing one would type mojibake into the page.
   */
  const insertText = useCallback(
    (text: string, activity: RemoteHumanActivity = 'paste'): boolean => {
      if (text === '') return false;
      const delivered = sendInput({ kind: 'insertText', text });
      if (delivered) onHumanActivity?.(activity);
      return delivered;
    },
    [onHumanActivity, sendInput],
  );

  /** Pins the transparent surface to the image's actual letterboxed DOM box. */
  const measureInputSurface = useCallback(() => {
    const container = frameContainerRef.current;
    const image = imageRef.current;
    if (container === null || image === null) return;
    const containerRect = container.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    if (imageRect.width <= 0 || imageRect.height <= 0) {
      setInputRect(current => (current === null ? current : null));
      return;
    }
    const next: RemoteFrameRect = {
      left: imageRect.left - containerRect.left - container.clientLeft + container.scrollLeft,
      top: imageRect.top - containerRect.top - container.clientTop + container.scrollTop,
      width: imageRect.width,
      height: imageRect.height,
    };
    setInputRect(current =>
      current?.left === next.left &&
      current.top === next.top &&
      current.width === next.width &&
      current.height === next.height
        ? current
        : next,
    );
  }, []);

  const frameVisible = frameUrl !== null;
  useLayoutEffect(() => {
    if (!fit || !frameVisible) return;
    measureInputSurface();
    const container = frameContainerRef.current;
    const image = imageRef.current;
    if (container === null || image === null) return;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            measureInputSurface();
          });
    observer?.observe(container);
    observer?.observe(image);
    window.addEventListener('resize', measureInputSurface);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureInputSurface);
    };
  }, [fit, frameVisible, measureInputSurface]);

  useImperativeHandle(ref, () => ({ insertText, sendKey: pressKey, releaseKeys: releasePressedKeys }), [
    insertText,
    pressKey,
    releasePressedKeys,
  ]);

  useEffect(() => {
    if (!interactive || !isActive || typeof window === 'undefined' || typeof document === 'undefined') return;
    const onWindowBlur = () => releasePressedKeys();
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') releasePressedKeys();
    };
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [interactive, isActive, releasePressedKeys]);

  useEffect(
    () => () => {
      if (previousUrlRef.current !== null) revokeObjectUrl(previousUrlRef.current);
    },
    [revokeObjectUrl],
  );

  // The impure half of the same re-scope: the cleared frame's object URL is
  // released, and the input state that belonged to the previous daemon's page
  // is dropped rather than replayed against the new one.
  useEffect(() => {
    if (previousTransportRef.current === transportIdentity) return;
    previousTransportRef.current = transportIdentity;
    if (previousUrlRef.current !== null) revokeObjectUrl(previousUrlRef.current);
    previousUrlRef.current = null;
    previousPageRef.current = currentPageId;
    pressedKeysRef.current.clear();
    pressedPointersRef.current.clear();
    clickRunRef.current = null;
  }, [currentPageId, revokeObjectUrl, transportIdentity]);

  // Page changes do not own the transport, so they only retire a frame that
  // still belongs to the old active page. A matching new-page frame can arrive
  // during the commit/effect window; its page marker protects it from cleanup.
  useEffect(() => {
    if (previousPageRef.current === currentPageId) return;
    if (previousUrlRef.current !== null) revokeObjectUrl(previousUrlRef.current);
    previousUrlRef.current = null;
    previousPageRef.current = currentPageId;
    pressedKeysRef.current.clear();
    pressedPointersRef.current.clear();
    clickRunRef.current = null;
  }, [currentPageId, revokeObjectUrl]);

  useEffect(() => {
    if (!isActive || streamUrl === null) {
      setDisplayState('idle');
      return;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // `transportIdentity` is captured deliberately: it is the identity THIS
    // socket speaks for, while the ref is whatever the pane is scoped to now.
    // React tears an effect down after the render that superseded it, so an
    // event can still arrive in between, and it must be judged against the live
    // scope rather than the one that attached the listener.
    const superseded = (): boolean => disposed || identityRef.current !== transportIdentity;
    const socket = socketFactory(streamUrl);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    setDisplayState('connecting');
    setError(retry > 0 ? 'Retrying remote display…' : null);

    socket.addEventListener('open', () => {
      if (!superseded()) {
        releasePressedKeys();
        setDisplayState('live');
        setError(null);
      }
    });
    socket.addEventListener('message', event => {
      if (superseded() || !(event instanceof MessageEvent) || !(event.data instanceof ArrayBuffer)) return;
      const frame = decodeRemoteBrowserFrame(event.data);
      if (frame === null) return;
      const livePageId = activePageRef.current;
      // A tagged frame is only truthful for the daemon's currently active page.
      // Legacy frames predate that identity and are safe only while there is no
      // active-page marker to contradict them.
      if ((frame.kind === 'tagged' && frame.pageId !== livePageId) || (frame.kind === 'legacy' && livePageId)) return;
      const nextUrl = createObjectUrl(new Blob([frame.jpegBytes], { type: 'image/jpeg' }));
      const previousUrl = previousUrlRef.current;
      previousUrlRef.current = nextUrl;
      previousPageRef.current = livePageId;
      setFrameUrl(nextUrl);
      if (previousUrl !== null) revokeObjectUrl(previousUrl);
      setFrameRevision(value => value + 1);
      setDisplayState('live');
      setError(null);
    });
    socket.addEventListener('error', () => {
      if (!superseded()) setError('The authenticated remote display connection failed.');
    });
    socket.addEventListener('close', event => {
      if (superseded()) return;
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
      if (socket.readyState === 1) releasePressedKeys();
      pressedPointersRef.current.clear();
      if (socketRef.current === socket) socketRef.current = null;
      socket.close(1000, 'viewer detached');
    };
  }, [
    createObjectUrl,
    isActive,
    reconnectAfterMs,
    releasePressedKeys,
    retry,
    revokeObjectUrl,
    socketFactory,
    streamUrl,
    // Two daemons can share one origin, which makes the stream URL alone an
    // unsafe identity: without this the superseded gate would silently freeze a
    // socket that is still attached but no longer speaks for this pane.
    transportIdentity,
  ]);

  useEffect(() => {
    if (displayState !== 'live' || frameRevision === 0) return;
    const timer = setTimeout(() => setDisplayState('stalled'), stallAfterMs);
    return () => clearTimeout(timer);
  }, [displayState, frameRevision, stallAfterMs]);

  useEffect(() => {
    onDisplayStateChange?.(displayState);
  }, [displayState, onDisplayStateChange]);

  const framePoint = (event: { clientX: number; clientY: number }): { readonly x: number; readonly y: number } => {
    // The image is authoritative: even if a host stylesheet accidentally grows
    // the transparent surface, letterbox clicks must not be mapped as page
    // pixels. Tests can still inject the same measurement seam as before.
    const rect =
      measureFrame?.() ??
      imageRef.current?.getBoundingClientRect() ??
      frameRef.current?.getBoundingClientRect() ??
      null;
    if (rect === null || viewport === undefined) return { x: 0, y: 0 };
    return remoteCanvasPoint(rect, viewport.width, viewport.height, event.clientX, event.clientY);
  };

  const sendPointer = (
    event: ReactPointerEvent<HTMLElement>,
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    releasedButton?: RemotePointerButton,
  ) => {
    const point = framePoint(event);
    // PointerEvent.detail is always 0, so the click run is tracked here from
    // time and distance, and the SAME count is sent on press and release.
    let clickCount = 0;
    if (type === 'mousePressed') {
      const run = nextRemoteClickRun(clickRunRef.current, point, now());
      clickRunRef.current = run;
      clickCount = run.count;
    } else if (type === 'mouseReleased') {
      clickCount = clickRunRef.current?.count ?? 1;
    }
    sendInput({
      kind: 'mouse',
      type,
      ...point,
      button: type === 'mouseMoved' ? 'none' : (releasedButton ?? remotePointerButton(event.button)),
      buttons: event.buttons,
      clickCount,
      modifiers: remoteInputModifiers(event),
    });
    if (type === 'mousePressed') onHumanActivity?.('pointer');
  };

  const beginPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pressedPointersRef.current.set(event.pointerId, remotePointerButton(event.button));
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch') {
      // Prevent the canvas's compatibility focus from stealing focus back after
      // the pane moves it to its real textarea/IME seam.
      event.preventDefault();
      onTouchInputFocus?.();
    }
    sendPointer(event, 'mousePressed');
  };

  const finishPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pressedButton = pressedPointersRef.current.get(event.pointerId);
    pressedPointersRef.current.delete(event.pointerId);
    sendPointer(event, 'mouseReleased', pressedButton);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: ReactWheelEvent<HTMLElement>) => {
    event.preventDefault();
    sendInput({
      kind: 'mouse',
      type: 'mouseWheel',
      ...framePoint(event),
      button: 'none',
      buttons: 0,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: remoteInputModifiers(event),
    });
  };

  const onKey = (event: ReactKeyboardEvent<HTMLElement>, type: 'keyDown' | 'keyUp') => {
    if (event.nativeEvent.isComposing) return;
    // The LOCAL paste chord is deliberately not consumed: preventDefault here
    // cancels the page's own paste, so the frame's `paste` event would never
    // fire and the keystroke would instead paste the REMOTE clipboard.
    if (isLocalPasteChord(event)) return;
    event.preventDefault();
    pressKey(
      {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        location: event.location,
        repeat: event.repeat,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
      type,
    );
  };

  const onPaste = (event: ReactClipboardEvent<HTMLElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    insertText(text);
  };

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
    <section
      className="fy-remote-browser"
      aria-label="Remote browser display"
      data-display-state={displayState}
      data-interactive={canInteract ? true : undefined}
    >
      {showHeader && (
        <header className="fy-remote-browser-header">
          <span className="fy-eyebrow">Remote browser</span>
          <output aria-live="polite">{label}</output>
        </header>
      )}
      {/* Fit scales the frame down into its box; 1:1 shows the daemon's true
          pixels and lets the box scroll, which is the only way to read a desktop
          viewport on a phone without a lossy downscale.

          The stylesheet caps the frame at `max-width/max-height: 100%`, so 1:1
          has to lift that cap explicitly — without this the mode toggles its
          label and changes nothing on screen. */}
      <div
        ref={frameContainerRef}
        className="fy-remote-browser-canvas"
        data-fit={fit ? true : undefined}
        style={{
          alignItems: fit ? 'center' : 'flex-start',
          display: 'flex',
          justifyContent: fit ? 'center' : 'flex-start',
          overflow: fit ? 'hidden' : 'auto',
        }}
        aria-busy={displayState === 'connecting'}
      >
        {frameUrl ? (
          <img
            ref={imageRef}
            src={frameUrl}
            alt="Live remote browser frame"
            onLoad={measureInputSurface}
            style={
              fit
                ? { flex: '0 1 auto', minHeight: 0, minWidth: 0 }
                : { flex: '0 0 auto', maxWidth: 'none', maxHeight: 'none' }
            }
          />
        ) : (
          <p>{running ? 'Waiting for the first frame…' : 'Start the browser to view its display.'}</p>
        )}
        {/* The input surface is a separate transparent layer over the frame.
            A read-only viewer renders none of it, so it exposes no focus stop
            and no handlers rather than an inert element that looks live. */}
        {canInteract && frameUrl !== null && viewport !== undefined && (
          <canvas
            ref={frameRef}
            className="fy-remote-browser-input"
            // In Fit, layout measurement pins this surface to the image's exact
            // letterboxed rectangle. At 1:1, both stay at the negotiated pixel
            // size at the scroll box's top-left.
            width={viewport.width}
            height={viewport.height}
            style={
              fit
                ? inputRect === null
                  ? { height: 0, inset: 'auto', visibility: 'hidden', width: 0 }
                  : {
                      height: inputRect.height,
                      inset: 'auto',
                      left: inputRect.left,
                      maxHeight: 'none',
                      maxWidth: 'none',
                      top: inputRect.top,
                      width: inputRect.width,
                    }
                : { height: viewport.height, maxHeight: 'none', maxWidth: 'none', width: viewport.width }
            }
            tabIndex={0}
            aria-label="Live remote page; click to send pointer and keyboard input"
            onPointerDown={beginPointer}
            onPointerMove={event => sendPointer(event, 'mouseMoved')}
            onPointerUp={finishPointer}
            onPointerCancel={finishPointer}
            onWheel={onWheel}
            onKeyDown={event => onKey(event, 'keyDown')}
            onKeyUp={event => onKey(event, 'keyUp')}
            onPaste={onPaste}
            onBlur={releasePressedKeys}
            onContextMenu={event => event.preventDefault()}
          />
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
