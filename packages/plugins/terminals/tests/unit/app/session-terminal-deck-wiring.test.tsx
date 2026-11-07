/**
 * The deck's PRODUCTION wiring — the one object every render test replaces.
 *
 * Everything else about the deck is proved against fakes, which is right: the behaviour under test there is the
 * deck's, not the browser's. But the factory those fakes stand in for is real code on the only path a reader ever
 * takes, and an untested one would let a typo in a route key, a stream opened outside the shell's guarded socket or a
 * clipboard call that never happens ship behind a green suite.
 *
 * Each dependency is driven with a recording client and its own global stubbed, so nothing here opens a socket,
 * reaches the network, or touches the daemon running on this box.
 */

import type { Instant } from '@ferretry/std';
import { afterEach, describe, expect, test } from 'bun:test';
import { terminalDeckDependencies } from '../../../app/lib/deck-dependencies.ts';
import type { TerminalStreamHandlers } from '../../../app/lib/web-terminals.ts';
import '@ferretry/app/testing';
import { recordingClient, socketClient } from '../../support/app/client.ts';

const scope = { sessionId: 'shared' };
const TERMINAL = 'a1b2c3d4e5f6';

/** A viewer that records nothing: these cases are about what the factory DIALS, not what it reads. */
const noHandlers = (): TerminalStreamHandlers => ({
  onOpen: () => undefined,
  onBytes: () => undefined,
  onClosed: () => undefined,
  onRefused: () => undefined,
});

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
  createdAt: '2026-08-01T10:00:00.000Z' as Instant,
  lastActivityAt: '2026-08-01T10:05:00.000Z' as Instant,
  idleDeadline: '2026-08-01T11:05:00.000Z' as Instant,
};

const listing = {
  sessionId: 'shared',
  terminals: [terminal],
  limits: { perSession: 6, global: 24, runningGlobal: 1, idleTimeoutSeconds: 900, scrollbackLines: 5_000 },
};

/** A daemon that answers exactly the routes the deck calls. */
const daemon = () =>
  recordingClient(route => {
    if (route === 'GET /v1/ferrets/:ferretId/terminals') return listing;
    if (route === 'POST /v1/ferrets/:ferretId/terminals') return terminal;
    if (route.startsWith('PATCH')) return { ...terminal, title: 'watch' };
    if (route.startsWith('DELETE')) return { closed: true, id: TERMINAL };
    return new Error(`unexpected route ${route}`);
  });

describe('terminalDeckDependencies', () => {
  test('asks the one daemon for its own terminals and lifecycle, by manifest route key', async () => {
    const { calls, client } = daemon();
    const dependencies = terminalDeckDependencies(client);

    const listed = await dependencies.list(scope);
    const created = await dependencies.create(scope);
    const renamed = await dependencies.rename(scope, TERMINAL, 'watch');
    const closed = await dependencies.close(scope, TERMINAL);

    expect(listed.terminals).toHaveLength(1);
    expect(created.id).toBe(TERMINAL);
    expect(renamed.title).toBe('watch');
    expect(closed).toEqual({ closed: true, id: TERMINAL });
    // Every call names the ferret.
    expect(calls.every(call => call.init?.params?.ferretId === 'shared')).toBe(true);
  });

  /*
   * A terminal is a guarded socket on the shell's client: an attach reaches neither a call nor a bare `WebSocket`.
   */
  test('opens a terminal as the shell’s guarded socket, opening no socket of its own', async () => {
    stub(
      'WebSocket',
      class {
        constructor() {
          throw new Error('no socket may be opened outside the shell');
        }
      } as unknown as typeof WebSocket,
    );
    const { client, opened } = socketClient();

    await terminalDeckDependencies(client).attach(scope, TERMINAL, noHandlers());

    expect(opened.map(item => item.key)).toEqual(['GET /v1/ferrets/:ferretId/terminals/:terminalId/stream']);
  });

  test('reads and ends holds through Vault’s routes', async () => {
    const { calls, client } = recordingClient(route =>
      route.startsWith('GET') ? { quarantines: [] } : { ended: true },
    );
    const dependencies = terminalDeckDependencies(client);

    await dependencies.quarantines?.(scope);
    await dependencies.endQuarantine?.(scope, 'dev');

    expect(calls.map(call => call.route)).toEqual([
      'GET /v1/ferrets/:ferretId/input-quarantines',
      'POST /v1/ferrets/:ferretId/input-quarantines/:key/end',
    ]);
  });

  test('names the shell in the confirmation, because closing one ends a process', async () => {
    const asked: string[] = [];
    stub('confirm', ((message: string) => {
      asked.push(message);
      return true;
    }) as unknown as typeof confirm);

    const confirmed = terminalDeckDependencies(daemon().client).confirmClose('build');

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

    await terminalDeckDependencies(daemon().client).writeClipboard('built ok');

    expect(written).toEqual(['built ok']);
  });

  test('loads the emulator lazily rather than shipping it in the first paint', async () => {
    // Most readers never open a shell. A static import would put a terminal
    // emulator in the initial bundle of a chat app.
    const modules = await terminalDeckDependencies(daemon().client).loadXterm();

    expect(typeof modules.Terminal).toBe('function');
    expect(typeof modules.FitAddon).toBe('function');
  });
});
