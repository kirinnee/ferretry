/**
 * The remote browser pane: one daemon-scoped composition of the browser hook,
 * the chrome primitives and the display.
 *
 * The pane owns no transport and no daemon identity of its own. It is handed a
 * `DaemonConnection` and the matching `(daemonId, sessionId)` scope, and every
 * action it can perform is dispatched through `useRemoteBrowser` for exactly
 * that pair. Nothing here reads the page origin or a build-time default: a
 * static PWA bundle that could guess a daemon URL would silently drive whichever
 * daemon happened to answer.
 *
 * The stream ticket is a REQUIRED runtime input, not something this component
 * can obtain. The daemon exposes no ticket endpoint yet, so the host that owns
 * pairing must supply one; `null` is the honest value until then, and the pane
 * stays fully usable — lifecycle, tabs, navigation and viewport all work over
 * HTTP, and only the live display waits for a ticket.
 */

import type {
  ClipboardEvent as ReactClipboardEvent,
  CompositionEvent as ReactCompositionEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';

import {
  type RemoteBrowserScheduler,
  type RemoteBrowserTransport,
  useRemoteBrowser,
} from '../../hooks/use-remote-browser.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { type RemoteViewportMode, remoteViewportForContainer } from '../../lib/remote-browser.ts';
import {
  type RemoteBrowserConnection,
  RemoteBrowserControls,
  RemoteBrowserGovernor,
  RemoteBrowserNavigation,
  remoteBrowserPage,
  RemoteBrowserPageTabs,
  RemoteBrowserStatusBar,
} from './remote-browser-chrome.tsx';
import {
  type RemoteBrowserDisplayState,
  type RemoteBrowserSocketFactory,
  RemoteBrowserViewer,
  type RemoteBrowserViewerHandle,
  type RemoteHumanActivity,
} from './remote-browser-viewer.tsx';

export interface RemoteContainerSize {
  readonly width: number;
  readonly height: number;
}

/** Watches a container's content box. A DOM fact, so it is injectable. */
export type RemoteBrowserSizeObserver = (element: Element, onResize: (size: RemoteContainerSize) => void) => () => void;

/** A cancellable one-shot delay, injectable so tests drive the debounce. */
export type RemoteBrowserDelay = (callback: () => void, delayMs: number) => () => void;

/**
 * Long enough that a phone's rotation animation and an on-screen keyboard
 * settle before the daemon is asked to re-lay out the real page.
 */
export const REMOTE_BROWSER_RESIZE_DEBOUNCE_MS = 250;

const defaultObserveSize: RemoteBrowserSizeObserver = (element, onResize) => {
  // A runtime without ResizeObserver cannot report a container box at all. The
  // daemon then keeps its last negotiated viewport, which is a worse fit but a
  // working pane; crashing the whole surface over it would not be.
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const observer = new ResizeObserver(entries => {
    const box = entries[0]?.contentRect;
    if (box !== undefined) onResize({ width: box.width, height: box.height });
  });
  observer.observe(element);
  return () => observer.disconnect();
};

const defaultDelay: RemoteBrowserDelay = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/** Rejects on a browser that withholds the permission; the caller says so. */
const defaultReadClipboardText = (): Promise<string> => navigator.clipboard.readText();

/**
 * A stalled display is still a connected one: the last frame stays on screen and
 * the socket is still attached, so degrading the chrome to "idle" would tell the
 * reader the opposite of what the viewer is showing them.
 */
const displayConnection = (state: RemoteBrowserDisplayState): RemoteBrowserConnection =>
  state === 'connecting'
    ? 'connecting'
    : state === 'live' || state === 'stalled'
      ? 'connected'
      : state === 'disconnected'
        ? 'disconnected'
        : 'detached';

/** True for a key a virtual keyboard commits as text rather than as a keystroke. */
const printableKey = (event: {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean => event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

export interface RemoteBrowserPaneProps {
  readonly daemon: DaemonConnection;
  /** Must name `daemon`; a scope from another daemon is a programming error. */
  readonly scope: DaemonSessionScope;
  /**
   * The daemon-issued stream credential. There is no endpoint that mints one
   * yet, so the host passes `null` until pairing can supply it and the display
   * stays idle instead of inventing a URL.
   */
  readonly streamTicket: string | null;
  /** A hidden retained pane detaches; the daemon-side browser survives. */
  readonly isActive?: boolean;
  readonly onHumanActivity?: (kind: RemoteHumanActivity) => void;
  readonly resizeDebounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly transport?: RemoteBrowserTransport;
  readonly schedule?: RemoteBrowserScheduler;
  readonly observeSize?: RemoteBrowserSizeObserver;
  readonly delay?: RemoteBrowserDelay;
  readonly readClipboardText?: () => Promise<string>;
  readonly socketFactory?: RemoteBrowserSocketFactory;
  readonly createObjectUrl?: (frame: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

export function RemoteBrowserPane({
  daemon,
  scope,
  streamTicket,
  isActive = true,
  onHumanActivity,
  resizeDebounceMs = REMOTE_BROWSER_RESIZE_DEBOUNCE_MS,
  pollIntervalMs,
  transport,
  schedule,
  observeSize = defaultObserveSize,
  delay = defaultDelay,
  readClipboardText = defaultReadClipboardText,
  socketFactory,
  createObjectUrl,
  revokeObjectUrl,
}: RemoteBrowserPaneProps) {
  // Fail here rather than deep inside a request: a mismatched pair would drive
  // one daemon's Chrome under another daemon's name, which is the exact bug the
  // (daemonId, sessionId) scope exists to make impossible.
  if (daemon.daemonId !== scope.daemonId) throw new Error('remote browser scope must belong to the paired daemon');

  const { status, error, busy, runAction, reportError, clearError } = useRemoteBrowser({
    daemon,
    scope,
    isActive,
    pollIntervalMs,
    transport,
    schedule,
  });

  const [displayState, setDisplayState] = useState<RemoteBrowserDisplayState>('idle');
  const [fit, setFit] = useState(true);
  const [viewportMode, setViewportMode] = useState<RemoteViewportMode>('responsive');
  const screenRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<RemoteBrowserViewerHandle | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const lastViewportRef = useRef('');
  const scopeRef = useRef<string | null>(null);
  const scopeEpochRef = useRef(0);

  const scopeKey = JSON.stringify([daemon.daemonId, scope.daemonId, scope.sessionId]);
  // Applied during render, exactly as the hook clears its snapshot: the chrome
  // must not still claim "Live" for one frame after the pane is re-scoped, and
  // the previous daemon's negotiated viewport must not suppress the first
  // resize sent to the new one.
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    scopeEpochRef.current += 1;
    lastViewportRef.current = '';
    if (displayState !== 'idle') setDisplayState('idle');
  }

  const connection = displayConnection(displayState);
  const page = remoteBrowserPage(status);
  const running = status?.state === 'running';
  const connected = connection === 'connected';
  const loading = page?.pageState === 'loading';
  const unavailableReason = status?.state === 'error' ? status.error : null;

  // The daemon lays out the real page, so the container's size has to become a
  // validated `resize` action rather than a client-side scale. It is debounced
  // because a drag or a rotation emits a continuous stream of boxes, and each
  // one would otherwise be a Chrome re-layout.
  useEffect(() => {
    const screen = screenRef.current;
    if (!isActive || !running || screen === null) return;
    const scopeEpoch = scopeEpochRef.current;
    let cancelPending: (() => void) | null = null;
    const stop = observeSize(screen, size => {
      const viewport = remoteViewportForContainer(size.width, size.height, viewportMode);
      if (viewport === null) return;
      const key = `${viewport.width}x${viewport.height}`;
      if (lastViewportRef.current === key) return;
      cancelPending?.();
      cancelPending = delay(() => {
        cancelPending = null;
        if (scopeEpoch !== scopeEpochRef.current) return;
        lastViewportRef.current = key;
        runAction({ action: 'resize', width: viewport.width, height: viewport.height });
      }, resizeDebounceMs);
    });
    return () => {
      stop();
      cancelPending?.();
    };
  }, [delay, isActive, observeSize, resizeDebounceMs, runAction, running, viewportMode]);

  const pasteFromClipboard = useCallback(async () => {
    const scopeEpoch = scopeEpochRef.current;
    let text: string;
    try {
      text = await readClipboardText();
    } catch {
      if (scopeEpoch !== scopeEpochRef.current) return;
      reportError('Clipboard access was blocked. Focus the remote page and use the system paste gesture.');
      return;
    }
    if (scopeEpoch !== scopeEpochRef.current) return;
    if (text === '') return;
    if (viewerRef.current?.insertText(text) !== true)
      reportError('The remote display is not connected, so nothing was pasted into the page.');
  }, [readClipboardText, reportError]);

  const onTextInput = (event: FormEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
    const field = event.currentTarget;
    const text = field.value;
    if (text === '') return;
    field.value = '';
    viewerRef.current?.insertText(text, 'keyboard');
  };

  const onTextCompositionEnd = (event: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    const field = event.currentTarget;
    const text = event.data || field.value;
    field.value = '';
    if (text !== '') viewerRef.current?.insertText(text, 'keyboard');
  };

  /**
   * Consumes the paste itself so it reaches the page exactly once: letting the
   * field keep the text would commit it again through the `input` path, and
   * letting it bubble would hand the same clipboard to the surrounding shell.
   */
  const onTextPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (text === '') return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.value = '';
    viewerRef.current?.insertText(text);
  };

  const onTextKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>, type: 'keyDown' | 'keyUp') => {
    if (event.nativeEvent.isComposing) return;
    // Printable text is committed by the input and composition paths, which are
    // what virtual keyboards and IMEs reliably expose. Forwarding the key event
    // as well would type every character into the page twice. Editing keys,
    // navigation keys and hardware chords have no text path, so they stay here.
    if (printableKey(event)) return;
    event.preventDefault();
    viewerRef.current?.sendKey(
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

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface"
      aria-label="Shared remote browser"
    >
      <RemoteBrowserStatusBar status={status} connection={connection} busy={busy} />
      <RemoteBrowserPageTabs status={status} busy={busy} onAction={runAction} />
      <RemoteBrowserNavigation status={status} busy={busy} onAction={runAction} onInvalidAddress={reportError} />
      <RemoteBrowserControls
        status={status}
        connection={connection}
        busy={busy}
        fit={fit}
        viewportMode={viewportMode}
        onAction={runAction}
        onToggleFit={() => setFit(value => !value)}
        onToggleViewportMode={() => {
          // The negotiated viewport changes with the mode, so the suppression
          // key has to be dropped or the switch would be a no-op.
          lastViewportRef.current = '';
          setViewportMode(value => (value === 'responsive' ? 'desktop' : 'responsive'));
        }}
        onPasteFromClipboard={() => void pasteFromClipboard()}
        trailingControl={
          <textarea
            ref={textInputRef}
            rows={1}
            disabled={!running || !connected}
            aria-label="Type into remote browser"
            placeholder="Type into page…"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-h-[44px] min-w-[10rem] flex-1 resize-none rounded-control border border-border bg-surface px-2 py-2 text-ui text-fg outline-none placeholder:text-muted md:hidden"
            onInput={onTextInput}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={onTextCompositionEnd}
            onKeyDown={event => onTextKey(event, 'keyDown')}
            onKeyUp={event => onTextKey(event, 'keyUp')}
            onPaste={onTextPaste}
            onBlur={() => viewerRef.current?.releaseKeys()}
          />
        }
      />
      {page?.pageError !== undefined && (
        <div role="alert" className="shrink-0 border-b border-err/30 bg-err-soft px-3 py-2 text-meta text-err">
          {page.pageError}
        </div>
      )}
      {error !== null && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-xs border-b border-err/30 bg-err-soft px-3 py-2 text-meta text-err"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={clearError} className="min-h-[44px] min-w-[44px] shrink-0 text-muted">
            Dismiss
          </button>
        </div>
      )}
      <div
        ref={screenRef}
        className="relative flex min-h-[240px] min-w-0 flex-1 flex-col bg-[#09090b] [&>.fy-remote-browser]:flex-1 [&>.fy-remote-browser]:rounded-none [&>.fy-remote-browser]:border-0 [&_.fy-remote-browser-canvas]:bg-[#09090b]"
      >
        <RemoteBrowserViewer
          ref={viewerRef}
          daemon={daemon}
          scope={scope}
          streamTicket={streamTicket}
          status={status}
          isActive={isActive}
          interactive
          fit={fit}
          showHeader={false}
          onDisplayStateChange={setDisplayState}
          onHumanActivity={onHumanActivity}
          onTouchInputFocus={() => textInputRef.current?.focus({ preventScroll: true })}
          socketFactory={socketFactory}
          createObjectUrl={createObjectUrl}
          revokeObjectUrl={revokeObjectUrl}
        />
        {loading && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-accent"
            role="status"
            aria-live="polite"
          >
            <span className="sr-only">Loading page…</span>
          </div>
        )}
        {!running && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#09090b] px-panel text-center">
            <div className="max-w-xs">
              <Monitor
                size={30}
                aria-hidden="true"
                className={`mx-auto ${unavailableReason === null ? 'text-muted' : 'text-err'}`}
              />
              {unavailableReason === null ? (
                <>
                  <p className="mb-0 mt-3 text-ui font-medium text-fg">Browser is stopped</p>
                  <p className="mb-0 mt-1 text-meta leading-base text-muted">
                    Start it here or run <code>kteam browser open</code>. Login state remains in the persistent profile.
                  </p>
                </>
              ) : (
                <>
                  <p className="mb-0 mt-3 text-ui font-medium text-err">Browser unavailable</p>
                  <p className="mb-0 mt-1 break-words text-meta leading-base text-err">{unavailableReason}</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <RemoteBrowserGovernor status={status} />
    </section>
  );
}
