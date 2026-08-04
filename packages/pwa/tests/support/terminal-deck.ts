/**
 * A terminal deck with no daemon, no socket and no emulator behind it.
 *
 * Every dependency the deck takes is replaced by something a test can drive and
 * inspect, so a render test can prove the tabs, the ownership badges, the
 * co-control line and the link lamp without opening a WebSocket — and, just as
 * importantly, so a test can never reach the network or the live daemon on this
 * box. The xterm loader is deliberately included: the deck's canvas effect runs
 * in these tests, and a real emulator in happy-dom is both slow and unreliable.
 */

import type { TerminalListView, TerminalView } from '@ferretry/protocol';
import type { TerminalDeckDependencies } from '../../src/components/session-terminal-deck.tsx';

export const terminalView = (id: string, patch: Partial<TerminalView> = {}, sessionId = 'shared'): TerminalView => ({
  id,
  sessionId,
  title: `Terminal ${id.slice(0, 1)}`,
  state: 'running',
  cols: 80,
  rows: 24,
  viewers: 0,
  createdAt: '2026-08-01T10:00:00.000Z',
  lastActivityAt: '2026-08-01T10:05:00.000Z',
  idleDeadline: '2026-08-01T11:05:00.000Z',
  ...patch,
});

export const terminalListing = (terminals: readonly TerminalView[], sessionId = 'shared'): TerminalListView => ({
  sessionId,
  terminals: [...terminals],
  limits: {
    perSession: 6,
    global: 24,
    runningGlobal: terminals.length,
    idleTimeoutSeconds: 900,
    scrollbackLines: 5_000,
  },
});

export interface FakeDeck {
  dependencies: TerminalDeckDependencies;
  /** Every socket the deck asked for, newest last. */
  readonly sockets: FakeSocket[];
  readonly renamed: { id: string; title: string }[];
  readonly closed: string[];
  readonly copied: string[];
  /** Stream URLs the deck resolved, so a test can prove daemon binding. */
  readonly urls: string[];
  confirm: boolean;
}

/** Just enough WebSocket for the deck: listeners, a send log and a close. */
class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  readonly sent: unknown[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  private readonly listeners = new Map<string, ((event: never) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(): void {
    // The deck removes nothing from a socket; it closes the whole socket.
  }

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }

  /** Drives the socket as the daemon would. */
  emit(type: string, event: unknown = {}): void {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) (listener as (value: unknown) => void)(event);
  }
}

export const fakeDeck = (
  listing: () => Promise<TerminalListView>,
  patch: Partial<TerminalDeckDependencies> = {},
): FakeDeck => {
  let minted = 0;
  const deck: FakeDeck = {
    sockets: [],
    renamed: [],
    closed: [],
    copied: [],
    urls: [],
    confirm: true,
    dependencies: undefined as unknown as TerminalDeckDependencies,
  };
  deck.dependencies = {
    list: listing,
    create: async () => {
      minted += 1;
      return terminalView(`${minted}${'0'.repeat(11)}`, { title: `Terminal ${minted}` });
    },
    rename: async (_daemon, _scope, id, title) => {
      deck.renamed.push({ id, title });
      return terminalView(id, { title });
    },
    close: async (_daemon, _scope, id) => {
      deck.closed.push(id);
      return { closed: true, id };
    },
    streamUrl: async (daemon, scope, id) => {
      const url = `wss://${daemon.daemonId}/v1/sessions/${scope.sessionId}/terminals/${id}/stream?ticket=t`;
      deck.urls.push(url);
      return url;
    },
    openSocket: url => {
      const socket = new FakeSocket(url);
      deck.sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    // A real emulator in happy-dom is slow and unreliable, and none of these
    // tests are about xterm's rendering — they are about what the deck does
    // around it. A test that wants the load to FAIL patches this.
    loadXterm: async () => fakeXterm(),
    watchTheme: () => () => {},
    confirmClose: () => deck.confirm,
    writeClipboard: async text => {
      deck.copied.push(text);
    },
    ...patch,
  };
  return deck;
};

/**
 * The smallest emulator the canvas effect can attach to.
 *
 * It answers every call the deck makes and records nothing: the deck's own
 * behaviour — sockets, resize frames, link states — is what the tests assert,
 * and a real xterm would only add a canvas happy-dom cannot paint.
 */
function fakeXterm() {
  return xtermSpy().modules;
}

/** One emulator instance, with the handlers the deck registered on it. */
export interface XtermInstance {
  /** Everything the deck wrote INTO the pane — the daemon's output. */
  readonly written: Uint8Array[];
  /** Simulates the reader typing. */
  type(value: string): void;
  /** Simulates a paste or another binary-mode input. */
  binary(value: string): void;
  /** Simulates the reader selecting pane text. */
  select(value: string): void;
  /** Asks the deck's own key handler whether it keeps a shortcut. */
  key(event: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; code: string }): boolean;
}

/**
 * The emulator, plus a handle on the instances the deck created.
 *
 * `type` is what makes the co-control property testable at all: it is the
 * reader's keystroke, and what a test asserts is that it reached the socket
 * whoever else owns the shell.
 */
export function xtermSpy(
  options: {
    readonly fitThrows?: boolean;
    readonly selection?: string;
    readonly onOpen?: () => void;
  } = {},
): {
  readonly modules: {
    Terminal: typeof import('@xterm/xterm').Terminal;
    FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  };
  readonly instances: XtermInstance[];
  /** Every theme the deck pushed after the first, i.e. every repaint. */
  readonly themes: unknown[];
} {
  const instances: XtermInstance[] = [];
  const themes: unknown[] = [];
  class Terminal {
    cols = 80;
    rows = 24;
    /** `theme` is an accessor so a repaint is observable: the deck assigns
     *  `xterm.options.theme`, which is a write THROUGH this object. */
    readonly options: { theme?: unknown } = {
      get theme(): unknown {
        return themes.at(-1);
      },
      set theme(value: unknown) {
        themes.push(value);
      },
    };
    readonly written: Uint8Array[] = [];
    #data: (value: string) => void = () => {};
    #binary: (value: string) => void = () => {};
    #selection: () => void = () => {};
    #key: (event: never) => boolean = () => true;

    constructor() {
      instances.push({
        written: this.written,
        type: value => this.#data(value),
        binary: value => this.#binary(value),
        select: () => this.#selection(),
        key: event => this.#key(event as never),
      });
    }

    loadAddon(): void {}
    open(): void {
      options.onOpen?.();
    }
    write(bytes: Uint8Array): void {
      this.written.push(bytes);
    }
    dispose(): void {}
    hasSelection(): boolean {
      return (options.selection ?? '') !== '';
    }
    getSelection(): string {
      return options.selection ?? '';
    }
    attachCustomKeyEventHandler(handler: (event: never) => boolean): void {
      this.#key = handler;
    }
    onData(listener: (value: string) => void): { dispose(): void } {
      this.#data = listener;
      return { dispose: () => {} };
    }
    onBinary(listener: (value: string) => void): { dispose(): void } {
      this.#binary = listener;
      return { dispose: () => {} };
    }
    onSelectionChange(listener: () => void): { dispose(): void } {
      this.#selection = listener;
      return { dispose: () => {} };
    }
  }
  class FitAddon {
    fit(): void {
      // A pane with no measurable box throws in the real addon; the deck has to
      // survive it, because a retained tab is exactly that until it is shown.
      if (options.fitThrows === true) throw new Error('cannot fit an unmeasured pane');
    }
  }
  return {
    modules: {
      Terminal: Terminal as unknown as typeof import('@xterm/xterm').Terminal,
      FitAddon: FitAddon as unknown as typeof import('@xterm/addon-fit').FitAddon,
    },
    instances,
    themes,
  };
}
