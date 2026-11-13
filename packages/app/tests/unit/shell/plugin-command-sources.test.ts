import { describe, expect, it } from 'bun:test';
import { implementApp, type Manifest, type PluginClient, skeletonApp } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import {
  buildPluginCommandSources,
  type PluginCommandContext,
  type PluginCommandSource,
  pluginCommandSources,
} from '../../../src/shell/command-sources.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';

/**
 * Plugins' command bar entries: a half contributes a source through `provideToShell(…, { commands })`, the shell
 * builds it per daemon over that plugin's own client, and a plugin that is not reached or whose source throws costs
 * only its own entries.
 */

const manifestOf = (id: string): Manifest =>
  ({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: ['view'], ui: {} }) as unknown as Manifest;

const entryOf = (id: string, app?: SurfaceEntry['app']): SurfaceEntry => ({
  id,
  title: id,
  core: false,
  contract: 'hash',
  consumes: [],
  manifest: manifestOf(id),
  ...(app === undefined ? {} : { app }),
});

const plainHalf = (id: string) => implementApp(manifestOf(id), { build: () => ({}) });
const contributing = (id: string, commands: PluginCommandSource) =>
  provideToShell(implementApp(manifestOf(id), { build: () => ({}) }), { commands });

const clientFor = (plugin: string): PluginClient =>
  ({ call: async () => plugin, subscribe: () => () => undefined }) as unknown as PluginClient;

describe('pluginCommandSources', () => {
  it('lists only the halves that contribute commands, with their plugin id', () => {
    const source: PluginCommandSource = () => () => [];
    const listed = pluginCommandSources([
      entryOf('kernel'),
      entryOf('board', plainHalf('board')),
      entryOf('agenda', provideToShell(plainHalf('agenda'), {})),
      entryOf('conversation', contributing('conversation', source)),
    ]);
    expect(listed).toEqual([{ plugin: 'conversation', source }]);
  });

  it('skips a skeleton half, which has no code to run', () => {
    const skeleton = { ...skeletonApp(manifestOf('usage')), shell: { commands: () => () => [] } };
    expect(pluginCommandSources([entryOf('usage', skeleton as unknown as SurfaceEntry['app'])])).toEqual([]);
  });
});

describe('buildPluginCommandSources', () => {
  const navigate = () => undefined;
  const screenHref = () => '/d1/board/card';
  const changed = () => undefined;

  it('hands each source its own plugin’s client and the daemon, navigation, addresses and changed callback', async () => {
    const seen: PluginCommandContext[] = [];
    const built = buildPluginCommandSources({
      surfaces: [
        entryOf(
          'conversation',
          contributing('conversation', context => {
            seen.push(context);
            return query => [{ id: `hit-${query}`, group: 'Cards', label: query, run: () => undefined }];
          }),
        ),
      ],
      daemon: 'd1',
      clientOf: plugin => clientFor(plugin),
      navigate,
      screenHref,
      changed,
    });
    expect(built).toHaveLength(1);
    expect((built[0] as (query: string) => readonly { id: string }[])('abc').map(entry => entry.id)).toEqual([
      'hit-abc',
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.daemon).toBe('d1');
    expect(seen[0]?.navigate).toBe(navigate);
    expect(seen[0]?.screenHref).toBe(screenHref);
    expect(seen[0]?.changed).toBe(changed);
    await expect(seen[0]?.client.call('GET /v1/x')).resolves.toBe('conversation');
  });

  it('builds nothing for a plugin with no client on that daemon', () => {
    let builds = 0;
    const built = buildPluginCommandSources({
      surfaces: [
        entryOf(
          'conversation',
          contributing('conversation', () => {
            builds += 1;
            return () => [];
          }),
        ),
      ],
      daemon: 'd1',
      clientOf: () => undefined,
      navigate,
      screenHref,
      changed,
    });
    expect(built).toEqual([]);
    expect(builds).toBe(0);
  });

  it('a source that throws while building costs only its own entries', () => {
    const built = buildPluginCommandSources({
      surfaces: [
        entryOf(
          'broken',
          contributing('broken', () => {
            throw new Error('a plugin broke');
          }),
        ),
        entryOf(
          'conversation',
          contributing('conversation', () => () => [
            { id: 'kept', group: 'Cards', label: 'Kept', run: () => undefined },
          ]),
        ),
      ],
      daemon: 'd1',
      clientOf: plugin => clientFor(plugin),
      navigate,
      screenHref,
      changed,
    });
    expect(built).toHaveLength(1);
    expect((built[0] as (query: string) => readonly { id: string }[])('').map(entry => entry.id)).toEqual(['kept']);
  });
});
