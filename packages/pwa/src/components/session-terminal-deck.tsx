/**
 * THE CO-CONTROLLED TERMINAL DECK — handovers #64, #34 and #41.
 *
 * Ported from kteam `ui/src/components/WebTerminals.tsx`, whose deck shape,
 * metrics and wording are preserved in `web-terminals.css`. What is NEW here is
 * everything the handovers asked for and the original could not express.
 *
 * CO-CONTROL IS CONCURRENT, NOT A HANDOVER. The daemon attaches every viewer
 * socket to the same pane and writes whatever any of them sends, so an agent and
 * the reader are typing into one shell at the same time by construction. There
 * is no lock to acquire and no "take control" button — pressing a key IS taking
 * over, and the agent's session is untouched by it. What the reader is owed is
 * knowing what they are typing into, which is the co-control line above the
 * pane; the decisions behind it live in `lib/terminal-co-control.ts`.
 *
 * ONE DAEMON, ALWAYS. The original called a page-global `api`, which is wrong the
 * moment two daemons are paired: a session id is minted per daemon and collides
 * freely, so `s1` on a laptop and `s1` on a workstation are different sessions
 * with different terminals. Every call here takes the explicit `(connection,
 * scope)` pair, and the whole deck is remounted by key when either changes —
 * one daemon's shell must never appear under another daemon's session
 * (`docs/migration/surveys/pwa-shape.md`).
 *
 * THE STREAM IS A PORT, NOT A SOCKET. A direct viewer opens a `wss://` socket at the daemon's own
 * address, carrying a short-lived ticket bought over HTTP so the durable device token never enters a
 * URL that outlives it in history or logs. A RELAYED viewer has no such address to open — that is the
 * one the rendezvous exists because this browser cannot reach — so it gets a §14 stream session and no
 * ticket at all. `lib/web-terminals.ts` owns both adapters; this deck asks for four operations.
 *
 * XTERM IS LOADED LAZILY. It is the largest dependency in this bundle and most
 * readers never open a shell; a static import would put a terminal emulator in
 * the first paint of a chat app. The import failing is a real state and says so,
 * rather than leaving an empty box.
 */

import type { TerminalListView, TerminalView } from '@ferretry/protocol';
import {
  Check,
  Clipboard,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useLinkBehaviour } from '../features/browser/external-link.tsx';
import { useDocumentVisible } from '../hooks/use-document-visible.ts';
import { RECONNECTING_GRACE_MS } from '../lib/connection-health.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { grantRefusalNotice } from '../lib/grants.ts';
import { isCaptureEscapeChord, isKeyboardCaptured, KEYBOARD_CAPTURE_ATTRIBUTE } from '../lib/keyboard-capture.ts';
import type { DaemonFetch } from '../lib/runtime-models.ts';
import { describeSurfaceOwnership, type SurfaceOwnership } from '../lib/surface-references.ts';
import {
  describeCoControl,
  shouldReopenTerminalStream,
  type TerminalLinkState,
  terminalReopenDelayMs,
  terminalResizeFrame,
} from '../lib/terminal-co-control.ts';
import { terminalFontFamily } from '../lib/terminal-font.ts';
import {
  describeHyperlinkMismatch,
  type LinkableBuffer,
  terminalHyperlinkHandler,
  terminalLinkProvider,
} from '../lib/terminal-links.ts';
import {
  browserTerminalStreamAttach,
  closeSessionTerminal,
  createSessionTerminal,
  listSessionTerminals,
  renameSessionTerminal,
  type TerminalStream,
  type TerminalStreamHandlers,
  type TerminalStreamOpener,
  TerminalStreamRefused,
  terminalLimitLabel,
} from '../lib/web-terminals.ts';
import { Button } from '../shell/primitives.tsx';
import { loadTerminalFont } from './terminal-font-loader.ts';

type XtermModules = {
  readonly Terminal: typeof import('@xterm/xterm').Terminal;
  readonly FitAddon: typeof import('@xterm/addon-fit').FitAddon;
};

/**
 * Everything that touches the daemon or the browser, injected.
 *
 * A test drives the whole deck — tabs, rename, close, the link lamp, the
 * co-control line — without a socket, a daemon or an emulator, and the visual
 * harness renders a deck with a scripted pane instead of opening a real shell.
 */
export interface TerminalDeckDependencies {
  list(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<TerminalListView>;
  create(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<TerminalView>;
  rename(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, title: string): Promise<TerminalView>;
  close(daemon: DaemonConnection, scope: DaemonSessionScope, id: string): Promise<unknown>;
  /**
   * Attaches to one terminal's live stream over whichever carrier is live.
   *
   * ONE OPERATION RATHER THAN "BUILD A URL, THEN OPEN A SOCKET", because a relayed terminal has no
   * URL to build: it is a §14 stream session over a rendezvous, and the daemon's own address is the
   * one the relay exists because this browser cannot reach it. `web-terminals.ts` owns both adapters
   * and this deck stops knowing which one it got.
   */
  attach(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    id: string,
    handlers: TerminalStreamHandlers,
  ): Promise<TerminalStream>;
  loadXterm(): Promise<XtermModules>;
  /** Subscribes to the document theme attributes and returns its cleanup. */
  watchTheme(repaint: () => void): () => void;
  /** Confirmation before a shell is killed. Injected so a test never blocks. */
  confirmClose(title: string): boolean;
  /** Confirmation before a hyperlink whose text does not name its target is opened. Injected so a test never blocks. */
  confirmLink(visible: string, href: string): boolean;
  writeClipboard(text: string): Promise<void>;
  /**
   * "This daemon is reachable again" (the connection model's `onRecovered`); returns how to stop. A
   * pane waiting out its reopen backoff reopens at once. Absent means panes wait out the backoff.
   */
  onRecovered?(daemon: DaemonConnection, listener: () => void): () => void;
}

/**
 * The browser's real dependencies, bound to the carrier this daemon's traffic is on.
 *
 * THE FETCHER IS THREADED THROUGH EVERY HTTP CALL. `list`, `create`, `rename` and `close` used to
 * default to `browserFetch` — the raw network — which a paired device cannot use at all now: it holds
 * no bearer value, so every daemon call rides a session the device key opened. The control plane and
 * the stream travel the same carrier as every other daemon call.
 */
export const browserTerminalDeckDependencies = (
  fetcher: DaemonFetch,
  openStream: TerminalStreamOpener,
  onRecovered?: TerminalDeckDependencies['onRecovered'],
): TerminalDeckDependencies => ({
  ...(onRecovered === undefined ? {} : { onRecovered }),
  list: (daemon, scope) => listSessionTerminals(daemon, scope, fetcher),
  create: (daemon, scope) => createSessionTerminal(daemon, scope, {}, fetcher),
  rename: (daemon, scope, id, title) => renameSessionTerminal(daemon, scope, id, title, fetcher),
  close: (daemon, scope, id) => closeSessionTerminal(daemon, scope, id, fetcher),
  attach: browserTerminalStreamAttach(openStream),
  loadXterm: async () => {
    const [xterm, fit] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
  },
  watchTheme: repaint => {
    if (typeof MutationObserver === 'undefined') return () => {};
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    return () => observer.disconnect();
  },
  confirmClose: title => globalThis.confirm(`Close “${title}”? This ends its shell process.`),
  confirmLink: (visible, href) => globalThis.confirm(describeHyperlinkMismatch(visible, href)),
  writeClipboard: async text => await navigator.clipboard.writeText(text),
});

export interface SessionTerminalDeckProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Display only — the daemon derives and enforces the shell's cwd itself. */
  readonly cwd?: string;
  /** Required: a deck has no network of its own — every call rides the router's sessions. */
  readonly dependencies: TerminalDeckDependencies;
  /**
   * The terminal this mount was opened FOR — a `terminal:<id>` side-pane tab
   * (#35) or a proved `%terminal:<key>` reference.
   *
   * It selects that shell once the listing proves it exists, and does nothing
   * at all when it does not: a tab naming a terminal this session has never had
   * is damaged evidence, and selecting whatever happens to be first would put
   * the reader in front of the wrong shell while telling them it is the right
   * one.
   */
  readonly focusTerminalId?: string;
  /**
   * ONE SHELL, NOT A DECK: a workspace tab names exactly one terminal, so its body shows that shell
   * alone — no strip of its own, no ＋, no ledger — because the workspace's tab strip already is the
   * strip. A shell missing from the daemon's listing says so instead of showing another one.
   */
  readonly solo?: boolean;
  /**
   * Is this deck on screen? A retained workspace tab that is not the selected one is mounted but unseen,
   * and a stream it holds is metered on a relay for output nobody reads. Off, the deck detaches every
   * stream and keeps each pane's scrollback; on, it reattaches. Defaults to on.
   */
  readonly active?: boolean;
  /** Rewrites what the reader typed before it is sent: the phone key bar's sticky ctrl. */
  readonly interceptInput?: (data: string) => string;
  /** Hands the host a way to type into, and focus, the shell on screen — the phone key bar. */
  readonly onInputPort?: (port: TerminalInputPort | null) => void;
}

/** Typing into, and focusing, the one shell a host is showing. */
export interface TerminalInputPort {
  readonly write: (data: string) => void;
  readonly focus: () => void;
}

const passInput = (data: string): string => data;

/**
 * What a failed terminal call says.
 *
 * A grant refusal is worded as one rather than shown as a bare 403: the operator may have switched
 * `terminal` off, or a passkey confirmation may be needed, and "HTTP 403" tells a person neither. The
 * daemon's own sentence — which names the command that changes it — is kept after the guidance.
 */
const failure = (error: unknown): string => {
  const grant = grantRefusalNotice(error);
  if (grant !== null)
    return grant.detail === '' ? grant.guidance.explanation : `${grant.guidance.explanation} ${grant.detail}`;
  return error instanceof Error ? error.message : String(error);
};

const ownershipOf = (terminal: TerminalView | null): SurfaceOwnership => terminal?.openedBy ?? { by: 'unrecorded' };

/** The theme, read from the live tokens so a theme switch repaints the pane. */
function terminalTheme(): import('@xterm/xterm').ITheme {
  const style = getComputedStyle(document.documentElement);
  // An unset token yields `undefined`, which leaves xterm's own default in place rather than a literal here.
  const token = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined;
  return {
    background: token('--code-bg'),
    foreground: token('--code-fg'),
    cursor: token('--accent'),
    cursorAccent: token('--code-bg'),
    selectionBackground: token('--accent-soft'),
    selectionForeground: token('--fg'),
    black: token('--fg'),
    brightBlack: token('--muted'),
    white: token('--surface-3'),
    brightWhite: token('--fg'),
  };
}

/**
 * The font, read from the live theme like the colours are, with the bundled face before the generic —
 * see `lib/terminal-font.ts` for why a theme's own stack alone drew `b u n  d e v`.
 */
const terminalFont = (): string =>
  terminalFontFamily(getComputedStyle(document.documentElement).getPropertyValue('--font-mono'));

/** xterm hands binary input back as a byte-per-char string, not a buffer. */
function bytesFromBinaryString(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

interface SentResize {
  readonly stream: TerminalStream;
  readonly frame: string;
}

/**
 * Tells a stream its pane's size, unless it was last told exactly that.
 *
 * A resize is one complete control frame and is never split: half a message is corruption. Repeating
 * a size changes nothing for the daemon and is a metered record on a relay, and the observer and the
 * stream's own open both report it. The last size is remembered per stream, so a new stream is told.
 */
const sendResize = (
  last: { current: SentResize | null },
  stream: TerminalStream | null,
  cols: number,
  rows: number,
): void => {
  if (stream === null) return;
  const frame = terminalResizeFrame(cols, rows);
  if (last.current?.stream === stream && last.current.frame === frame) return;
  last.current = { stream, frame };
  stream.control(frame);
};

interface TerminalCanvasProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly terminal: TerminalView;
  readonly active: boolean;
  readonly scrollback: number;
  readonly dependencies: TerminalDeckDependencies;
  readonly onLink: (state: TerminalLinkState) => void;
  readonly onSelection: (selection: string) => void;
  readonly interceptInput: (data: string) => string;
  readonly onInputPort?: ((port: TerminalInputPort | null) => void) | undefined;
}

/**
 * One live pane: an emulator, a socket, and the wiring between them.
 *
 * Mounted for every terminal in the deck and attached only for the active one,
 * exactly as the original did — a retained inactive pane keeps its scrollback
 * without holding a socket open against the daemon's idle policy.
 */
function TerminalCanvas({
  connection,
  scope,
  terminal,
  active,
  scrollback,
  dependencies,
  onLink,
  onSelection,
  interceptInput,
  onInputPort,
}: TerminalCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const streamRef = useRef<TerminalStream | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onLinkRef = useRef(onLink);
  const onSelectionRef = useRef(onSelection);
  onLinkRef.current = onLink;
  onSelectionRef.current = onSelection;
  const interceptRef = useRef(interceptInput);
  interceptRef.current = interceptInput;
  const onInputPortRef = useRef(onInputPort);
  onInputPortRef.current = onInputPort;
  // Links open where Settings › "Open links in" says, like every chat link. The hook is read through
  // a ref: the emulator is built once per (dependencies, scrollback), and the setting changes under it.
  const links = useLinkBehaviour();
  const linksRef = useRef(links);
  linksRef.current = links;
  const [readyVersion, setReadyVersion] = useState(0);
  const [reopenVersion, setReopenVersion] = useState(0);
  const attemptRef = useRef(0);
  /**
   * A live shell that dropped, while the drop is still UNSAID. The first reopen comes back well inside
   * {@link RECONNECTING_GRACE_MS}, and a lamp that flashed amber for each of those read as a terminal
   * that was always reconnecting; so the lamp keeps what it said until the outage outlasts the grace,
   * and only then says `reconnecting`. Held across the effect re-runs a reopen is made of.
   */
  const quietRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastResizeRef = useRef<SentResize | null>(null);
  useEffect(() => () => clearTimeout(quietRef.current), []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let stopWatchingTheme = () => {};
    let selectionDisposable: { dispose(): void } | undefined;
    let dataDisposable: { dispose(): void } | undefined;
    let binaryDisposable: { dispose(): void } | undefined;
    let linkDisposable: { dispose(): void } | undefined;

    // The face is loaded BEFORE the emulator exists: xterm measures its cell once, on open.
    void Promise.all([dependencies.loadXterm(), loadTerminalFont()])
      .then(([{ Terminal, FitAddon }]) => {
        if (disposed) return;
        // The screen, read live by both link paths. Tapping or clicking a link is a click on the pane,
        // so it neither adds a touch listener nor moves focus: tap-to-focus and long-press selection
        // stay the emulator's own.
        let screen: import('@xterm/xterm').Terminal | null = null;
        const linkScreen = {
          buffer: (): LinkableBuffer | undefined => screen?.buffer.active,
          columns: (): number => screen?.cols ?? 0,
        };
        const linkSink = {
          open: (click: Parameters<typeof linksRef.current.open>[0], href: string): void =>
            linksRef.current.open(click, { href, element: host }),
          confirm: (visible: string, href: string): boolean => dependencies.confirmLink(visible, href),
        };
        const xterm = new Terminal({
          allowProposedApi: false,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: 'bar',
          fontFamily: terminalFont(),
          fontSize: 12.5,
          lineHeight: 1.14,
          linkHandler: terminalHyperlinkHandler(linkScreen, linkSink),
          scrollback,
          theme: terminalTheme(),
        });
        screen = xterm;
        linkDisposable = xterm.registerLinkProvider(terminalLinkProvider(linkScreen, linkSink));
        const fit = new FitAddon();
        xterm.loadAddon(fit);
        stopWatchingTheme = dependencies.watchTheme(() => {
          xterm.options.theme = terminalTheme();
          // A theme family brings its own monospace stack; a changed font re-measures the cells.
          const font = terminalFont();
          if (xterm.options.fontFamily !== font) xterm.options.fontFamily = font;
        });
        xterm.open(host);
        terminalRef.current = xterm;
        fitRef.current = fit;

        // Let the browser own copy/paste shortcuts when there is a selection;
        // every other key remains terminal input. No focus() call: opening the
        // side pane must never steal the composer.
        xterm.attachCustomKeyEventHandler(event => {
          const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey;
          if (shortcut && event.code === 'KeyC' && xterm.hasSelection()) return false;
          if (shortcut && event.code === 'KeyV') return false;
          return true;
        });
        const send = (bytes: Uint8Array<ArrayBuffer>): void => {
          // Sent WHOEVER else is attached. There is no turn to wait for: this is
          // the line that makes co-control concurrent rather than a handover.
          // On a relay the port splits an oversized write into ordered records; on a socket it is
          // one frame. Neither answer belongs here, which is why this calls a port.
          streamRef.current?.write(bytes);
        };
        dataDisposable = xterm.onData(value => send(new TextEncoder().encode(interceptRef.current(value))));
        binaryDisposable = xterm.onBinary(value => send(bytesFromBinaryString(value)));
        selectionDisposable = xterm.onSelectionChange(() => onSelectionRef.current(xterm.getSelection()));

        const fitAndResize = (): void => {
          if (!activeRef.current || host.clientWidth < 1 || host.clientHeight < 1) return;
          try {
            fit.fit();
          } catch {
            return;
          }
          sendResize(lastResizeRef, streamRef.current, xterm.cols, xterm.rows);
        };
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => fitAndResize());
          observer.observe(host);
        }
        globalThis.requestAnimationFrame(fitAndResize);
        setReadyVersion(version => version + 1);
      })
      .catch(() => {
        // The emulator could not be loaded at all. There is nothing to retry
        // into, so this is a refusal rather than a reconnect.
        if (!disposed) onLinkRef.current('refused');
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      stopWatchingTheme();
      dataDisposable?.dispose();
      binaryDisposable?.dispose();
      selectionDisposable?.dispose();
      linkDisposable?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [dependencies, scrollback]);

  // The key bar's port exists only while this shell is the one on screen and has an emulator to
  // focus. `readyVersion` is the trigger for "the emulator now exists".
  // biome-ignore lint/correctness/useExhaustiveDependencies: readyVersion is the re-run trigger
  useEffect(() => {
    const xterm = terminalRef.current;
    const publish = onInputPortRef.current;
    if (!active || xterm === null || publish === undefined) return;
    publish({
      write: data => streamRef.current?.write(new TextEncoder().encode(data)),
      focus: () => xterm.focus(),
    });
    return () => publish(null);
  }, [active, readyVersion]);

  // `readyVersion` and `reopenVersion` are in the list although the body never
  // reads them: they ARE the triggers. The first fires once the emulator exists
  // so the socket has something to write into, and the second is what a
  // scheduled retry bumps. Dropping either would leave a live pane with no
  // stream and a dropped stream with no retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both versions are re-run triggers
  useEffect(() => {
    const xterm = terminalRef.current;
    const fit = fitRef.current;
    /** The drop is no longer unsaid: it recovered, was refused, or the pane went away. */
    const endQuiet = (): void => {
      clearTimeout(quietRef.current);
      quietRef.current = undefined;
    };
    if (!active || xterm === null || fit === null) {
      endQuiet();
      onLinkRef.current('idle');
      return;
    }
    let disposed = false;
    let stream: TerminalStream | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    // A reopen inside the quiet window keeps the lamp where it was.
    if (quietRef.current === undefined) onLinkRef.current('connecting');

    const retryLater = (): void => {
      if (attemptRef.current === 0 && quietRef.current === undefined)
        quietRef.current = setTimeout(() => {
          quietRef.current = undefined;
          onLinkRef.current('reconnecting');
        }, RECONNECTING_GRACE_MS);
      else if (quietRef.current === undefined) onLinkRef.current('reconnecting');
      attemptRef.current += 1;
      reopenTimer = setTimeout(
        () => setReopenVersion(version => version + 1),
        terminalReopenDelayMs(attemptRef.current),
      );
    };
    // THE DAEMON IS BACK: a pane waiting out its backoff reopens now. The emulator is not touched, so
    // the last frame stays on screen until the new stream paints over it.
    const stopRecovered = dependencies.onRecovered?.(connection, () => {
      if (disposed || reopenTimer === undefined) return;
      clearTimeout(reopenTimer);
      reopenTimer = undefined;
      attemptRef.current = 0;
      setReopenVersion(version => version + 1);
    });

    // The attach is asynchronous on both carriers — a ticket purchase, or a rendezvous handshake —
    // so every teardown path has to survive the await: a tab switched away from mid-attach must not
    // leave a stream nobody is watching.
    void dependencies
      .attach(connection, scope, terminal.id, {
        onOpen: () => {
          if (disposed) return;
          attemptRef.current = 0;
          endQuiet();
          onLinkRef.current('live');
          globalThis.requestAnimationFrame(() => {
            if (disposed || stream === null) return;
            // An unmeasurable host reports 80x24, which would resize the shell under every other viewer.
            if (hostRef.current === null || hostRef.current.clientWidth < 1 || hostRef.current.clientHeight < 1) return;
            try {
              fit.fit();
              sendResize(lastResizeRef, stream, xterm.cols, xterm.rows);
            } catch {
              // A zero-sized retained pane is fitted by ResizeObserver later.
            }
          });
        },
        onBytes: bytes => {
          if (!disposed) xterm.write(bytes);
        },
        onClosed: code => {
          if (disposed) return;
          // THE STREAM'S OWN CODE, NEVER THE SESSION'S. On a relay the meaningful code arrives in a
          // sealed `stream-close` record and a `4440` follows it as expected teardown; handing that
          // `4440` here would read as "retry" against a stream the daemon deliberately ended, and
          // the reader would watch a shell reopen and die at the backoff cap forever.
          if (!shouldReopenTerminalStream(code)) {
            // The daemon has judged this client. Retrying asks it the same
            // question, so the reader is told instead of watching a loop.
            endQuiet();
            onLinkRef.current('refused');
            return;
          }
          retryLater();
        },
        onRefused: () => {
          // §14 gives `stream-refused` a status so "it is gone" can be told from "the daemon broke".
          // It is final for this attempt, so it reaches the state that says so rather than the retry
          // that would ask a permanent 403 the same question at fifteen-second intervals forever.
          if (disposed) return;
          endQuiet();
          onLinkRef.current('refused');
        },
      })
      .then(attached => {
        if (disposed) {
          attached.close(1000, 'terminal tab detached');
          return;
        }
        stream = attached;
        streamRef.current = attached;
      })
      .catch(reason => {
        if (disposed) return;
        // A refusal has already reported itself through `onRefused` and must not be retried.
        // Everything else — an unreachable daemon, a refused ticket, a rendezvous that did not
        // answer — is worth retrying: a device token is still valid across a network change.
        if (reason instanceof TerminalStreamRefused) return;
        retryLater();
      });

    return () => {
      disposed = true;
      stopRecovered?.();
      if (reopenTimer !== undefined) clearTimeout(reopenTimer);
      if (streamRef.current === stream) streamRef.current = null;
      // §14 makes a client's leave an explicit sealed record rather than a dropped socket, "so that
      // the taxonomy survives in both directions and a deliberate leave is never spelled the same as
      // a network failure". The port carries the same code and reason on either carrier.
      stream?.close(1000, 'terminal tab detached');
      // A reopen inside the quiet window is not a pane going idle: the next run decides what the lamp says.
      if (quietRef.current === undefined) onLinkRef.current('idle');
    };
  }, [active, connection, dependencies, readyVersion, reopenVersion, scope, terminal.id]);

  return (
    // `role="application"` is the honest answer to "what IS this element": a
    // live shell that consumes every keystroke itself. It is also what tells a
    // screen reader to stop intercepting arrow keys and pass them through, which
    // is the difference between a usable terminal and one where the reader's
    // cursor keys move the reading position instead of the shell's history.
    <>
      <div
        aria-label={`${terminal.title} shell`}
        className="kt-webterm__xterm"
        data-terminal-canvas={terminal.id}
        {...{ [KEYBOARD_CAPTURE_ATTRIBUTE]: '' }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => event.stopPropagation()}
        ref={hostRef}
        role="application"
      />
      {links.sheet}
    </>
  );
}

export function SessionTerminalDeck({
  connection,
  scope,
  cwd,
  dependencies,
  focusTerminalId,
  solo = false,
  active: onScreen = true,
  interceptInput = passInput,
  onInputPort,
}: SessionTerminalDeckProps) {
  // Not on screen is not attached: a hidden tab or a backgrounded page holds no stream.
  const streaming = useDocumentVisible() && onScreen;
  const [list, setList] = useState<TerminalListView | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [link, setLink] = useState<Record<string, TerminalLinkState>>({});
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await dependencies.list(connection, scope);
      // A listing about another session is damaged evidence, not an empty one.
      // Showing it would put another session's shells under this one's tabs.
      if (next.sessionId !== scope.sessionId) {
        setError('the daemon answered about a different session');
        return;
      }
      setList(next);
      setActiveId(current =>
        current !== null && next.terminals.some(terminal => terminal.id === current)
          ? current
          : (next.terminals[0]?.id ?? null),
      );
      setError(null);
    } catch (caught) {
      setError(failure(caught));
    }
  }, [connection, dependencies, scope]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Leaving the expanded view with Escape, because a fixed overlay with no
  // keyboard exit traps a reader who opened it by accident.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // The shell owns plain Escape (vim, readline); Shift+Escape leaves the expanded view.
      if (isKeyboardCaptured(event.target) && !isCaptureEscapeChord(event)) return;
      setExpanded(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);

  const listed = list?.terminals ?? [];
  // A solo body shows its one shell or nothing; it never falls back to whichever shell is first.
  const terminals = solo ? listed.filter(terminal => terminal.id === focusTerminalId) : listed;

  // A tab opened FOR one terminal selects that terminal — once the listing has
  // proved it exists. Before the listing lands there is nothing to prove it
  // against, and after a shell exits the request simply stops matching, which
  // leaves the reader on whatever they were on rather than on a silent swap.
  useEffect(() => {
    if (focusTerminalId === undefined) return;
    if (!terminals.some(terminal => terminal.id === focusTerminalId)) return;
    setActiveId(current => (current === focusTerminalId ? current : focusTerminalId));
  }, [focusTerminalId, terminals]);

  const active = terminals.find(terminal => terminal.id === (solo ? focusTerminalId : activeId)) ?? null;
  const atSessionCap = list === null ? false : listed.length >= list.limits.perSession;
  const atGlobalCap = list === null ? false : list.limits.runningGlobal >= list.limits.global;
  const activeLink = active === null ? 'idle' : (link[active.id] ?? 'idle');
  const ownership = ownershipOf(active);
  const standing = describeCoControl(activeLink, active?.viewers ?? 0, ownership);

  const createTerminal = async (): Promise<void> => {
    if (busy || atSessionCap || atGlobalCap) return;
    setBusy(true);
    setError(null);
    try {
      const terminal = await dependencies.create(connection, scope);
      setList(current =>
        current === null
          ? current
          : {
              ...current,
              terminals: [...current.terminals, terminal],
              limits: { ...current.limits, runningGlobal: current.limits.runningGlobal + 1 },
            },
      );
      setActiveId(terminal.id);
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  };

  const beginRename = (): void => {
    if (active === null) return;
    setRenameValue(active.title);
    setRenaming(true);
  };

  const saveRename = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (active === null || renameValue.trim() === '' || busy) return;
    setBusy(true);
    try {
      const updated = await dependencies.rename(connection, scope, active.id, renameValue.trim());
      setList(
        current =>
          current && {
            ...current,
            terminals: current.terminals.map(item => (item.id === updated.id ? updated : item)),
          },
      );
      setRenaming(false);
      setError(null);
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  };

  const closeTerminal = async (): Promise<void> => {
    if (active === null || busy) return;
    if (!dependencies.confirmClose(active.title)) return;
    const index = terminals.findIndex(item => item.id === active.id);
    const fallbackId = terminals[index + 1]?.id ?? terminals[index - 1]?.id ?? null;
    setBusy(true);
    try {
      await dependencies.close(connection, scope, active.id);
      setList(
        current =>
          current && {
            ...current,
            terminals: current.terminals.filter(item => item.id !== active.id),
            limits: { ...current.limits, runningGlobal: Math.max(0, current.limits.runningGlobal - 1) },
          },
      );
      setActiveId(current => (current === active.id ? fallbackId : current));
      setRenaming(false);
      setError(null);
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  };

  const copySelection = async (): Promise<void> => {
    const text = active === null ? '' : (selection[active.id] ?? '');
    if (text === '') return;
    try {
      await dependencies.writeClipboard(text);
    } catch {
      setError('Clipboard access was denied. Use Ctrl/Cmd+C while the selection is active.');
    }
  };

  return (
    <section
      aria-label="Shell terminals"
      className="kt-webterm"
      data-expanded={expanded ? '' : undefined}
      data-terminal-deck=""
    >
      {solo ? null : (
        <div className="kt-webterm__deck">
          <div aria-label="Open shell terminals" className="kt-webterm__tabs" role="tablist">
            {terminals.map(terminal => (
              <button
                aria-controls={`web-terminal-panel-${terminal.id}`}
                aria-selected={terminal.id === activeId}
                className="kt-webterm__tab"
                data-active={terminal.id === activeId ? true : undefined}
                data-owner={ownershipOf(terminal).by}
                id={`web-terminal-tab-${terminal.id}`}
                key={terminal.id}
                onClick={() => {
                  setActiveId(terminal.id);
                  setRenaming(false);
                }}
                role="tab"
                title={`${terminal.title} · ${describeSurfaceOwnership(ownershipOf(terminal)).text.toLowerCase()}`}
                type="button"
              >
                <span aria-hidden="true" className="kt-webterm__lamp" data-state={link[terminal.id] ?? 'idle'} />
                <span>{terminal.title}</span>
              </button>
            ))}
            <button
              aria-label="Create terminal"
              className="kt-webterm__new"
              disabled={busy || atSessionCap || atGlobalCap}
              onClick={() => void createTerminal()}
              title={atSessionCap || atGlobalCap ? 'Terminal capacity reached' : 'Create terminal'}
              type="button"
            >
              <Plus aria-hidden="true" size={15} />
            </button>
          </div>

          <div className="kt-webterm__ledger">
            <span className="kt-webterm__cwd" title={cwd ?? 'Session working directory'}>
              {cwd ?? 'session cwd'}
            </span>
            <span>{list === null ? 'loading terminals…' : terminalLimitLabel(list)}</span>
          </div>
        </div>
      )}

      {error === null ? null : (
        <div className="kt-webterm__error" role="alert">
          <span>{error}</span>
          <button aria-label="Retry loading terminals" onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" size={14} />
          </button>
        </div>
      )}

      {active === null && solo ? (
        <p className="kt-webterm__empty" data-terminal-missing="" role="status">
          {list === null
            ? 'Asking the daemon for this terminal…'
            : 'This terminal is no longer open on the daemon. Close this tab, or open a new terminal with ＋.'}
        </p>
      ) : active === null ? (
        <div className="kt-webterm__empty">
          <span aria-hidden="true" className="kt-webterm__empty-icon">
            <SquareTerminal size={24} />
          </span>
          <div>
            <strong>No shell terminals open</strong>
            <p>Start one here; it opens in this session’s working directory and survives page reloads.</p>
          </div>
          <Button
            disabled={busy || atSessionCap || atGlobalCap}
            onClick={() => void createTerminal()}
            type="button"
            variant="primary"
          >
            <Plus aria-hidden="true" size={15} />
            New terminal
          </Button>
        </div>
      ) : (
        <>
          <div className="kt-webterm__toolbar">
            {renaming ? (
              <form className="kt-webterm__rename" onSubmit={event => void saveRename(event)}>
                <input
                  aria-label="Terminal name"
                  maxLength={64}
                  onChange={event => setRenameValue(event.target.value)}
                  value={renameValue}
                />
                <Button
                  aria-label="Save name"
                  disabled={busy || renameValue.trim() === ''}
                  size="sm"
                  type="submit"
                  variant="ghost"
                >
                  <Check aria-hidden="true" size={14} />
                </Button>
                <Button
                  aria-label="Cancel rename"
                  onClick={() => setRenaming(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" size={14} />
                </Button>
              </form>
            ) : (
              <div className="kt-webterm__identity">
                <SquareTerminal aria-hidden="true" size={15} />
                <strong>{active.title}</strong>
                <span className="kt-webterm__connection" data-state={activeLink}>
                  {standing.link}
                </span>
              </div>
            )}
            <div aria-label="Terminal actions" className="kt-webterm__actions" role="toolbar">
              <Button
                aria-label="Copy selection"
                disabled={(selection[active.id] ?? '') === ''}
                onClick={() => void copySelection()}
                size="sm"
                title="Copy selection"
                type="button"
                variant="ghost"
              >
                <Clipboard aria-hidden="true" size={14} />
              </Button>
              <Button
                aria-label={
                  expanded ? 'Collapse the terminal back into the pane' : 'Expand the terminal to fill the screen'
                }
                aria-pressed={expanded}
                onClick={() => setExpanded(current => !current)}
                size="sm"
                title={expanded ? 'Collapse (Shift+Esc)' : 'Expand to full screen'}
                type="button"
                variant="ghost"
              >
                {expanded ? <Minimize2 aria-hidden="true" size={14} /> : <Maximize2 aria-hidden="true" size={14} />}
              </Button>
              <Button
                aria-label="Rename terminal"
                disabled={busy || renaming}
                onClick={beginRename}
                size="sm"
                title="Rename terminal"
                type="button"
                variant="ghost"
              >
                <Pencil aria-hidden="true" size={14} />
              </Button>
              <Button
                aria-label="Close terminal process"
                disabled={busy}
                onClick={() => void closeTerminal()}
                size="sm"
                title="Close terminal process"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" size={14} />
              </Button>
            </div>
          </div>

          {/* Read before the keyboard, not after: this is the sentence that
              tells a reader whose command their keystrokes are about to join. */}
          <p className="kt-webterm__cocontrol" data-owner={ownership.by} data-terminal-cocontrol="" role="status">
            {standing.sharing}
          </p>

          <div className="kt-webterm__stage">
            {terminals.map(terminal => (
              <div
                aria-labelledby={`web-terminal-tab-${terminal.id}`}
                className="kt-webterm__panel"
                hidden={terminal.id !== activeId}
                id={`web-terminal-panel-${terminal.id}`}
                key={terminal.id}
                role="tabpanel"
              >
                <TerminalCanvas
                  active={streaming && terminal.id === activeId}
                  connection={connection}
                  dependencies={dependencies}
                  interceptInput={interceptInput}
                  onInputPort={onInputPort}
                  onLink={state =>
                    setLink(current =>
                      current[terminal.id] === state ? current : { ...current, [terminal.id]: state },
                    )
                  }
                  onSelection={value =>
                    setSelection(current =>
                      current[terminal.id] === value ? current : { ...current, [terminal.id]: value },
                    )
                  }
                  scope={scope}
                  scrollback={list?.limits.scrollbackLines ?? 5_000}
                  terminal={terminal}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
