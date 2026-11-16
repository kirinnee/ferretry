/** `plugin-graph`: `{ items: kind }` for a kind whose items live in one plugin's config collection is that owner's alone (K1). */
import { describe, expect, test } from 'bun:test';
import type { Manifest } from '../../../packages/core/kernel/manifest/index.ts';
import { pluginGraphFindings, type StartGraph } from '../lib/graph.ts';

const graphOf = (...manifests: Manifest[]): StartGraph =>
  ({
    ids: manifests.map(m => m.id),
    manifests: new Map(manifests.map(m => [m.id, m])),
    providers: new Map(),
    offerers: new Map(),
    hooks: new Map(),
    before: new Map(),
    order: manifests.map(m => m.id),
  }) as unknown as StartGraph;

/** A declared collection as the graph reads it: only its shape and name matter here, never its schema. */
const MCP_ITEMS = { kind: 'config', shape: 'collection', collection: 'mcp', itemKind: 'mcp' };

const manifest = (id: string, permissions: Record<string, unknown>, extra: Record<string, unknown> = {}): Manifest =>
  ({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: [], permissions, ...extra }) as unknown as Manifest;

const owner = (permissions: Record<string, unknown>): Manifest =>
  manifest('mcp', permissions, { kinds: ['item'], data: { config: [MCP_ITEMS] } });

const itemFindings = (...manifests: Manifest[]): string[] =>
  pluginGraphFindings(graphOf(...manifests))
    .filter(finding => finding.message.includes('config collection'))
    .map(finding => `${finding.where}: ${finding.message}`);

describe('plugin-graph: item reach is the config collection owner’s alone', () => {
  test('the owner may declare { items } for its own kind in spawn and network', () => {
    expect(itemFindings(owner({ spawn: [{ items: 'mcp' }], network: [{ items: 'mcp' }] }))).toEqual([]);
  });

  test('a second plugin declaring { items: mcp } in spawn or network fails the graph, naming the owner', () => {
    expect(
      itemFindings(
        owner({ spawn: [{ items: 'mcp' }] }),
        manifest('thief', { spawn: [{ items: 'mcp' }], network: [{ items: 'mcp' }] }),
      ),
    ).toEqual([
      "thief: declares permissions.spawn { items: 'mcp' }, whose items are mcp's config collection; only mcp may",
      "thief: declares permissions.network { items: 'mcp' }, whose items are mcp's config collection; only mcp may",
    ]);
  });

  test('a kind no plugin owns as a config collection (installed data-plugin items) stays open to any plugin', () => {
    expect(itemFindings(owner({}), manifest('shells', { spawn: [{ items: 'shell' }] }))).toEqual([]);
  });

  test('a collection merely named for the kind, without itemKind, owns nothing', () => {
    const named = manifest(
      'named',
      {},
      { kinds: ['item'], data: { config: [{ kind: 'config', shape: 'collection', collection: 'mcp' }] } },
    );
    expect(itemFindings(named, manifest('user', { spawn: [{ items: 'mcp' }] }))).toEqual([]);
  });

  test('itemKind on a plugin that is not an item plugin fails the graph', () => {
    const notAnItemPlugin = manifest('other', {}, { data: { config: [MCP_ITEMS] } });
    expect(allFindings(notAnItemPlugin)).toEqual([
      "other: declares collection mcp with itemKind 'mcp' but is not an item plugin",
    ]);
  });
});

const allFindings = (...manifests: Manifest[]): string[] =>
  pluginGraphFindings(graphOf(...manifests))
    .filter(finding => !finding.message.includes('kernel-bound port'))
    .map(finding => `${finding.where}: ${finding.message}`);

describe('plugin-graph: one resolver name serves one axis', () => {
  test('the same resolver in spawn and network fails the graph, naming it', () => {
    expect(
      allFindings(manifest('mcp', { spawn: [{ resolver: 'mcp-check' }], network: [{ resolver: 'mcp-check' }] })),
    ).toEqual([
      "mcp: names resolver 'mcp-check' in both permissions.spawn and permissions.network; use one resolver for programs and another for hosts",
    ]);
  });

  test('a program resolver and a host resolver pass', () => {
    expect(
      allFindings(
        manifest('mcp', { spawn: [{ resolver: 'mcp-check-program' }], network: [{ resolver: 'mcp-check-host' }] }),
      ),
    ).toEqual([]);
  });
});
