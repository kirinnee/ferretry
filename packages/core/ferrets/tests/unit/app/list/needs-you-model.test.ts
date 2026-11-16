/**
 * "Group Needs you at the top" as pure decisions (S-0486): v4's `pullNeedsYou` and its stopped-but-asking rule, over
 * `FerretSummary` and what the Agenda says waits on the owner (`ferrets.needs-you`).
 */
import { describe, expect, test } from 'bun:test';
import type { FerretNeedsYou } from '../../../../contract/index.ts';
import { DEFAULT_LIST_FILTER, ferretListView, listedBeforeMode } from '../../../../app/features/list/list-model.ts';
import { summary as ferretSummary } from './support.ts';

const ferret = (id: string, over: Readonly<Record<string, unknown>> = {}) =>
  ferretSummary(id, { mode: 'interactive', folder: `/work/${id}`, ...over });
const waiting = (entries: Readonly<Record<string, Partial<FerretNeedsYou>>>): ReadonlyMap<string, FerretNeedsYou> =>
  new Map(
    Object.entries(entries).map(([id, over]) => [
      id,
      { count: 1, latestAt: '2026-11-01T10:00:00.000Z', ask: '', ...over },
    ]),
  );
const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map(row => row.id);
const ALL = { ...DEFAULT_LIST_FILTER, mode: 'all' } as const;

describe('Needs you group', () => {
  const ferrets = [ferret('quiet'), ferret('asks-old'), ferret('asks-new')];
  const needs = waiting({
    'asks-old': { latestAt: '2026-11-01T09:00:00.000Z' },
    'asks-new': { latestAt: '2026-11-01T11:00:00.000Z', count: 3 },
  });

  test('S-0486 gathers the ferrets that wait on the owner, newest first, and does not repeat them below', () => {
    const view = ferretListView(ferrets, ALL, undefined, { needing: needs, group: true });
    expect(ids(view.needsYou)).toEqual(['asks-new', 'asks-old']);
    expect(view.groups.flatMap(group => ids(group.rows))).toEqual(['quiet']);
  });

  test('S-0486 leaves them in their folders when the device turned the grouping off', () => {
    const view = ferretListView(ferrets, ALL, undefined, { needing: needs, group: false });
    expect(view.needsYou).toEqual([]);
    expect(view.groups.flatMap(group => ids(group.rows)).sort()).toEqual(['asks-new', 'asks-old', 'quiet']);
  });

  test('S-0486 draws no group when nothing waits, or when no provider says what waits', () => {
    expect(ferretListView(ferrets, ALL, undefined, { needing: new Map(), group: true }).needsYou).toEqual([]);
    expect(ferretListView(ferrets, ALL).needsYou).toEqual([]);
  });

  test('S-0486 keeps a pinned ferret in Pinned, above the group', () => {
    const view = ferretListView([ferret('pin', { pinnedAt: '2026-11-01T08:00:00.000Z' }), ...ferrets], ALL, undefined, {
      needing: waiting({ pin: {}, 'asks-old': {} }),
      group: true,
    });
    expect(ids(view.pinned)).toEqual(['pin']);
    expect(ids(view.needsYou)).toEqual(['asks-old']);
  });

  test('S-0486 follows the kind filter like every other row', () => {
    const view = ferretListView(
      [ferret('agent', { mode: 'auto' }), ferret('mine')],
      { ...DEFAULT_LIST_FILTER, mode: 'interactive' },
      undefined,
      { needing: waiting({ agent: {}, mine: {} }), group: true },
    );
    expect(ids(view.needsYou)).toEqual(['mine']);
  });

  test('S-0486 lists a stopped ferret that still has an open item, however the grouping is set', () => {
    const stopped = ferret('over', { state: 'stopped' });
    const filter = { ...ALL, showStopped: false };
    expect(listedBeforeMode(stopped, filter, undefined, waiting({ over: {} }))).toBe(true);
    expect(listedBeforeMode(stopped, filter, undefined, waiting({}))).toBe(false);
    expect(
      ids(ferretListView([stopped], filter, undefined, { needing: waiting({ over: {} }), group: true }).needsYou),
    ).toEqual(['over']);
  });
});
