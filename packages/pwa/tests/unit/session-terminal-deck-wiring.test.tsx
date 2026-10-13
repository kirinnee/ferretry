/**
 * The deck's PRODUCTION wiring — the one object every render test replaces.
 *
 * Everything else about the deck is proved against fakes, which is right: the
 * behaviour under test there is the deck's, not the browser's. But the factory
 * those fakes stand in for is real code on the only path a reader ever takes,
 * and an untested one would let a typo in the stream path, a stream opened
 * outside a session or a clipboard call that never happens ship behind a green suite.
 *
 * Each dependency is driven with its own global stubbed, so nothing here opens a
 * socket, reaches the network, or touches the daemon running on this box.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { browserTerminalDeckDependencies } from '../../src/components/session-terminal-deck.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { RelayClientSession } from '../../src/lib/relay-session.ts';
import type { TerminalStreamHandlers } from '../../src/lib/web-terminals.ts';
import '../support/dom.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'alpha-token',
});
const scope = daemonSessionScope(alpha, 'shared');
const TERMINAL = 'a1b2c3d4e5f6';

/** A viewer that records nothing: these cases are about what the factory DIALS, not what it reads. */
const noHandlers = (): TerminalStreamHandlers => ({
  onOpen: () => undefined,
  onBytes: () => undefined,
  onClosed: () => undefined,
  onRefused: () => undefined,
});

/** The smallest thing `openStream` may answer with: a session that is open and carries nothing. */
const fakeStreamSession = (): RelayClientSession =>
  ({
    onStreamClosed: () => undefined,
    sendStream: () => undefined,
    closeStream: () => undefined,
  }) as unknown as RelayClientSession;
/** A stream opener for cases that never attach. */
const unusedOpener = async (): Promise<RelayClientSession> => {
  throw new Error('no stream may be opened by this case');
};

const restore: (() => void)[] = [];

/** Swaps one global for the duration of a case, and puts it back after. */
const stub = <K extends keyof typeof globalThis>(key: K, value: (typeof globalThis)[K]): void => {
  const previous = globalThis[key];
  globalThis[key] = value;
  restore.push(() => {
    globalThis[key] = previous;
  });
};

afterEach(() => {
  while (restore.length > 0) restore.pop()?.();
});

const terminal = {
  id: TERMINAL,
  sessionId: 'shared',
  title: 'build',
  state: 'running',
  cols: 80,
  rows: 24,
  viewers: 0,
  createdAt: '2026-08-01T10:00:00.000Z',
  lastActivityAt: '2026-08-01T10:05:00.000Z',
  idleDeadline: '2026-08-01T11:05:00.000Z',
};

const listing = {
  sessionId: 'shared',
  terminals: [terminal],
  limits: { perSession: 6, global: 24, runningGlobal: 1, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
};

/** A daemon that answers exactly the routes the deck calls. */
const daemonFetch =
  (calls: { url: string; method: string }[]) =>
  async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    if (url.endsWith('/terminals') && method === 'GET') return Response.json(listing);
    if (url.endsWith('/terminals') && method === 'POST') return Response.json(terminal);
    if (method === 'PATCH') return Response.json({ ...terminal, title: 'watch' });
    if (method === 'DELETE') return Response.json({ closed: true, id: TERMINAL });
    return Response.json({ error: 'unexpected route' }, { status: 500 });
  };

describe('browserTerminalDeckDependencies', () => {
  test('asks the paired daemon for its own terminals and lifecycle', async () => {
    const calls: { url: string; method: string }[] = [];
    const dependencies = browserTerminalDeckDependencies(daemonFetch(calls), unusedOpener);

    const listed = await dependencies.list(alpha, scope);
    const created = await dependencies.create(alpha, scope);
    const renamed = await dependencies.rename(alpha, scope, TERMINAL, 'watch');
    const closed = await dependencies.close(alpha, scope, TERMINAL);

    expect(listed.terminals).toHaveLength(1);
    expect(created.id).toBe(TERMINAL);
    expect(renamed.title).toBe('watch');
    expect(closed).toEqual({ closed: true, id: TERMINAL });
    // Every path is the paired daemon's, and every one names the session.
    expect(calls.every(call => call.url.startsWith('https://alpha.example.test/v1/sessions/shared/terminals'))).toBe(
      true,
    );
  });

  /*
   * There is no ticket to buy any more, on either carrier: a terminal is a stream session the device
   * key opened, so an attach must reach neither the request fetcher nor a bare `WebSocket`.
   */
  test('opens a terminal as a stream session, asking for no ticket and opening no socket of its own', async () => {
    const calls: { url: string; method: string }[] = [];
    stub(
      'WebSocket',
      class {
        constructor() {
          throw new Error('no socket may be opened for a relayed terminal');
        }
      } as unknown as typeof WebSocket,
    );
    const asked: string[] = [];

    await browserTerminalDeckDependencies(daemonFetch(calls), async (_daemon, request) => {
      asked.push(request.path);
      return fakeStreamSession();
    }).attach(alpha, scope, TERMINAL, noHandlers());

    expect(asked).toEqual([`/v1/sessions/shared/terminals/${TERMINAL}/stream`]);
    expect(calls).toEqual([]);
  });

  test('names the shell in the confirmation, because closing one ends a process', async () => {
    const asked: string[] = [];
    stub('confirm', ((message: string) => {
      asked.push(message);
      return true;
    }) as unknown as typeof confirm);

    const confirmed = browserTerminalDeckDependencies(daemonFetch([]), unusedOpener).confirmClose('build');

    expect(confirmed).toBe(true);
    expect(asked[0]).toContain('build');
    expect(asked[0]).toContain('ends its shell process');
  });

  test('writes the selection through the browser clipboard', async () => {
    const written: string[] = [];
    const clipboard = { writeText: async (text: string) => void written.push(text) };
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: clipboard });
    restore.push(() => {
      Reflect.deleteProperty(globalThis.navigator, 'clipboard');
    });

    await browserTerminalDeckDependencies(daemonFetch([]), unusedOpener).writeClipboard('built ok');

    expect(written).toEqual(['built ok']);
  });

  test('loads the emulator lazily rather than shipping it in the first paint', async () => {
    // Most readers never open a shell. A static import would put a terminal
    // emulator in the initial bundle of a chat app.
    const modules = await browserTerminalDeckDependencies(daemonFetch([]), unusedOpener).loadXterm();

    expect(typeof modules.Terminal).toBe('function');
    expect(typeof modules.FitAddon).toBe('function');
  });
});
