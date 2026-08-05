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
 * THE SOCKET CARRIES A TICKET, NEVER THE DEVICE TOKEN. A browser WebSocket cannot
 * set a header, so the stream URL carries a short-lived ticket bought over HTTP.
 * The device token stays in that request: a URL outlives the socket in history
 * and logs, and the page origin is never the daemon's.
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
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { grantRefusalNotice } from '../lib/grants.ts';
import { describeSurfaceOwnership, type SurfaceOwnership } from '../lib/surface-references.ts';
import {
  describeCoControl,
  shouldReopenTerminalStream,
  type TerminalLinkState,
  terminalReopenDelayMs,
  terminalResizeFrame,
} from '../lib/terminal-co-control.ts';
import {
  closeSessionTerminal,
  createSessionTerminal,
  daemonTerminalTicket,
  listSessionTerminals,
  renameSessionTerminal,
  terminalLimitLabel,
  terminalStreamUrl,
} from '../lib/web-terminals.ts';
import { Button } from '../shell/primitives.tsx';

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
  /** Buys the ticket and builds the one URL this socket may open. */
  streamUrl(daemon: DaemonConnection, scope: DaemonSessionScope, id: string): Promise<string>;
  openSocket(url: string): WebSocket;
  loadXterm(): Promise<XtermModules>;
  /** Subscribes to the document theme attributes and returns its cleanup. */
  watchTheme(repaint: () => void): () => void;
  /** Confirmation before a shell is killed. Injected so a test never blocks. */
  confirmClose(title: string): boolean;
  writeClipboard(text: string): Promise<void>;
}

export const browserTerminalDeckDependencies = (): TerminalDeckDependencies => ({
  list: listSessionTerminals,
  create: (daemon, scope) => createSessionTerminal(daemon, scope),
  rename: renameSessionTerminal,
  close: closeSessionTerminal,
  streamUrl: async (daemon, scope, id) =>
    terminalStreamUrl(daemon, scope, id, await daemonTerminalTicket(daemon, scope, id)),
  openSocket: url => new WebSocket(url),
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
  writeClipboard: async text => await navigator.clipboard.writeText(text),
});

export interface SessionTerminalDeckProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Display only — the daemon derives and enforces the shell's cwd itself. */
  readonly cwd?: string;
  readonly dependencies?: TerminalDeckDependencies;
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
}

/**
 * What a failed terminal call says.
 *
 * A grant refusal is worded as one rather than shown as a bare 403: the operator may have switched
 * `terminal` off, or the operator password may be needed, and "HTTP 403" tells a person neither. The
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
  const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--code-bg', '#111'),
    foreground: token('--code-fg', '#eee'),
    cursor: token('--accent', '#fff'),
    cursorAccent: token('--code-bg', '#111'),
    selectionBackground: token('--accent-soft', '#555'),
    selectionForeground: token('--fg', '#fff'),
    black: token('--fg', '#111'),
    brightBlack: token('--muted', '#777'),
    white: token('--surface-3', '#ddd'),
    brightWhite: token('--fg', '#fff'),
  };
}

/** xterm hands binary input back as a byte-per-char string, not a buffer. */
function bytesFromBinaryString(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

interface TerminalCanvasProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly terminal: TerminalView;
  readonly active: boolean;
  readonly scrollback: number;
  readonly dependencies: TerminalDeckDependencies;
  readonly onLink: (state: TerminalLinkState) => void;
  readonly onSelection: (selection: string) => void;
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
}: TerminalCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onLinkRef = useRef(onLink);
  const onSelectionRef = useRef(onSelection);
  onLinkRef.current = onLink;
  onSelectionRef.current = onSelection;
  const [readyVersion, setReadyVersion] = useState(0);
  const [reopenVersion, setReopenVersion] = useState(0);
  const attemptRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let stopWatchingTheme = () => {};
    let selectionDisposable: { dispose(): void } | undefined;
    let dataDisposable: { dispose(): void } | undefined;
    let binaryDisposable: { dispose(): void } | undefined;

    void dependencies
      .loadXterm()
      .then(({ Terminal, FitAddon }) => {
        if (disposed) return;
        const xterm = new Terminal({
          allowProposedApi: false,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: 'bar',
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
          fontSize: 12.5,
          lineHeight: 1.14,
          scrollback,
          theme: terminalTheme(),
        });
        const fit = new FitAddon();
        xterm.loadAddon(fit);
        stopWatchingTheme = dependencies.watchTheme(() => {
          xterm.options.theme = terminalTheme();
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
          const socket = socketRef.current;
          // Sent WHOEVER else is attached. There is no turn to wait for: this is
          // the line that makes co-control concurrent rather than a handover.
          if (socket?.readyState === WebSocket.OPEN) socket.send(bytes);
        };
        dataDisposable = xterm.onData(value => send(new TextEncoder().encode(value)));
        binaryDisposable = xterm.onBinary(value => send(bytesFromBinaryString(value)));
        selectionDisposable = xterm.onSelectionChange(() => onSelectionRef.current(xterm.getSelection()));

        const fitAndResize = (): void => {
          if (!activeRef.current || host.clientWidth < 1 || host.clientHeight < 1) return;
          try {
            fit.fit();
          } catch {
            return;
          }
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) socket.send(terminalResizeFrame(xterm.cols, xterm.rows));
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
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [dependencies, scrollback]);

  // `readyVersion` and `reopenVersion` are in the list although the body never
  // reads them: they ARE the triggers. The first fires once the emulator exists
  // so the socket has something to write into, and the second is what a
  // scheduled retry bumps. Dropping either would leave a live pane with no
  // stream and a dropped stream with no retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both versions are re-run triggers
  useEffect(() => {
    const xterm = terminalRef.current;
    const fit = fitRef.current;
    if (!active || xterm === null || fit === null) {
      onLinkRef.current('idle');
      return;
    }
    let disposed = false;
    let socket: WebSocket | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    onLinkRef.current('connecting');

    // The ticket is bought before the socket exists, so every teardown path has
    // to survive the await: a tab switched away from mid-purchase must not open
    // a socket nobody is watching.
    void dependencies
      .streamUrl(connection, scope, terminal.id)
      .then(url => {
        if (disposed) return;
        socket = dependencies.openSocket(url);
        socketRef.current = socket;
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => {
          if (disposed) return;
          attemptRef.current = 0;
          onLinkRef.current('live');
          globalThis.requestAnimationFrame(() => {
            if (disposed || socket === null) return;
            try {
              fit.fit();
              socket.send(terminalResizeFrame(xterm.cols, xterm.rows));
            } catch {
              // A zero-sized retained pane is fitted by ResizeObserver later.
            }
          });
        });
        socket.addEventListener('message', event => {
          if (!disposed && event.data instanceof ArrayBuffer) xterm.write(new Uint8Array(event.data));
        });
        socket.addEventListener('close', event => {
          if (disposed) return;
          if (!shouldReopenTerminalStream(event.code)) {
            // The daemon has judged this client. Retrying asks it the same
            // question, so the reader is told instead of watching a loop.
            onLinkRef.current('refused');
            return;
          }
          onLinkRef.current('reconnecting');
          attemptRef.current += 1;
          reopenTimer = setTimeout(
            () => setReopenVersion(version => version + 1),
            terminalReopenDelayMs(attemptRef.current),
          );
        });
        socket.addEventListener('error', () => {
          // `error` is always followed by `close`, which owns the retry decision.
          if (!disposed) onLinkRef.current('reconnecting');
        });
      })
      .catch(() => {
        if (disposed) return;
        // The ticket was refused or the daemon is unreachable. Both are worth
        // retrying: a device token is still valid across a network change.
        onLinkRef.current('reconnecting');
        attemptRef.current += 1;
        reopenTimer = setTimeout(
          () => setReopenVersion(version => version + 1),
          terminalReopenDelayMs(attemptRef.current),
        );
      });

    return () => {
      disposed = true;
      if (reopenTimer !== undefined) clearTimeout(reopenTimer);
      if (socketRef.current === socket) socketRef.current = null;
      socket?.close(1000, 'terminal tab detached');
      onLinkRef.current('idle');
    };
  }, [active, connection, dependencies, readyVersion, reopenVersion, scope, terminal.id]);

  return (
    // `role="application"` is the honest answer to "what IS this element": a
    // live shell that consumes every keystroke itself. It is also what tells a
    // screen reader to stop intercepting arrow keys and pass them through, which
    // is the difference between a usable terminal and one where the reader's
    // cursor keys move the reading position instead of the shell's history.
    <div
      aria-label={`${terminal.title} shell`}
      className="kt-webterm__xterm"
      data-terminal-canvas={terminal.id}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => event.stopPropagation()}
      ref={hostRef}
      role="application"
    />
  );
}

export function SessionTerminalDeck({
  connection,
  scope,
  cwd,
  dependencies = browserTerminalDeckDependencies(),
  focusTerminalId,
}: SessionTerminalDeckProps) {
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
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);

  const terminals = list?.terminals ?? [];

  // A tab opened FOR one terminal selects that terminal — once the listing has
  // proved it exists. Before the listing lands there is nothing to prove it
  // against, and after a shell exits the request simply stops matching, which
  // leaves the reader on whatever they were on rather than on a silent swap.
  useEffect(() => {
    if (focusTerminalId === undefined) return;
    if (!terminals.some(terminal => terminal.id === focusTerminalId)) return;
    setActiveId(current => (current === focusTerminalId ? current : focusTerminalId));
  }, [focusTerminalId, terminals]);

  const active = terminals.find(terminal => terminal.id === activeId) ?? null;
  const atSessionCap = list === null ? false : terminals.length >= list.limits.perSession;
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
      setList(current =>
        current === null
          ? current
          : { ...current, terminals: current.terminals.map(item => (item.id === updated.id ? updated : item)) },
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
      setList(current =>
        current === null
          ? current
          : {
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

      {error === null ? null : (
        <div className="kt-webterm__error" role="alert">
          <span>{error}</span>
          <button aria-label="Retry loading terminals" onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" size={14} />
          </button>
        </div>
      )}

      {active === null ? (
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
                title={expanded ? 'Collapse (Esc)' : 'Expand to full screen'}
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
                  active={terminal.id === activeId}
                  connection={connection}
                  dependencies={dependencies}
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
