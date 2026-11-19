import { describe, expect, it } from 'bun:test';
import {
  agoLabel,
  countsOf,
  emptyReason,
  folded,
  groupsOf,
  orderProjects,
  PAGE,
} from '../../../app/features/list/model.ts';
import { mixed, NOW, overview, OTHER, PROJECT, pull, view } from '../../fixtures/pulls-list-views.ts';

const first = (): (typeof mixed extends () => infer R ? R : never)['projects'][number] => {
  const only = mixed().projects[0];
  if (only === undefined) throw new Error('fixture has a project');
  return only;
};

describe('the PRs screen model', () => {
  it('counts what each filter would show, so a chip never lies', () => {
    expect(countsOf(mixed().projects)).toEqual({ mine: 1, review: 1, all: 4 });
  });

  it('filters to mine, review requested, or all, newest update first with a total tie-break', () => {
    const v = first();
    expect(groupsOf(v, 'mine')[0]?.pulls.map(p => p.number)).toEqual([1]);
    expect(groupsOf(v, 'review')[0]?.pulls.map(p => p.number)).toEqual([2]);
    // 4 and 1 and 2 share an update time: the higher number first; the older draft (3) last.
    expect(groupsOf(v, 'all')[0]?.pulls.map(p => p.number)).toEqual([4, 2, 1, 3]);
    expect(groupsOf(v, 'all')[0]?.open).toBe(4);
  });

  it('counts nothing for a project whose watch is off, since no row of it is drawn', () => {
    const off = overview(
      view({
        watch: false,
        repos: [
          {
            repo: view().repos[0]!.repo,
            account: 'gha_1',
            login: 'me',
            checkedAt: '2026-02-03T11:59:00Z',
            pulls: [pull(7, { mine: true })],
          },
        ],
      }),
      view({ project: OTHER }),
    ).projects;
    expect(countsOf(off)).toEqual({ mine: 0, review: 0, all: 0 });
    expect(countsOf([...off, ...mixed().projects])).toEqual({ mine: 1, review: 1, all: 4 });
  });

  it('puts watched projects first, then by name', () => {
    const views = overview(view({ project: OTHER, watch: false, repos: [] }), view()).projects;
    const names = new Map([
      [PROJECT, 'Zeta'],
      [OTHER, 'Alpha'],
    ]);
    expect(orderProjects(views, id => names.get(id) ?? id).map(v => v.project)).toEqual([PROJECT, OTHER]);
  });

  it('gives an empty list a reason', () => {
    const watchOff = overview(view({ watch: false })).projects[0]!;
    expect(emptyReason(watchOff, groupsOf(watchOff, 'all'), 'all', false)).toBe('watch-off');
    const noAccount = overview(view({ repos: [], needsAccount: [{ provider: 'github', owner: 'octo', name: 'x' }] }))
      .projects[0]!;
    expect(emptyReason(noAccount, groupsOf(noAccount, 'all'), 'all', false)).toBe('no-account');
    // Nothing read yet is not "no repo": only the project's own record says the folder holds none.
    const unread = overview(view({ repos: [] })).projects[0]!;
    expect(emptyReason(unread, groupsOf(unread, 'all'), 'all', false)).toBe('no-results');
    expect(emptyReason(unread, groupsOf(unread, 'all'), 'all', true)).toBe('no-repos');
    const none = overview(view()).projects[0]!;
    expect(emptyReason(none, groupsOf(none, 'all'), 'all', false)).toBe('none-open');
    const v = first();
    expect(emptyReason(v, groupsOf(v, 'all'), 'all', false)).toBeUndefined();
    const filtered = overview(
      view({
        repos: [
          {
            repo: view().repos[0]!.repo,
            account: 'gha_1',
            login: 'me',
            checkedAt: '2026-02-03T11:59:00Z',
            pulls: [pull(9)],
          },
        ],
      }),
    ).projects[0]!;
    expect(emptyReason(filtered, groupsOf(filtered, 'mine'), 'mine', false)).toBe('filtered');
  });

  it('folds a long list and says how many wait, never dropping any', () => {
    const items = Array.from({ length: PAGE + 7 }, (_, i) => i);
    const { shown, more } = folded(items, PAGE);
    expect(shown).toHaveLength(PAGE);
    expect(more).toBe(7);
    expect(folded(items, PAGE * 2).more).toBe(0);
  });

  it('reads time from the one clock passed in, and never goes negative', () => {
    expect(agoLabel(NOW, '2026-02-03T11:59:40Z')).toBe('just now');
    expect(agoLabel(NOW, '2026-02-03T11:56:00Z')).toBe('4m ago');
    expect(agoLabel(NOW, '2026-02-03T09:00:00Z')).toBe('3h ago');
    expect(agoLabel(NOW, '2026-01-30T12:00:00Z')).toBe('4d ago');
    expect(agoLabel(NOW, '2026-02-03T12:05:00Z')).toBe('just now');
    expect(agoLabel(NOW, 'not a time')).toBe('not a time');
  });
});
