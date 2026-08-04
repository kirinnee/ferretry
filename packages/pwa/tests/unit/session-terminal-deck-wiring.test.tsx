/**
 * The deck's PRODUCTION wiring — the one object every render test replaces.
 *
 * Everything else about the deck is proved against fakes, which is right: the
 * behaviour under test there is the deck's, not the browser's. But the factory
 * those fakes stand in for is real code on the only path a reader ever takes,
 * and an untested one would let a typo in the stream URL, a missing ticket
 * exchange or a clipboard call that never happens ship behind a green suite.
 *
 * Each dependency is driven with its own global stubbed, so nothing here opens a
 * socket, reaches the network, or touches the daemon running on this box.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { browserTerminalDeckDependencies } from '../../src/components/session-terminal-deck.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import '../support/dom.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'alpha-token',
});
const scope = daemonSessionScope(alpha, 'shared');
const TERMINAL = 'a1b2c3d4e5f6';
/** The shape the protocol's socket-ticket schema actually accepts. */
const TICKET = 'fy_ticket_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
    if (url.endsWith('/stream/ticket'))
      return Response.json({ ticket: TICKET, ttlSeconds: 30, expiresAt: '2026-08-01T10:06:00.000Z' });
    if (url.endsWith('/terminals') && method === 'GET') return Response.json(listing);
    if (url.endsWith('/terminals') && method === 'POST') return Response.json(terminal);
    if (method === 'PATCH') return Response.json({ ...terminal, title: 'watch' });
    if (method === 'DELETE') return Response.json({ closed: true, id: TERMINAL });
    return Response.json({ error: 'unexpected route' }, { status: 500 });
  };

describe('browserTerminalDeckDependencies', () => {
  test('asks the paired daemon for its own terminals and lifecycle', async () => {
    const calls: { url: string; method: string }[] = [];
    stub('fetch', daemonFetch(calls) as unknown as typeof fetch);
    const dependencies = browserTerminalDeckDependencies();

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

  test('buys a ticket over HTTP and leaves the device token out of the socket URL', async () => {
    // The URL outlives the socket in history and in any log that retains it, so
    // the long-lived credential must never be in it. The ticket is one-time and
    // audience-bound to this exact stream.
    const calls: { url: string; method: string }[] = [];
    stub('fetch', daemonFetch(calls) as unknown as typeof fetch);

    const url = await browserTerminalDeckDependencies().streamUrl(alpha, scope, TERMINAL);

    expect(calls.at(0)).toEqual({
      url: `https://alpha.example.test/v1/sessions/shared/terminals/${TERMINAL}/stream/ticket`,
      method: 'POST',
    });
    expect(url).toBe(`wss://alpha.example.test/v1/sessions/shared/terminals/${TERMINAL}/stream?ticket=${TICKET}`);
    expect(url).not.toContain('alpha-token');
  });

  test('opens the socket at the URL it was given and nowhere else', async () => {
    const opened: string[] = [];
    class FakeSocket {
      constructor(url: string) {
        opened.push(url);
      }
    }
    stub('WebSocket', FakeSocket as unknown as typeof WebSocket);

    browserTerminalDeckDependencies().openSocket(`wss://alpha.example.test/stream?ticket=${TICKET}`);

    expect(opened).toEqual([`wss://alpha.example.test/stream?ticket=${TICKET}`]);
  });

  test('names the shell in the confirmation, because closing one ends a process', async () => {
    const asked: string[] = [];
    stub('confirm', ((message: string) => {
      asked.push(message);
      return true;
    }) as unknown as typeof confirm);

    const confirmed = browserTerminalDeckDependencies().confirmClose('build');

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

    await browserTerminalDeckDependencies().writeClipboard('built ok');

    expect(written).toEqual(['built ok']);
  });

  test('loads the emulator lazily rather than shipping it in the first paint', async () => {
    // Most readers never open a shell. A static import would put a terminal
    // emulator in the initial bundle of a chat app.
    const modules = await browserTerminalDeckDependencies().loadXterm();

    expect(typeof modules.Terminal).toBe('function');
    expect(typeof modules.FitAddon).toBe('function');
  });
});
