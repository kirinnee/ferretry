import { describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import type { TransportRequest } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import type { PasskeyHandler, PasskeyProvision, PromptOrigin } from '../../../src/passkey/passkey.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { memoryStore } from '../../../src/storage/records.ts';
import { HalfCache } from '../../../src/surfaces/halves.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { DEFAULT_LAYOUT } from '../../../src/layout/layout.ts';
import { CORE, FakeTransport, inventoryOf, json, surface } from '../client/fixtures.ts';

/**
 * THE ONE CLIENT CACHE (shell contract S2, R3 MJ2): a client lives as long as its connection. A reconnect and a
 * `kernel.plugins-changed` rebuild the halves and keep every client; a block answers `undefined` and an unblock the same
 * object; only an unpair drops them. The background-origin entry is a second entry of the same cache.
 */

const bare = surface('board', { routes: ['GET /v1/board', 'POST /v1/board'] });
const board: SurfaceEntry = { ...bare, app: implementApp(bare.manifest, { build: () => ({}) }) };
const layouts = surface('layouts', { routes: ['GET /v1/layouts/current'] });
const surfaces: SurfaceEntry[] = [...CORE, board, layouts];
const owner = { ...DEFAULT_LAYOUT, id: 'owner', density: 'compact' as const };
const theme = { id: 'default', label: 'Default', base: 'studio' };

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

const UNLOCK = { error: 'Unlock this machine with your passkey first.', code: 'unlock_required' };

function setup(options: { locked?: boolean } = {}) {
  let blocked = false;
  const transport = new FakeTransport((request: TransportRequest) => {
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces, blocked ? { board: { on: false } } : {}));
    if (request.path === '/v1/layouts/current') return json({ layout: owner, theme });
    if (options.locked === true) return json(UNLOCK, 401);
    return json({ cards: [] });
  });
  const origins: PromptOrigin[] = [];
  const handler: PasskeyHandler = {
    need: refusal => (refusal.status === 401 ? { kind: 'unlock' } : undefined),
    confirm: async (_daemon, _need, origin) => {
      origins.push(origin);
      return false;
    },
    ask: async () => false,
    focus: () => {},
    locked: () => [],
    subscribe: () => () => {},
  };
  const provision = { handler, Prompts: () => null } as unknown as PasskeyProvision;
  const daemons = new DaemonList({ storage: memoryStore(), now: () => 1 });
  daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
  let dials = 0;
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons,
    connect: async () => {
      dials += 1;
      return transport;
    },
    passkey: () => provision,
  });
  return {
    runtime,
    transport,
    daemons,
    origins,
    dials: () => dials,
    block: (value: boolean) => {
      blocked = value;
    },
  };
}

describe('the one client cache', () => {
  test('a transport reconnect and a kernel.plugins-changed keep every client the same object', async () => {
    const { runtime, transport } = setup();
    runtime.connection('d1');
    await settle();
    const ordinary = runtime.client('d1', 'board');
    const background = runtime.client('d1', 'board', 'background');
    expect(ordinary).toBeDefined();
    expect(background).toBeDefined();
    const half = runtime.half('d1', 'board');
    transport.reconnect();
    await settle();
    expect(runtime.client('d1', 'board')).toBe(ordinary);
    expect(runtime.client('d1', 'board', 'background')).toBe(background);
    // The halves are still rebuilt on the change (the views-remount follow-up is named, not done here).
    expect(runtime.half('d1', 'board')).not.toBe(half);
    transport.emit({ name: 'kernel.plugins-changed', payload: { generation: 2 } });
    await settle();
    expect(runtime.client('d1', 'board')).toBe(ordinary);
    expect(runtime.client('d1', 'board', 'background')).toBe(background);
  });

  test('Layouts does not re-read across a reconnect, and its layout never falls back to the default in between', async () => {
    const { runtime, transport } = setup();
    runtime.connection('d1');
    await settle();
    const seen: unknown[] = [];
    runtime.layouts.subscribe(() => seen.push(runtime.layouts.current('d1')));
    runtime.layouts.watch('d1');
    await settle();
    const read = runtime.layouts.current('d1');
    expect(read?.layout.id).toBe('owner');
    transport.reconnect();
    await settle();
    // The frame re-runs the watch on every runtime change: with the same client it is a no-op.
    runtime.layouts.watch('d1');
    transport.emit({ name: 'kernel.plugins-changed', payload: { generation: 3 } });
    await settle();
    runtime.layouts.watch('d1');
    await settle();
    expect(transport.paths().filter(path => path === 'GET /v1/layouts/current')).toHaveLength(1);
    expect(runtime.layouts.current('d1')).toBe(read);
    expect(seen.every(value => value !== undefined)).toBe(true);
  });

  test('a blocked package gets no client, and the same object once it is allowed again', async () => {
    const { runtime, block } = setup();
    runtime.connection('d1');
    await settle();
    const client = runtime.client('d1', 'board');
    const background = runtime.client('d1', 'board', 'background');
    block(true);
    const connection = runtime.connection('d1');
    if (connection.kind !== 'connected') throw new Error('not connected');
    await connection.client.refresh();
    await settle();
    expect(runtime.client('d1', 'board')).toBeUndefined();
    expect(runtime.client('d1', 'board', 'background')).toBeUndefined();
    expect(runtime.half('d1', 'board')).toBeUndefined();
    block(false);
    await connection.client.refresh();
    await settle();
    expect(runtime.client('d1', 'board')).toBe(client);
    expect(runtime.client('d1', 'board', 'background')).toBe(background);
  });

  test('an unpair drops the clients; a re-pair is a new connection with new clients', async () => {
    const { runtime, daemons, dials } = setup();
    runtime.connection('d1');
    await settle();
    const client = runtime.client('d1', 'board');
    daemons.remove('d1');
    expect(runtime.client('d1', 'board')).toBeUndefined();
    daemons.add({ daemon: 'd1', machine: 'laptop', deviceId: 'dev', address: 'http://127.0.0.1:40245' });
    runtime.connection('d1');
    await settle();
    expect(dials()).toBe(2);
    const again = runtime.client('d1', 'board');
    expect(again).toBeDefined();
    expect(again).not.toBe(client);
  });

  test('the background and ordinary entries differ; a background POST to a locked machine asks as background', async () => {
    const { runtime, origins } = setup({ locked: true });
    runtime.connection('d1');
    await settle();
    const ordinary = runtime.client('d1', 'board');
    const background = runtime.client('d1', 'board', 'background');
    expect(background).not.toBe(ordinary);
    await expect(background?.call('POST /v1/board', { body: { title: 'x' } })).rejects.toMatchObject({
      code: 'unlock_required',
    });
    expect(origins).toEqual(['background']);
    // The same POST through the ordinary entry is a press: it asks explicitly.
    await expect(ordinary?.call('POST /v1/board', { body: { title: 'x' } })).rejects.toMatchObject({
      code: 'unlock_required',
    });
    expect(origins).toEqual(['background', 'explicit']);
  });

  test('a client is undefined before its daemon answers, and a half for an unknown package is none', () => {
    const made: string[] = [];
    const cache = new HalfCache(
      new Map(surfaces.map(entry => [entry.id, entry])),
      (daemon, id, origin) => {
        made.push(`${daemon}/${id}/${origin}`);
        return undefined;
      },
      () => ({ state: 'allowed' }),
    );
    expect(cache.client('d1', 'board')).toBeUndefined();
    expect(cache.get('d1', 'board')).toBeUndefined();
    expect(cache.get('d1', 'nobody')).toBeUndefined();
    expect(made).toEqual(['d1/board/ordinary', 'd1/board/ordinary']);
  });
});
