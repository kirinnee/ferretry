import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { generated } from '../../../src/generated/surfaces.ts';
import { DEFAULT_LAYOUT } from '../../../src/layout/layout.ts';
import { planFrame, viewsOf } from '../../../src/layout/engine.ts';
import { resolveLayout } from '../../../src/layout/layout.ts';
import { routeTable } from '../../../src/router/routes.ts';
import { screenHref } from '../../../src/router/screen-href.ts';
import { buildPluginCommandSources, placeSource } from '../../../src/shell/command-sources.ts';
import { commandBarResults, type CommandBarSource } from '../../../src/ui/command-bar-model.ts';

/**
 * THE COMMAND BAR AT v4 PARITY, over the REAL generated surfaces: the shell's own places and every plugin's
 * `shell.commands`, built the way the frame builds them. What v4's Ctrl+K showed at rest (a "Go to" list of every
 * place with its description, the recent sessions) and what typing found (a place, a session, "Board for <ferret>")
 * must hold with nothing mocked but the daemon.
 */

const views = viewsOf(generated.surfaces);
const screens = [...new Set(views.screens.values())];
const routes = routeTable(screens);

/** One valid ferret summary (an app test reaches another package only through the wire shape its client parses). */
const ferretSummary = (over: Record<string, unknown> & { readonly id: string }) => ({
  name: over.id,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work/project',
  state: 'idle',
  createdAt: '2026-11-01T00:00:00.000Z',
  stateAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const ferrets = [
  ferretSummary({
    id: 'f-old',
    name: 'meghan',
    folder: '/work/nitroso',
    state: 'stopped',
    stateAt: '2026-11-01T00:00:00.000Z',
  }),
  ferretSummary({
    id: 'f-live',
    name: 'ms-98',
    folder: '/work/ferretry',
    title: 'Fix the command bar',
    state: 'working',
    stateAt: '2026-11-12T00:00:00.000Z',
  }),
];

/** A daemon that answers the ferret list and nothing else (a plugin that asks more is refused, as an unreached one is). */
const client = {
  call: async (route: string) => {
    if (route === 'GET /v1/ferrets') return ferrets;
    throw new Error(`no daemon answers ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

const went: string[] = [];
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const sourcesOn = (ferret?: string): { readonly sources: CommandBarSource[]; readonly changed: () => number } => {
  let changes = 0;
  const plugins = buildPluginCommandSources({
    surfaces: generated.surfaces,
    daemon: 'dm1',
    clientOf: () => client,
    navigate: href => went.push(href),
    screenHref: (daemon, plugin, screen, params) => screenHref(views, routes, daemon, plugin, screen, params),
    changed: () => {
      changes += 1;
    },
    ferret,
  });
  return {
    sources: [
      placeSource({
        daemons: [],
        daemon: 'dm1',
        screens,
        routes,
        navigate: href => went.push(href),
      }),
      ...plugins,
    ],
    changed: () => changes,
  };
};

describe('Ctrl+K at rest', () => {
  it('lists v4’s places once each, in v4’s order, every one with its description', async () => {
    const { sources } = sourcesOn();
    commandBarResults(sources, '');
    await settle();
    const found = commandBarResults(sources, '');
    const places = found.groups.find(group => group.heading === 'Go to')?.entries ?? [];
    expect(places.map(entry => entry.label)).toEqual([
      'Ferrets',
      'Agenda',
      'Conversations',
      'Board',
      'Projects',
      'Sharing',
      'Subscriptions',
      'Publish skills…',
      'Insights',
      'Warden',
      'Lessons',
      'Open settings',
      'This device’s settings',
      'New ferret',
    ]);
    // One row per place, and none without its sentence.
    expect(new Set(places.map(entry => entry.id)).size).toBe(places.length);
    expect(places.filter(entry => entry.description === undefined || entry.description === '')).toEqual([]);
    expect(places.find(entry => entry.label === 'Board')?.description).toBe(
      'Every task on every machine as lanes: what is moving, stuck or waiting on you',
    );
  });

  it('S-0553 S-0554 opens each place at its own address, the Sharing tabs (Subscriptions, Publish skills…) included', async () => {
    const { sources } = sourcesOn();
    went.length = 0;
    const places = commandBarResults(sources, '').results;
    for (const label of ['Ferrets', 'Board', 'Projects', 'Sharing', 'Subscriptions', 'Publish skills…', 'New ferret']) {
      places.find(entry => entry.label === label)?.run();
    }
    expect(went).toEqual([
      '/d/dm1/ferrets',
      '/d/dm1/board',
      '/d/dm1/projects',
      '/d/dm1/sharing',
      '/d/dm1/sharing/shared',
      '/d/dm1/sharing/catalogs',
      '/d/dm1/new',
    ]);
  });

  it('offers the ferrets as "where was I": live work first, newest first, then the stopped ones', async () => {
    const { sources, changed } = sourcesOn();
    expect(commandBarResults(sources, '').groups.map(group => group.heading)).not.toContain('Ferrets');
    await settle();
    expect(changed()).toBeGreaterThan(0);
    const group = commandBarResults(sources, '').groups.find(one => one.heading === 'Ferrets');
    expect(group?.entries.map(entry => entry.label)).toEqual(['Fix the command bar', 'nitroso']);
    went.length = 0;
    group?.entries[0]?.run();
    expect(went).toEqual(['/d/dm1/ferrets/f-live/chat']);
  });

  it('draws no place twice: the shell’s plain nav entry and the plugin’s own are one row', () => {
    const { sources } = sourcesOn();
    const ids = commandBarResults(sources, '').results.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(commandBarResults(sources, '').results.filter(entry => entry.label === 'Ferrets')).toHaveLength(1);
  });
});

describe('typing in Ctrl+K', () => {
  it('S-0520 "Open settings" is v4’s entry, with its sentence, found by the words v4 knew it by', () => {
    const { sources } = sourcesOn();
    const settings = commandBarResults(sources, '').results.find(entry => entry.label === 'Open settings');
    expect(settings?.description).toBe('Appearance and behaviour on this browser, and every paired machine.');
    went.length = 0;
    settings?.run();
    expect(went).toEqual(['/d/dm1/settings']);
    expect(commandBarResults(sources, 'preferences').results[0]?.label).toBe('Open settings');
    expect(commandBarResults(sources, 'pairing').results[0]?.label).toBe('Open settings');
  });

  it('"board" finds the Board first, never Onboarding', () => {
    const { sources } = sourcesOn();
    const labels = commandBarResults(sources, 'board').results.map(entry => entry.label);
    expect(labels[0]).toBe('Board');
    expect(labels).not.toContain('Onboarding');
  });

  it('finds a place by a word v4 knew it by', () => {
    const { sources } = sourcesOn();
    const first = (query: string) => commandBarResults(sources, query).results[0]?.label;
    expect(first('kanban')).toBe('Board');
    expect(first('inbox')).toBe('Agenda');
    expect(first('spend')).toBe('Insights');
    expect(first('failover')).toBe('Warden');
    expect(first('publish')).toBe('Publish skills…');
  });

  it('finds a ferret by its callsign, its task or its folder', async () => {
    const { sources } = sourcesOn();
    commandBarResults(sources, '');
    await settle();
    const labels = (query: string) =>
      commandBarResults(sources, query)
        .groups.filter(group => group.heading === 'Ferrets')
        .flatMap(group => group.entries.map(entry => entry.label));
    expect(labels('meghan')).toEqual(['nitroso']);
    expect(labels('ms-98')).toEqual(['Fix the command bar']);
    expect(labels('ferretry')).toEqual(['Fix the command bar']);
  });
});

describe('Board for <ferret> (S-0449)', () => {
  it('is offered on a ferret’s page, named for that ferret, and opens the board narrowed to it', async () => {
    const { sources } = sourcesOn('f-live');
    commandBarResults(sources, '');
    await settle();
    const entry = commandBarResults(sources, 'board for').results.find(one => one.id === 'board-for-ferret-dm1');
    expect(entry).toMatchObject({
      label: 'Board for Ms-98',
      description: "Open the board filtered to this ferret's cards.",
    });
    went.length = 0;
    entry?.run();
    expect(went).toEqual(['/d/dm1/board?ferret=f-live']);
  });

  it('is not offered anywhere that is not a ferret’s page', () => {
    const { sources } = sourcesOn();
    expect(commandBarResults(sources, 'board for').results.map(entry => entry.id)).not.toContain(
      'board-for-ferret-dm1',
    );
  });
});

describe('the app nav', () => {
  it('carries Projects between Board and Insights, as v4’s bar did', () => {
    const plan = planFrame(resolveLayout(DEFAULT_LAYOUT, 'wide'), views);
    expect(plan.nav.entries.map(entry => (entry.kind === 'screen' ? entry.screen.label : entry.item))).toEqual([
      'Ferrets',
      'Agenda',
      'Board',
      'Projects',
      'Insights',
      'settings',
    ]);
  });
});
