/**
 * Reach declarations the kernel does not honour are refused at boot (fix round 1, MEDIUM-1 and LOW-1): `{ items: kind }`
 * of a kind another plugin owns, an `itemKind` on a plugin that is not an item plugin or on a kind already owned, and
 * ONE resolver name in both `spawn` and `network` (a host answer would authorize a same-named program and the reverse).
 * The boot graph and the testing host read the one rule, `reachFaults`, which CI's `plugin-graph` reads too.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineConfig, neverLoosens } from '../../../contract/index.ts';
import { planGraph } from '../../../host/graph.ts';
import {
  type DaemonImplementation,
  definePlugin,
  implementDaemon,
  type Manifest,
  reachFaults,
} from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const ITEM = z.object({ command: z.string().optional(), url: z.string().optional() });
const collection = (name: string, itemKind?: 'mcp' | 'skill') =>
  defineConfig({
    collection: name,
    ...(itemKind === undefined ? {} : { itemKind }),
    name: /^[a-z][a-z0-9-]*$/,
    schema: ITEM,
    axis: 'configure',
    loosens: neverLoosens,
  });

const plugin = (id: string, extra: Partial<Manifest> = {}): Manifest => ({
  id,
  title: id,
  version: '1.0.0',
  api: 5,
  core: false,
  kinds: [],
  ...extra,
});

const owner = (extra: Partial<Manifest> = {}): Manifest =>
  plugin('mcp', { kinds: ['item'], data: { config: [collection('mcp', 'mcp')] }, ...extra });

const none = (): readonly string[] => [];
const refusals = (...manifests: Manifest[]) =>
  planGraph(manifests, () => true, none).refused.map(refusal => [refusal.plugin, refusal.reason, refusal.sentence]);

describe('boot refusal: { items } of a kind another plugin owns (K1 owner-only, not only a build gate)', () => {
  test('the owner starts; a second plugin declaring { items: mcp } is refused naming the owner, and the owner still starts', () => {
    const plan = planGraph(
      [
        owner({ permissions: { spawn: [{ items: 'mcp' }] } }),
        plugin('thief', { permissions: { spawn: [{ items: 'mcp' }] } }),
      ],
      () => true,
      none,
    );
    expect(plan.order.map(manifest => manifest.id)).toEqual(['mcp']);
    expect(plan.refused.map(refusal => [refusal.plugin, refusal.reason, refusal.sentence])).toEqual([
      [
        'thief',
        'reach',
        "thief declares permissions.spawn { items: 'mcp' }, whose items are mcp's config collection; only mcp may.",
      ],
    ]);
  });

  test('network is checked as spawn is', () => {
    expect(refusals(owner(), plugin('thief', { permissions: { network: [{ items: 'mcp' }] } }))[0]?.[1]).toBe('reach');
  });

  test('a kind no plugin owns as a config collection stays open to any plugin (installed data-plugin items)', () => {
    expect(refusals(owner(), plugin('shells', { permissions: { spawn: [{ items: 'shell' }] } }))).toEqual([]);
  });

  test('a collection merely NAMED for the kind owns nothing: the declaration is itemKind', () => {
    const named = plugin('named', { kinds: ['item'], data: { config: [collection('mcp')] } });
    expect(refusals(named, plugin('user', { permissions: { spawn: [{ items: 'mcp' }] } }))).toEqual([]);
  });
});

describe('boot refusal: itemKind belongs to one item plugin', () => {
  test('a plugin that is not an item plugin cannot declare itemKind', () => {
    const impostor = plugin('impostor', { data: { config: [collection('mcp', 'mcp')] } });
    expect(refusals(impostor)).toEqual([
      ['impostor', 'reach', "impostor declares collection mcp with itemKind 'mcp' but is not an item plugin."],
    ]);
  });

  test('a second item plugin declaring itemKind for an owned kind is refused, the first keeps it', () => {
    const second = plugin('second', { kinds: ['item'], data: { config: [collection('servers', 'mcp')] } });
    expect(refusals(owner(), second)).toEqual([
      ['second', 'reach', "second declares collection servers with itemKind 'mcp', which mcp already owns."],
    ]);
  });
});

describe('boot refusal: one resolver name on one axis only', () => {
  const both = (spawn: string, network: string) =>
    plugin('mcp', { permissions: { spawn: [{ resolver: spawn }], network: [{ resolver: network }] } });

  test('the same resolver in spawn and network is refused, naming it', () => {
    expect(refusals(both('mcp-check', 'mcp-check'))).toEqual([
      [
        'mcp',
        'reach',
        "mcp names resolver 'mcp-check' in both permissions.spawn and permissions.network; use one resolver for programs and another for hosts.",
      ],
    ]);
  });

  test('two names, one for programs and one for hosts, start', () => {
    expect(refusals(both('mcp-check-program', 'mcp-check-host'))).toEqual([]);
  });

  test('a name in only one axis, or twice on the same axis, starts', () => {
    expect(
      refusals(plugin('a', { permissions: { spawn: [{ resolver: 'x' }, { resolver: 'x' }], network: [] } })),
    ).toEqual([]);
    expect(refusals(plugin('b', { permissions: { network: [{ resolver: 'y' }] } }))).toEqual([]);
  });

  test('the faults are the one rule the graph check reads, with a stable code', () => {
    expect(reachFaults([both('r', 'r')]).map(fault => fault.code)).toEqual(['resolver-axes']);
    expect(
      reachFaults([owner(), plugin('thief', { permissions: { spawn: [{ items: 'mcp' }] } })]).map(f => f.code),
    ).toEqual(['item-owner']);
  });
});

describe('the testing host refuses the same declarations', () => {
  /** An implementation over a hand-built manifest: only the declarations are under test, never a half. */
  const implement = (manifest: Manifest): DaemonImplementation =>
    implementDaemon(definePlugin(manifest as never), { build: () => ({}) } as never) as unknown as DaemonImplementation;

  test('a resolver on both axes fails the suite at start, saying which', async () => {
    const bad = plugin('mcp', {
      version: '5.0.0',
      permissions: { spawn: [{ resolver: 'r' }], network: [{ resolver: 'r' }] },
    });
    await expect(testHost({ plugins: [implement(bad)] })).rejects.toThrow(
      /testHost: mcp names resolver 'r' in both permissions.spawn and permissions.network/,
    );
  });

  test('{ items } of a kind another plugin owns fails the suite at start', async () => {
    const thief = plugin('thief', { permissions: { network: [{ items: 'mcp' }] } });
    await expect(testHost({ plugins: [implement(owner()), implement(thief)] })).rejects.toThrow(
      /testHost: thief declares permissions.network \{ items: 'mcp' \}/,
    );
  });
});
