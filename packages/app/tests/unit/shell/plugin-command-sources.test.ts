import { describe, expect, it } from 'bun:test';
import { implementApp, type Manifest, type PluginClient, skeletonApp } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import {
  buildPluginCommandSources,
  destinationCommands,
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

describe('a plugin with several sources, and the ferret on screen', () => {
  const base = { daemon: 'd1', clientOf: clientFor, navigate: () => undefined, changed: () => undefined };

  it('lists every source a plugin answers, in its order', () => {
    const built = buildPluginCommandSources({
      ...base,
      surfaces: [
        entryOf(
          'board',
          contributing('board', () => [
            () => [{ id: 'places', group: 'Go to', label: 'Board', run: () => undefined }],
            () => [{ id: 'for-ferret', group: 'Go to', label: 'Board for Ms-98', run: () => undefined }],
          ]),
        ),
      ],
      screenHref: () => undefined,
    });
    expect(built).toHaveLength(2);
  });

  it('hands the ferret on screen to the source, and none when there is none', () => {
    const seen: (string | undefined)[] = [];
    const surfaces = [
      entryOf(
        'board',
        contributing('board', context => {
          seen.push(context.ferret);
          return () => [];
        }),
      ),
    ];
    buildPluginCommandSources({ ...base, surfaces, screenHref: () => undefined, ferret: 'f1' });
    buildPluginCommandSources({ ...base, surfaces, screenHref: () => undefined });
    expect(seen).toEqual(['f1', undefined]);
  });
});

describe('destinationCommands', () => {
  const context = (hrefs: Record<string, string>, went: string[]): PluginCommandContext => ({
    client: clientFor('board'),
    daemon: 'd1',
    navigate: href => went.push(href),
    screenHref: (_daemon, plugin, screen, params) =>
      hrefs[`${plugin}.${screen}${params?.tab === undefined ? '' : `/${params.tab}`}`],
    changed: () => undefined,
  });

  it('offers each screen once, under Go to, with its sentence, its words and its place', () => {
    const went: string[] = [];
    const source = destinationCommands('board', [
      { screen: 'board', label: 'Board', description: 'Every task', keywords: ['kanban'], order: 30 },
    ])(context({ 'board.board': '/d/d1/board' }, went));
    const [entry, ...rest] = source();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      id: 'screen-board.board',
      group: 'Go to',
      label: 'Board',
      description: 'Every task',
      keywords: ['board', 'board', 'kanban'],
      resting: true,
      order: 30,
    });
    entry?.run();
    expect(went).toEqual(['/d/d1/board']);
  });

  it('names a tab of a screen by its own id, and leaves out a screen no plugin draws', () => {
    const source = destinationCommands('catalogs', [
      { screen: 'sharing', label: 'Sharing', description: 'a', order: 1 },
      {
        id: 'screen-catalogs.sharing-shared',
        screen: 'sharing',
        params: { tab: 'shared' },
        label: 'Subscriptions',
        description: 'b',
        order: 2,
      },
      { screen: 'gone', label: 'Gone', description: 'c', order: 3 },
    ])(context({ 'catalogs.sharing': '/d/d1/sharing', 'catalogs.sharing/shared': '/d/d1/sharing/shared' }, []));
    expect(source().map(entry => entry.id)).toEqual(['screen-catalogs.sharing', 'screen-catalogs.sharing-shared']);
  });
});
