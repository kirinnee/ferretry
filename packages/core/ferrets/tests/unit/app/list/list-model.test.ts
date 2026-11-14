/**
 * What the ferret list shows, as pure decisions. Ported from today's `sessions-bar-model.test.ts` (the pinned, stopped,
 * kind and directory describes), over `FerretSummary`.
 *
 * Left out, with the reason (the owner is not Ferrets): who needs the reader (Agenda's open items), the question a
 * waiting ferret asks (Conversation's), guide-builder ferrets (Packs' label), and how much a row says (density, Unit 3).
 */
import { describe, expect, test } from 'bun:test';
import {
  byPinOrder,
  DEFAULT_LIST_FILTER,
  emptyMessage,
  ferretDirectory,
  ferretListView,
  groupByFolder,
  isPinned,
  isStopped,
  listedBeforeMode,
  listTallies,
  matchesMode,
} from '../../../../app/features/list/list-model.ts';
import { summary as ferretSummary } from './support.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (milliseconds: number): string => new Date(NOW - milliseconds).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const ferret = (id: string, over: Readonly<Record<string, unknown>> = {}) =>
  ferretSummary(id, { mode: 'auto', folder: `/work/${id}`, ...over });

describe('pinned ferrets', () => {
  const pin = (id: string, minutes: number, state: 'working' | 'stopped' = 'working') =>
    ferret(id, { state, pinnedAt: new Date(Date.UTC(2026, 10, 2, 10, minutes)).toISOString() });
  const filter = { mode: 'all' as const, showStopped: false };

  test('lift into Pinned, oldest pin first, and are not repeated in their folder group', () => {
    const plain = ferret('plain');
    const result = ferretListView([plain, pin('late', 9), pin('early', 1)], filter);
    expect(result.pinned.map(row => String(row.id))).toEqual(['early', 'late']);
    expect(result.groups.flatMap(group => group.rows).map(row => String(row.id))).toEqual(['plain']);
    expect(isPinned(plain)).toBe(false);
  });

  test('a pin made at the same instant keeps its order by id, so the list never shuffles', () => {
    const same = new Date(Date.UTC(2026, 10, 2, 10, 1)).toISOString();
    const [b, a] = [ferret('b', { pinnedAt: same }), ferret('a', { pinnedAt: same })];
    expect([b, a].sort(byPinOrder).map(row => String(row.id))).toEqual(['a', 'b']);
  });

  test('a finished pinned ferret stays listed with Show stopped off; an unpinned one is hidden', () => {
    const done = pin('done', 2, 'stopped');
    const gone = ferret('gone', { state: 'stopped' });
    expect(listedBeforeMode(done, filter)).toBe(true);
    expect(listedBeforeMode(gone, filter)).toBe(false);
    expect(ferretListView([done, gone], filter).pinned.map(row => String(row.id))).toEqual(['done']);
  });

  test('S-0405 the kind filter applies to Pinned, and the tallies count the pinned ferret once', () => {
    const interactive = ferret('i', { mode: 'interactive', pinnedAt: ago(1_000) });
    const agent = pin('a', 3);
    const onlyInteractive = ferretListView([interactive, agent], { mode: 'interactive', showStopped: false });
    expect(onlyInteractive.pinned.map(row => String(row.id))).toEqual(['i']);
    expect(onlyInteractive.counts).toEqual({ all: 2, auto: 1, interactive: 1 });
  });
});

describe('which ferrets are over, and which kind they are', () => {
  test('stopped is the status mark’s own finished class', () => {
    expect(isStopped(ferret('a'))).toBe(false);
    expect(isStopped(ferret('b', { state: 'idle' }))).toBe(false);
    expect(isStopped(ferret('c', { state: 'stopped' }))).toBe(true);
  });

  test('a kind of ferret is its mode; All is every mode; a ferret whose record names no mode is an agent, as the daemon reads it', () => {
    const agent = ferret('a', { mode: 'auto' });
    const person = ferret('p', { mode: 'interactive' });
    const unmoded = ferret('u', { mode: undefined });
    expect([agent, person, unmoded].map(row => matchesMode(row, 'all'))).toEqual([true, true, true]);
    expect([agent, person, unmoded].map(row => matchesMode(row, 'auto'))).toEqual([true, false, true]);
    expect([agent, person, unmoded].map(row => matchesMode(row, 'interactive'))).toEqual([false, true, false]);
  });

  test('the segment counts classify every listed ferret into exactly one kind: Interactive + Agents = All', () => {
    const running = [
      ferret('a', { mode: 'auto' }),
      ferret('b', { mode: undefined }),
      ferret('c', { mode: undefined }),
      ferret('p', { mode: 'interactive' }),
    ];
    const { counts } = ferretListView(running, { mode: 'all', showStopped: false });
    expect(counts).toEqual({ all: 4, auto: 3, interactive: 1 });
  });
});

const ALL_KINDS = { ...DEFAULT_LIST_FILTER, mode: 'all' as const };
const SHOW_STOPPED = { ...ALL_KINDS, showStopped: true };

test('a new device opens on the ferrets a person drives, stopped ones tucked away', () => {
  expect(DEFAULT_LIST_FILTER).toEqual({ mode: 'interactive', showStopped: false });
});

describe('which ferrets the list lists', () => {
  test('stopped ferrets are hidden by default, however recently they stopped', () => {
    const alive = ferret('alive');
    const done = ferret('done', { state: 'stopped', stateAt: ago(1_000) });
    const view = ferretListView([alive, done], ALL_KINDS);
    expect(view.groups.flatMap(group => group.rows.map(row => String(row.id)))).toEqual(['alive']);
    expect(view.counts.all).toBe(1);
    expect(view.hiddenStopped).toBe(1);
  });

  test('every ferret, however long ago it finished — nothing is cut by age', () => {
    const alive = ferret('alive', { stateAt: ago(10 * DAY) });
    const old = ferret('old', { state: 'stopped', stateAt: ago(30 * DAY) });
    const undated = ferret('undated', { state: 'stopped', stateAt: 'not an instant' });
    const view = ferretListView([alive, old, undated], SHOW_STOPPED);
    expect(view.counts.all).toBe(3);
    expect(view.hiddenStopped).toBe(0);
    expect(view.groups.flatMap(group => group.rows.map(row => String(row.id))).sort()).toEqual([
      'alive',
      'old',
      'undated',
    ]);
  });

  test('groups by folder, newest first, and counts each kind over the same pool', () => {
    const ferrets = [
      ferret('a', { folder: '/work/ferretry', stateAt: ago(5_000) }),
      ferret('b', { folder: '/work/ferretry/', state: 'working', stateAt: ago(1_000) }),
      ferret('c', { folder: '/work/nitroso', mode: 'interactive', state: 'idle', stateAt: ago(2_000) }),
      ferret('gone', { folder: '/work/nitroso', state: 'stopped', stateAt: ago(3 * DAY) }),
    ];
    const all = ferretListView(ferrets, SHOW_STOPPED);
    expect(all.counts).toEqual({ all: 4, auto: 3, interactive: 1 });
    // The busiest folder leads; a trailing slash is the same folder.
    expect(all.groups.map(group => [group.name, group.rows.map(row => String(row.id))])).toEqual([
      ['ferretry', ['b', 'a']],
      ['nitroso', ['c', 'gone']],
    ]);

    const interactive = ferretListView(ferrets, { ...SHOW_STOPPED, mode: 'interactive' });
    expect(interactive.groups.flatMap(group => group.rows.map(row => String(row.id)))).toEqual(['c']);
    // Choosing a kind never changes what the other segments say they would show.
    expect(interactive.counts).toEqual(all.counts);
    const agents = ferretListView(ferrets, { mode: 'auto', showStopped: false });
    expect(agents.groups.flatMap(group => group.rows.map(row => String(row.id)))).toEqual(['b', 'a']);
    expect(agents.counts).toEqual({ all: 3, auto: 2, interactive: 1 });
  });

  test('groups of one size are ordered by name, and a folder with no name is "ungrouped"', () => {
    const groups = groupByFolder([
      ferret('z', { folder: '/work/zed' }),
      ferret('a', { folder: '/work/alpha' }),
      ferret('n', { folder: '' }),
    ]);
    expect(groups.map(group => group.name)).toEqual(['alpha', 'ungrouped', 'zed']);
  });

  test('S-0405 "Show stopped" counts the stopped ferrets of the kind chosen, and the open one stays listed', () => {
    const ferrets = [
      ferret('live'),
      ferret('agent-done', { state: 'stopped' }),
      ferret('person-done', { mode: 'interactive', state: 'stopped' }),
    ];
    expect(listTallies(ferrets, ALL_KINDS).hiddenStopped).toBe(2);
    expect(listTallies(ferrets, { mode: 'auto', showStopped: false }).hiddenStopped).toBe(1);
    expect(listTallies(ferrets, { mode: 'interactive', showStopped: false }).hiddenStopped).toBe(1);
    expect(listTallies(ferrets, SHOW_STOPPED).hiddenStopped).toBe(0);

    const open = (row: (typeof ferrets)[number]) => row.id === 'agent-done';
    const kept = ferretListView(ferrets, ALL_KINDS, open);
    expect(kept.groups.flatMap(group => group.rows.map(row => String(row.id))).sort()).toEqual(['agent-done', 'live']);
    expect(kept.counts.all).toBe(2);
    expect(kept.hiddenStopped).toBe(1);
  });

  test('the directory line is the folder, with a home directory written as ~', () => {
    const dir = (folder: string) => ferretDirectory(ferret('d', { folder }));
    expect(dir('/home/kirin/Workspace/ferretry')).toBe('~/Workspace/ferretry');
    expect(dir('/Users/erng/code')).toBe('~/code');
    expect(dir('/home/kirin')).toBe('~');
    expect(dir('/tmp/wt-session-layout')).toBe('/tmp/wt-session-layout');
    expect(dir('/homestead/kirin')).toBe('/homestead/kirin');
  });

  test('an empty list says which kind found nothing, and how many stopped ones the tick would add', () => {
    expect(emptyMessage({ mode: 'all', showStopped: false }, 0)).toBe('No ferrets are running.');
    expect(emptyMessage({ mode: 'interactive', showStopped: false }, 0)).toBe('No interactive ferrets.');
    expect(emptyMessage({ mode: 'auto', showStopped: false }, 0)).toBe('No agent ferrets.');
    expect(emptyMessage({ mode: 'all', showStopped: false }, 1)).toBe(
      'No live ferrets — 1 stopped. Tick Show stopped.',
    );
    expect(emptyMessage({ mode: 'auto', showStopped: false }, 2)).toBe(
      'No live agent ferrets — 2 stopped. Tick Show stopped.',
    );
  });
});
