/**
 * Grouping by registered project and focusing one folder, as pure decisions: what `ferrets.list-scope` (Projects) says
 * about a ferret's folder, and what the list draws under a focus.
 */
import { describe, expect, test } from 'bun:test';
import type { FerretListScopeSnapshot } from '../../../../contract/index.ts';
import {
  DEFAULT_LIST_FILTER,
  ferretListView,
  groupByFolder,
  groupOf,
  scopeIsStale,
} from '../../../../app/features/list/list-model.ts';
import { summary as ferretSummary } from './support.ts';

const ferret = (id: string, folder: string) => ferretSummary(id, { mode: 'interactive', folder });
const ALL = { ...DEFAULT_LIST_FILTER, mode: 'all' } as const;

/** Projects registers `/work/app` as "App": a worktree under it files there too. */
const registered = (scope: string | null): FerretListScopeSnapshot => ({
  scope,
  known: true,
  groupOf: folder =>
    folder === '/work/app' || folder.startsWith('/work/app/') ? { key: '/work/app', name: 'App' } : null,
});
const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map(row => row.id);

describe('the list groups by the registered project', () => {
  const ferrets = [
    ferret('main', '/work/app'),
    ferret('tree', '/work/app/.worktrees/x'),
    ferret('other', '/work/solo'),
  ];

  test('a folder a project covers files under the project key and name; any other keeps its own folder group', () => {
    expect(groupOf(ferrets[1] as never, registered(null).groupOf)).toEqual({ key: '/work/app', name: 'App' });
    expect(groupOf(ferrets[2] as never, registered(null).groupOf)).toEqual({ key: '/work/solo', name: 'solo' });
    expect(groupOf(ferret('bare', ''), undefined)).toEqual({ key: '', name: 'ungrouped' });
  });

  test('a worktree and its repository are one group, named by the project', () => {
    const groups = groupByFolder(ferrets, registered(null).groupOf);
    expect(groups.map(group => [group.name, group.path, ids(group.rows).sort()])).toEqual([
      ['App', '/work/app', ['main', 'tree']],
      ['solo', '/work/solo', ['other']],
    ]);
  });

  test('without a provider the list groups by folder as it always did', () => {
    expect(groupByFolder(ferrets).map(group => group.name)).toEqual(['app', 'solo', 'x']);
  });
});

describe('the list under a focus', () => {
  const ferrets = [
    ferret('main', '/work/app'),
    ferret('tree', '/work/app/.worktrees/x'),
    ferret('other', '/work/solo'),
  ];

  test('draws only the focused group, and counts what it draws', () => {
    const view = ferretListView(ferrets, ALL, undefined, undefined, registered('/work/app'));
    expect(view.groups.flatMap(group => ids(group.rows)).sort()).toEqual(['main', 'tree']);
    expect(view.counts.all).toBe(3);
  });

  test('a focus on a folder with ferrets outside any project draws that folder', () => {
    const view = ferretListView(ferrets, ALL, undefined, undefined, registered('/work/solo'));
    expect(view.groups.flatMap(group => ids(group.rows))).toEqual(['other']);
  });

  test('no focus draws every group', () => {
    expect(ferretListView(ferrets, ALL, undefined, undefined, registered(null)).groups).toHaveLength(2);
    expect(ferretListView(ferrets, ALL).groups).toHaveLength(3);
  });

  test('a focus never hides what it does not match from Pinned: pinned ferrets outside it are not drawn either', () => {
    const pinned = ferretSummary('pin', {
      mode: 'interactive',
      folder: '/work/solo',
      pinnedAt: '2026-11-01T10:00:00.000Z',
    });
    const view = ferretListView([...ferrets, pinned], ALL, undefined, undefined, registered('/work/app'));
    expect(view.pinned).toEqual([]);
  });
});

describe('a focus on a folder that is gone', () => {
  const ferrets = [ferret('main', '/work/app'), ferret('other', '/work/solo')];

  test('is stale when no project covers it and no ferret files under it', () => {
    expect(scopeIsStale(ferrets, registered('/work/deleted'))).toBe(true);
  });

  test('is never stale before the registry is known: an unread registry covers no folder and proves nothing', () => {
    expect(scopeIsStale(ferrets, { ...registered('/work/deleted'), known: false })).toBe(false);
    expect(scopeIsStale([], { ...registered('/work/app'), known: false, groupOf: () => null })).toBe(false);
  });

  test('is not stale with no focus, under a registered project with no ferrets, or under a folder a ferret is in', () => {
    expect(scopeIsStale(ferrets, registered(null))).toBe(false);
    expect(scopeIsStale([], registered('/work/app'))).toBe(false);
    expect(scopeIsStale(ferrets, registered('/work/solo'))).toBe(false);
  });
});
