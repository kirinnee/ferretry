/**
 * The deck's PRODUCTION wiring — the one object every render test replaces.
 *
 * Everything else about the deck is proved against fakes, which is right: the
 * behaviour under test there is the deck's, not the browser's. But the factory
 * those fakes stand in for is real code on the only path a reader ever takes,
 * and an untested one would let a typo in a route key, a stream opened outside a
 * session or a clipboard call that never happens ship behind a green suite.
 *
 * Each dependency is driven with its own global stubbed, so nothing here opens a
 * socket, reaches the network, or touches the daemon running on this box.
 */

import type { Instant } from '@ferretry/std';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { afterEach, describe, expect, test } from 'bun:test';
import { browserTerminalDeckHost } from '../../../app/components/session-terminal-deck.tsx';
import { pluginTerminalDeckDependencies } from '../../../app/lib/plugin-client.ts';
import { daemonConnection, daemonSessionScope } from '../../../app/shell.ts';
import '@ferretry/app/testing';

const alpha = daemonConnection('alpha');
const scope = daemonSessionScope(alpha, 'shared');
const TERMINAL = 'a1b2c3d4e5f6';

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

/** A daemon's client that answers exactly the routes the deck calls, and opens no stream unless a case gives one. */
const daemonClient = (calls: string[], socket?: PluginClient['socket']): PluginClient => ({
  call: (async (route: string) => {
    calls.push(route);
    if (route === 'GET /v1/ferrets/:ferretId/terminals') return listing;
    if (route === 'POST /v1/ferrets/:ferretId/terminals') return terminal;
    if (route.startsWith('PATCH')) return { ...terminal, title: 'watch' };
    if (route.startsWith('DELETE')) return { closed: true, id: TERMINAL };
    throw new Error(`unexpected route ${route}`);
  }) as PluginClient['call'],
  subscribe: () => () => undefined,
  ...(socket === undefined ? {} : { socket }),
});

const deps = (client: PluginClient) => pluginTerminalDeckDependencies(client, browserTerminalDeckHost());

describe('the deck’s production dependencies', () => {
  test('asks the paired daemon for its own terminals and lifecycle', async () => {
    const calls: string[] = [];
    const dependencies = deps(daemonClient(calls));

    const listed = await dependencies.list(alpha, scope);
    const created = await dependencies.create(alpha, scope);
    const renamed = await dependencies.rename(alpha, scope, TERMINAL, 'watch');
    const closed = await dependencies.close(alpha, scope, TERMINAL);

    expect(listed.terminals).toHaveLength(1);
    expect(created.id).toBe(TERMINAL);
    expect(renamed.title).toBe('watch');
    expect(closed).toEqual({ closed: true, id: TERMINAL });
    expect(calls).toEqual([
      'GET /v1/ferrets/:ferretId/terminals',
      'POST /v1/ferrets/:ferretId/terminals',
      'PATCH /v1/ferrets/:ferretId/terminals/:terminalId',
      'DELETE /v1/ferrets/:ferretId/terminals/:terminalId',
    ]);
  });

  /*
   * There is no ticket to buy, on any carrier: a terminal is a stream the device key opened, so an attach must
   * reach neither a request nor a bare `WebSocket`.
   */
  test('opens a terminal as a stream on the shell client, asking for no ticket and opening no socket of its own', async () => {
    const calls: string[] = [];
    stub(
      'WebSocket',
      class {
        constructor() {
          throw new Error('no socket may be opened for a terminal stream');
        }
      } as unknown as typeof WebSocket,
    );
    const asked: { key: string; params: Readonly<Record<string, string>> }[] = [];

    await deps(
      daemonClient(calls, (key, params) => {
        asked.push({ key, params });
        return { send: () => undefined, close: () => undefined };
      }),
    ).attach(alpha, scope, TERMINAL, {
      onOpen: () => undefined,
      onBytes: () => undefined,
      onClosed: () => undefined,
      onRefused: () => undefined,
    });

    expect(asked).toEqual([
      {
        key: 'GET /v1/ferrets/:ferretId/terminals/:terminalId/stream',
        params: { ferretId: 'shared', terminalId: TERMINAL },
      },
    ]);
    expect(calls).toEqual([]);
  });

  test('names the shell in the confirmation, because closing one ends a process', async () => {
    const asked: string[] = [];
    stub('confirm', ((message: string) => {
      asked.push(message);
      return true;
    }) as unknown as typeof confirm);

    const confirmed = deps(daemonClient([])).confirmClose('build');

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

    await deps(daemonClient([])).writeClipboard('built ok');

    expect(written).toEqual(['built ok']);
  });

  test('loads the emulator lazily rather than shipping it in the first paint', async () => {
    // Most readers never open a shell. A static import would put a terminal
    // emulator in the initial bundle of a chat app.
    const modules = await deps(daemonClient([])).loadXterm();

    expect(typeof modules.Terminal).toBe('function');
    expect(typeof modules.FitAddon).toBe('function');
  });
});
