import { describe, expect, it } from 'bun:test';
import type { PluginCommandContext } from '@ferretry/app';
import type { CommandBarEntry } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ferretSummary } from '../../../contract/testing/index.ts';
import { ferretsCommands } from '../../../app/command-bar.ts';

/** v4's "where was I" count: how many ferrets the bar offers with nothing typed. */
const RECENT_FERRET_COUNT = 6;
type Source = () => readonly CommandBarEntry[];
/** `shell.commands` answers the places first and the ferrets second. */
const ferretPlaces = (context: PluginCommandContext): Source => ferretsCommands(context)[0] as Source;
const ferretResults = (context: PluginCommandContext): Source => ferretsCommands(context)[1] as Source;

/**
 * Ferrets in the command bar: its two places (the list and "New ferret", last, as v4's new-session door was) and the
 * ferrets as results — the recent ones at rest, every one found by callsign, task or folder, each opening its chat.
 */

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const contextOf = (
  list: () => Promise<unknown>,
  went: string[] = [],
  changed: () => void = () => undefined,
): PluginCommandContext => ({
  client: { call: list } as unknown as PluginClient,
  daemon: 'dm1',
  navigate: href => went.push(href),
  screenHref: (daemon, plugin, screen, params) =>
    plugin === 'conversation' && screen === 'chat'
      ? `/d/${daemon}/ferrets/${params?.ferret}/chat`
      : plugin === 'ferrets'
        ? `/d/${daemon}/${screen === 'ferrets' ? 'ferrets' : 'new'}`
        : undefined,
  changed,
});

describe('Ferrets’ places', () => {
  it('S-0512 are the list and the new-ferret door, each once, in v4’s words and order', () => {
    const places = ferretPlaces(contextOf(async () => []))();
    expect(places.map(place => [place.id, place.label, place.order])).toEqual([
      ['screen-ferrets.ferrets', 'Ferrets', 5],
      ['screen-ferrets.new-ferret', 'New ferret', 1100],
    ]);
    expect(places.map(place => place.description)).toEqual([
      'Every ferret on this machine, grouped by project',
      'Start an agent in a working directory',
    ]);
    expect(places[1]?.keywords).toContain('spawn');
  });
});

describe('the ferrets as results', () => {
  const fleet = [
    ferretSummary({
      id: 'old',
      name: 'meghan',
      folder: '/work/nitroso',
      state: 'stopped',
      stateAt: '2026-11-01T00:00:00.000Z',
    }),
    ferretSummary({ id: 'quiet', name: 'ann', folder: '/work/a', state: 'idle', stateAt: '2026-11-10T00:00:00.000Z' }),
    ferretSummary({
      id: 'busy',
      name: 'ms-98',
      folder: '/work/ferretry',
      title: 'Fix the command bar',
      state: 'working',
      stateAt: '2026-11-12T00:00:00.000Z',
    }),
  ];

  it('lists nothing until the daemon answers, then asks the bar to list again', async () => {
    let changes = 0;
    const list = ferretResults(
      contextOf(
        async () => fleet,
        [],
        () => (changes += 1),
      ),
    );
    expect(list()).toEqual([]);
    await settle();
    expect(changes).toBe(1);
    expect(list()).toHaveLength(3);
  });

  it('puts live work first, newest first, the stopped last, and names each by its task, else its folder', async () => {
    const list = ferretResults(contextOf(async () => fleet));
    list();
    await settle();
    const entries = list();
    expect(entries.map(entry => entry.label)).toEqual(['Fix the command bar', 'a', 'nitroso']);
    expect(entries.map(entry => entry.order)).toEqual([0, 1, 2]);
    expect(entries[0]).toMatchObject({ group: 'Ferrets', description: 'Ms-98', detail: '/work/ferretry' });
    expect(entries[2]?.muted).toBe(true);
  });

  it('rests only the recent few: the rest are found by typing', async () => {
    const many = Array.from({ length: RECENT_FERRET_COUNT + 2 }, (_, index) =>
      ferretSummary({ id: `f${index}`, name: `n${index}`, stateAt: `2026-11-0${index + 1}T00:00:00.000Z` }),
    );
    const list = ferretResults(contextOf(async () => many));
    list();
    await settle();
    expect(list().filter(entry => entry.resting)).toHaveLength(RECENT_FERRET_COUNT);
    expect(list()).toHaveLength(RECENT_FERRET_COUNT + 2);
  });

  it('is found by callsign, id and folder, and opens the ferret’s chat', async () => {
    const went: string[] = [];
    const list = ferretResults(contextOf(async () => fleet, went));
    list();
    await settle();
    const busy = list()[0];
    expect(busy?.keywords).toEqual(
      expect.arrayContaining(['ms-98', 'Ms-98', 'busy', '/work/ferretry', 'Fix the command bar']),
    );
    busy?.run();
    expect(went).toEqual(['/d/dm1/ferrets/busy/chat']);
  });

  it('lists none, and says so by asking again, when the daemon cannot be read', async () => {
    let changes = 0;
    const list = ferretResults(
      contextOf(
        async () => {
          throw new Error('unreachable');
        },
        [],
        () => (changes += 1),
      ),
    );
    list();
    await settle();
    expect(changes).toBe(1);
    expect(list()).toEqual([]);
  });
});
