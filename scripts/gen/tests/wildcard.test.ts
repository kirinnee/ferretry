/** `plugin-graph`: a `'*'` in permissions.spawn / network is a core piece's alone (lead decision 5). */
import { describe, expect, test } from 'bun:test';
import { ChildEnvironmentPort } from '../../../packages/core/kernel/contract/index.ts';
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

const manifest = (id: string, core: boolean, spawn: string[], network: string[]): Manifest =>
  ({
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core,
    kinds: [],
    permissions: { spawn, network },
  }) as unknown as Manifest;

describe('plugin-graph: wildcard reach', () => {
  test('a core piece may declare * ; a plugin declaring it in spawn or network is refused', () => {
    const messages = pluginGraphFindings(
      graphOf(
        manifest('vault', true, ['*'], ['*']),
        manifest('mcp', false, ['*'], []),
        manifest('relay', false, [], ['*']),
      ),
    )
      .filter(f => f.message.includes('permissions'))
      .map(f => `${f.where}: ${f.message}`);
    expect(messages).toEqual([
      "mcp: declares permissions.spawn '*'; only a core piece may",
      "relay: declares permissions.network '*'; only a core piece may",
    ]);
  });
});

describe('plugin-graph: kernel-only ports', () => {
  test('a manifest needing or using the ChildEnvironment opener is refused', () => {
    const thief = {
      ...manifest('thief', false, [], []),
      needs: { opener: ChildEnvironmentPort },
      uses: { other: ChildEnvironmentPort },
    } as unknown as Manifest;
    const messages = pluginGraphFindings(graphOf(thief))
      .filter(f => f.message.includes('only the kernel'))
      .map(f => f.message);
    expect(messages).toEqual([
      'asks for "child-environment", which only the kernel may hold',
      'asks for "child-environment", which only the kernel may hold',
    ]);
  });
});
