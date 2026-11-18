import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
import type { Inventory } from '../../../src/client/inventory.ts';
import { DaemonCallError, type TransportRequest } from '../../../src/client/transport.ts';
import { GrantsCache, type GrantRow, type GrantsReader } from '../../../src/shell/grants-cache.ts';
import { ShapeMemory } from '../../../src/shell/shape-memory.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';
import { interact } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';
import { CORE, FakeTransport, inventoryOf, json, surface } from '../client/fixtures.ts';

/**
 * WHAT A DEVICE REMEMBERS OF A MACHINE (shape only), and the rules that keep it harmless: keyed by daemon AND device,
 * cleared on every answer that is not a good list, never data, and the daemon still decides every read.
 */
const board = surface('board', { routes: ['GET /v1/board'] });
const compiled = [...CORE, board];
const read = (overrides: Parameters<typeof inventoryOf>[1] = {}): Extract<Inventory, { kind: 'read' }> => ({
  kind: 'read',
  entries: new Map(
    (inventoryOf(compiled, overrides) as { plugins: { id: string; on: boolean; contract: string }[] }).plugins.map(
      p => [p.id, { on: p.on, contract: p.contract }],
    ),
  ),
});
const row = (capability: string, use: boolean): GrantRow => ({
  capability,
  use,
  useRefusal: 'not-granted',
  configure: use,
  configureRefusal: 'not-granted',
});
const rows = (...list: GrantRow[]): ReadonlyMap<string, GrantRow> => new Map(list.map(r => [r.capability, r]));

describe('the shape store', () => {
  test('a good list and its grants come back for the same daemon and device', () => {
    const store = memoryStore();
    const memory = new ShapeMemory(store);
    memory.saveInventory('d1', 'dev-a', read());
    memory.saveGrants('d1', 'dev-a', rows(row('fleet', true)));
    const back = memory.read('d1', 'dev-a');
    expect(back.inventory?.entries.get('board')).toEqual({ on: true, contract: 'h-board' });
    expect(back.grants?.get('fleet')?.use).toBe(true);
    // Another machine holds nothing of it.
    expect(memory.read('d2', 'dev-a')).toEqual({});
  });

  test('another device id reads as nothing (a re-pair never inherits a shape) and the next live answer replaces it', () => {
    const store = memoryStore();
    const memory = new ShapeMemory(store);
    memory.saveInventory('d1', 'dev-a', read());
    expect(memory.read('d1', 'dev-b')).toEqual({});
    memory.saveInventory('d1', 'dev-b', read());
    expect(memory.read('d1', 'dev-b').inventory).toBeDefined();
    expect(memory.read('d1', 'dev-a')).toEqual({});
  });

  test('anything but a good list forgets the machine: refused, mismatched or unreadable', () => {
    for (const bad of [
      { kind: 'unreadable', refusal: { status: 403 } },
      { kind: 'protocol-mismatch', daemonProtocol: 9 },
      { kind: 'unreadable' },
    ] as const) {
      const memory = new ShapeMemory(memoryStore());
      memory.saveInventory('d1', 'dev-a', read());
      memory.saveGrants('d1', 'dev-a', rows(row('fleet', true)));
      memory.saveInventory('d1', 'dev-a', bad);
      expect(memory.read('d1', 'dev-a')).toEqual({});
    }
  });

  test('a locked or unreadable grants answer forgets the grants and keeps the plugin list', () => {
    const memory = new ShapeMemory(memoryStore());
    memory.saveInventory('d1', 'dev-a', read());
    memory.saveGrants('d1', 'dev-a', rows(row('fleet', true)));
    memory.saveGrants('d1', 'dev-a', undefined);
    const back = memory.read('d1', 'dev-a');
    expect(back.grants).toBeUndefined();
    expect(back.inventory).toBeDefined();
  });

  test('clear (unpair, re-pair, refused) removes everything', () => {
    const memory = new ShapeMemory(memoryStore());
    memory.saveInventory('d1', 'dev-a', read());
    memory.clear('d1');
    expect(memory.read('d1', 'dev-a')).toEqual({});
  });

  test('only the shape is ever read back: a record carrying anything else is refused whole', () => {
    const store = memoryStore();
    writeRecord(store, ShapeMemory.key('d1'), {
      deviceId: 'dev-a',
      inventory: { protocol: 1, plugins: [{ id: 'board', on: true, contract: 'h-board' }] },
      token: 'not-a-thing-we-keep',
    });
    expect(new ShapeMemory(store).read('d1', 'dev-a')).toEqual({});
    writeRecord(store, ShapeMemory.key('d1'), {
      deviceId: 'dev-a',
      grants: [{ ...row('fleet', true), body: { secret: 'x' } }],
    });
    expect(Object.keys(new ShapeMemory(store).read('d1', 'dev-a').grants?.get('fleet') ?? {})).not.toContain('body');
    // A grants row's own fields are all that is read back; an extra one is dropped on the way in.
    const back = new ShapeMemory(store).read('d1', 'dev-a').grants?.get('fleet');
    expect(back).toEqual(row('fleet', true));
    expect(JSON.stringify(back)).not.toContain('secret');
  });

  test('storage that refuses (a private window, a sandbox) costs only the memory', () => {
    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    for (const store of [refusing, null]) {
      const memory = new ShapeMemory(store);
      expect(() => {
        memory.saveInventory('d1', 'dev-a', read());
        memory.saveGrants('d1', 'dev-a', rows(row('fleet', true)));
        memory.clear('d1');
      }).not.toThrow();
      expect(memory.read('d1', 'dev-a')).toEqual({});
    }
  });
});

describe('a remembered shape only draws; the daemon still decides', () => {
  const answers = (locked: boolean) =>
    new FakeTransport((request: TransportRequest) => {
      if (request.path === '/v1/plugins') return json(inventoryOf(compiled));
      if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
      if (locked) return json({ error: 'confirm it is you', code: 'unlock_required' }, 401);
      return json({ cards: ['private'] });
    });

  test('standings are allowed at once from the remembered list, but no call is sent until the live list answers', async () => {
    const transport = answers(false);
    const client = new DaemonClient({ transport, surfaces: compiled, remembered: read() });
    expect(client.standing('board')).toEqual({ state: 'allowed' });
    const early = client.forPackage('board').call('GET /v1/board');
    await Promise.resolve();
    expect(transport.requests).toHaveLength(0);
    await client.start();
    await early;
    expect(transport.requests.map(r => r.path)).toEqual(['/v1/plugins', '/v1/health', '/v1/board']);
  });

  test('a remembered list the live one contradicts is replaced by it (a plugin turned off since)', async () => {
    const transport = new FakeTransport((request: TransportRequest) =>
      request.path === '/v1/plugins'
        ? json(inventoryOf(compiled, { board: { on: false } }))
        : json({ protocol: 1, version: '5.0.0' }),
    );
    const client = new DaemonClient({ transport, surfaces: compiled, remembered: read() });
    expect(client.standing('board').state).toBe('allowed');
    await client.start();
    expect(client.standing('board')).toEqual({ state: 'blocked', reason: 'off' });
    await expect(client.forPackage('board').call('GET /v1/board')).rejects.toBeInstanceOf(DaemonCallError);
  });

  test('a remembered list from another build (a contract moved) is not drawn from at all', () => {
    const client = new DaemonClient({
      transport: answers(false),
      surfaces: compiled,
      remembered: read({ board: { contract: 'h-old' } }),
    });
    expect(client.standing('board')).toEqual({ state: 'blocked', reason: 'unread' });
  });

  test('stale "allowed" grants + a refused read = the locked state and no data', async () => {
    const transport = answers(true);
    const client = new DaemonClient({ transport, surfaces: compiled, remembered: read() });
    // The grants cache is drawn from the remembered rows at once ...
    const cache = new GrantsCache(() => {});
    cache.attach('d1', client as GrantsReader, rows(row('fleet', true)));
    expect(cache.authority('d1', 'fleet', 'use')).toEqual({ kind: 'open' });
    // ... the daemon says unlock first: the read is refused, nothing it holds reaches the person, and the cache turns locked.
    await client.start();
    const refused = await client
      .forPackage('board')
      .call('GET /v1/board')
      .then(
        () => 'data',
        (error: unknown) => (error as DaemonCallError).status,
      );
    expect(refused).toBe(401);
    cache.refresh('d1');
    await new Promise(resolve => setTimeout(resolve, 5));
    // Never the remembered "open": the daemon refused, so the screen shows a refusal state, not data.
    expect(cache.authority('d1', 'fleet', 'use').kind).not.toBe('open');
  });

  test('the daemon saying "unlock first" turns a remembered open into the locked state', async () => {
    const cache = new GrantsCache(() => {});
    const fake = {
      generation: 0,
      onAuthority: () => () => {},
      readGrants: async () => ({ generation: 0, answer: json({}, 401), need: { kind: 'unlock' } }),
    } as unknown as GrantsReader;
    cache.attach('d1', fake, rows(row('fleet', true)));
    expect(cache.authority('d1', 'fleet', 'use')).toEqual({ kind: 'open' });
    cache.refresh('d1');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(cache.authority('d1', 'fleet', 'use')).toEqual({ kind: 'locked' });
  });

  test('every live grants answer is handed to be remembered, a locked one as nothing', async () => {
    const saved: (readonly string[] | undefined)[] = [];
    const cache = new GrantsCache(
      () => {},
      (_daemon, held) => saved.push(held === undefined ? undefined : [...held.keys()]),
    );
    const fake: GrantsReader = {
      generation: 0,
      onAuthority: () => () => {},
      readGrants: async () => ({
        generation: 0,
        answer: json({ capabilities: [row('fleet', true)] }),
        need: undefined,
      }),
    } as unknown as GrantsReader;
    cache.attach('d1', fake);
    cache.refresh('d1');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(saved).toEqual([['fleet']]);
  });
});

describe('the shell remembers a live shape and forgets it on unpair and re-pair', () => {
  const quiet = entryOf(
    manifestOf('quiet', { ui: { screens: [{ id: 'q', path: 'q', nav: { label: 'Quiet', order: 1 } }] } }),
    undefined,
  );

  test('a machine that answered is remembered under its device; unpairing it, or pairing it again, forgets it', async () => {
    const store = memoryStore();
    const memory = new ShapeMemory(store);
    const app = await bootApp({ surfaces: [quiet], machines: ['d1'], path: '/d/d1/q', shape: memory });
    try {
      await settle();
      const held = memory.read('d1', 'dev');
      expect(held.inventory?.entries.has('quiet')).toBe(true);
      expect(held.grants).toBeDefined();
      // Pairing it again replaces the pairing: nothing learned under the old one is kept.
      await interact(() => {
        app.list.add({ daemon: 'd1', machine: 'd1-host', deviceId: 'dev-2', address: 'http://127.0.0.1:40245' });
      });
      expect(memory.read('d1', 'dev')).toEqual({});
      await interact(() => new Promise(resolve => setTimeout(resolve, 100)));
      expect(memory.read('d1', 'dev-2').inventory).toBeDefined();
      await interact(() => {
        app.list.remove('d1');
      });
      expect(memory.read('d1', 'dev-2')).toEqual({});
    } finally {
      await app.view.unmount();
    }
  });
});
