/**
 * `{ items: kind }` counts the kind OWNER's config items, live (K1): the real host (booted over a temp home, stub
 * spawn and fetch) and the testing host answer the same scenario alike. Only `command` and `url` are read, a `*` names
 * nothing, an edit that drops an item takes its reach away at once, and the installed data plugins' items stay in the
 * union.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { defineConfig, neverLoosens } from '../../../contract/index.ts';
import type { ConfigPort, FetchPort, KernelPorts, SpawnPort } from '../../../contract/ports.ts';
import { bootHost } from '../../../host/host.ts';
import { type ConfigOwnedKind, configOwnedKinds, itemReach } from '../../../host/items.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, type Manifest } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const ItemSchema = z.object({ command: z.string().optional(), url: z.string().optional() });
type Item = z.infer<typeof ItemSchema>;
const ITEMS = defineConfig({
  collection: 'mcp',
  itemKind: 'mcp',
  name: /^[a-z][a-z0-9-]*$/,
  schema: ItemSchema,
  axis: 'configure',
  loosens: neverLoosens,
});

const owner = (seen: { ports?: KernelPorts }) =>
  implementDaemon(
    definePlugin({
      id: 'mcp',
      title: 'MCP',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: ['item'],
      data: { config: [ITEMS] },
      permissions: { spawn: [{ items: 'mcp' }], network: [{ items: 'mcp' }] },
    }),
    {
      build: ({ kernel }) => {
        seen.ports = kernel;
        return {};
      },
    },
  );

/** What a caller of the owner's ports hears: whether each program and host is reachable, by name. */
async function reach(
  ports: KernelPorts,
  programs: readonly string[],
  hosts: readonly string[],
): Promise<Record<string, 'ok' | 'refused'>> {
  const out: Record<string, 'ok' | 'refused'> = {};
  for (const program of programs)
    out[`run ${program}`] = await ports.spawn.run(program, []).then(
      () => 'ok' as const,
      () => 'refused' as const,
    );
  for (const host of hosts)
    out[`fetch ${host}`] = await ports.fetch.request(`https://${host}/`).then(
      () => 'ok' as const,
      () => 'refused' as const,
    );
  return out;
}

const PROGRAMS = ['npx', '/opt/srv/server', '/tmp/server', 'rm', '*'];
const HOSTS = ['mcp.example.test', 'other.example.test', '*'];

/** The scenario both hosts run: boot with items, edit them live, and listen for what each edit reaches. */
async function scenario(
  ports: () => KernelPorts,
  setItems: (items: Readonly<Record<string, Item>>) => Promise<void>,
): Promise<Record<string, Record<string, 'ok' | 'refused'>>> {
  const heard: Record<string, Record<string, 'ok' | 'refused'>> = {};
  const listen = async (step: string): Promise<void> => {
    heard[step] = await reach(ports(), PROGRAMS, HOSTS);
  };
  await setItems({
    git: { command: 'npx' },
    remote: { url: 'https://mcp.example.test/sse' },
    wild: { command: '*', url: 'https://*/x' },
  });
  await listen('boot');
  // an edit that drops an item, and one that changes a command, take effect at once
  await setItems({ remote: { url: 'https://mcp.example.test/sse' }, wild: { command: '*' } });
  await listen('dropped');
  await setItems({ remote: { url: 'https://other.example.test/' }, exact: { command: '/opt/srv/server' } });
  await listen('changed');
  await setItems({});
  await listen('emptied');
  return heard;
}

const okFor = (heard: Record<string, 'ok' | 'refused'>): string[] =>
  Object.entries(heard)
    .filter(([, answer]) => answer === 'ok')
    .map(([name]) => name);

const stubSpawn = (): SpawnPort => ({
  run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
  runBytes: async () => {
    throw new Error('not run here');
  },
  start: () => {
    throw new Error('not started here');
  },
});
const stubFetch: FetchPort = { request: async () => new Response('') };

async function onTestingHost() {
  const seen: { ports?: KernelPorts } = {};
  const host = await testHost({
    plugins: [owner(seen)],
    spawn: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    fetch: async () => new Response(''),
  });
  try {
    return await scenario(
      () => seen.ports as KernelPorts,
      async items => host.setConfig('mcp', items),
    );
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-item-reach-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const seen: { ports?: KernelPorts } = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => undefined, { binary: 'fy' }),
      spawn: stubSpawn(),
      fetch: stubFetch,
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [owner(seen)],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    const config = (seen.ports as KernelPorts).config;
    return await scenario(
      () => seen.ports as KernelPorts,
      async items => {
        // the owner's own writes, through the one kernel writer: each lands before it answers
        for (const name of [...config.collection(ITEMS).keys()])
          if (!(name in items)) expect((await config.remove(ITEMS, name)).kind).toBe('written');
        for (const [name, item] of Object.entries(items))
          expect((await config.write(ITEMS, name, { patch: item })).kind).toBe('written');
      },
    );
  } finally {
    await outcome.host.stop();
  }
}

describe('K1: { items: mcp } counts the owner’s config items, live', () => {
  test('the real host: an owner item’s command is spawnable and its url host reachable, a non-item is neither', async () => {
    const heard = await onRealHost();
    expect(okFor(heard.boot as Record<string, 'ok' | 'refused'>)).toEqual(['run npx', 'fetch mcp.example.test']);
  });

  test('the real host: an edit that drops the item revokes its reach at once, a changed one moves it', async () => {
    const heard = await onRealHost();
    expect(okFor(heard.dropped as Record<string, 'ok' | 'refused'>)).toEqual(['fetch mcp.example.test']);
    expect(okFor(heard.changed as Record<string, 'ok' | 'refused'>)).toEqual([
      'run /opt/srv/server',
      'fetch other.example.test',
    ]);
    expect(okFor(heard.emptied as Record<string, 'ok' | 'refused'>)).toEqual([]);
  });

  test('a `*` command or host names nothing, and an absolute command allows only that path', async () => {
    const heard = await onRealHost();
    for (const step of Object.values(heard)) {
      expect(step['run *']).toBe('refused');
      expect(step['fetch *']).toBe('refused');
    }
    expect(heard.changed?.['run /tmp/server']).toBe('refused');
    expect(heard.changed?.['run /opt/srv/server']).toBe('ok');
  });

  test('the testing host answers every step identically to the real host', async () => {
    expect(await onTestingHost()).toEqual(await onRealHost());
  });
});

describe('itemReach: the union of installed items and the owner’s live config', () => {
  const none = (): { programs: string[]; hosts: string[] } => ({ programs: [], hosts: [] });
  const source = (kind: ConfigOwnedKind['kind'], current: () => ReadonlyMap<string, unknown>): ConfigOwnedKind => ({
    kind,
    read: current,
  });

  test('the installed data plugins’ items stay in the union beside the owner’s config items', () => {
    const configured = source('mcp', () => new Map([['a', { command: 'npx', url: 'https://cfg.example.test/' }]]));
    const reach = itemReach({
      installed: kind => (kind === 'mcp' ? { programs: ['pinned', 'npx'], hosts: ['pinned.example.test'] } : none()),
      configOwned: [configured],
    });
    expect(reach('mcp')).toEqual({
      programs: ['pinned', 'npx'],
      hosts: ['pinned.example.test', 'cfg.example.test'],
    });
    // another kind names nothing from this owner
    expect(reach('shell')).toEqual(none());
  });

  test('reach follows read() at each call: nothing is captured at boot and no change notice is needed', () => {
    let items = new Map<string, unknown>([['a', { command: 'one' }]]);
    const reach = itemReach({ installed: none, configOwned: [source('mcp', () => items)] });
    expect(reach('mcp').programs).toEqual(['one']);
    items = new Map([['b', { command: 'two' }]]);
    expect(reach('mcp').programs).toEqual(['two']);
    items = new Map();
    expect(reach('mcp').programs).toEqual([]);
  });

  test('a read that fails after a good read names nothing from the config; the installed items stay', () => {
    let fail = false;
    const reach = itemReach({
      installed: kind => (kind === 'mcp' ? { programs: ['pinned'], hosts: [] } : none()),
      configOwned: [
        source('mcp', () => {
          if (fail) throw new Error('unreadable');
          return new Map([['a', { command: 'one', url: 'https://one.example.test/' }]]);
        }),
      ],
    });
    expect(reach('mcp')).toEqual({ programs: ['pinned', 'one'], hosts: ['one.example.test'] });
    fail = true;
    expect(reach('mcp')).toEqual({ programs: ['pinned'], hosts: [] });
    fail = false;
    expect(reach('mcp').programs).toEqual(['pinned', 'one']);
  });

  test('a read that fails halfway names none of what it had read before it failed', () => {
    const half: ReadonlyMap<string, unknown> = {
      size: 2,
      values: function* () {
        yield { command: 'first' };
        throw new Error('torn');
      },
    } as unknown as ReadonlyMap<string, unknown>;
    expect(itemReach({ installed: none, configOwned: [source('mcp', () => half)] })('mcp')).toEqual(none());
  });

  test('a collection that cannot be read names nothing, and only command and url are read', () => {
    const broken = source('mcp', () => {
      throw new Error('unreadable');
    });
    expect(itemReach({ installed: none, configOwned: [broken] })('mcp')).toEqual(none());
    const wide = source(
      'mcp',
      () =>
        new Map<string, unknown>([
          ['a', { command: 'npx', args: ['evil'], env: { X: 'evil' }, host: 'evil.test', path: '/bin/evil' }],
          ['b', 'not a mapping'],
          ['c', { command: '  ', url: 'ftp://files.example.test/' }],
          ['d', { command: 'np*', url: 'https://*.example.test/' }],
        ]),
    );
    expect(itemReach({ installed: none, configOwned: [wide] })('mcp')).toEqual({ programs: ['npx'], hosts: [] });
  });
});

describe('configOwnedKinds: which collection backs a kind is declared (itemKind), never a name match', () => {
  const port = { collection: () => new Map([['a', { command: 'npx' }]]) } as unknown as ConfigPort;
  const manifestOf = (kinds: readonly string[], def: Record<string, unknown>): Manifest =>
    ({ id: 'p', title: 'P', kinds, data: { config: [{ kind: 'config', shape: 'collection', ...def }] } }) as never;
  const sources = (manifest: Manifest) => configOwnedKinds([manifest], () => port);

  test('a collection that says itemKind backs that kind, whatever the collection is called', () => {
    expect(sources(manifestOf(['item'], { collection: 'servers', itemKind: 'mcp' })).map(s => s.kind)).toEqual(['mcp']);
  });

  test('a collection named for an item kind without declaring itemKind backs nothing (a rename cannot grant reach)', () => {
    expect(sources(manifestOf(['item'], { collection: 'mcp' }))).toEqual([]);
    expect(sources(manifestOf(['item'], { collection: 'endpoint' }))).toEqual([]);
  });

  test('a plugin that is not an item plugin backs nothing even if its collection declares itemKind', () => {
    expect(sources(manifestOf([], { collection: 'mcp', itemKind: 'mcp' }))).toEqual([]);
  });
});
