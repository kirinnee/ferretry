import { describe, expect, it } from 'bun:test';
import {
  harnessLabel,
  INFO_HINT,
  INFO_TAB_LABEL,
  INFO_TABS,
  lineage,
  loginScope,
  projectFact,
  readableReason,
  relativeTime,
  scrollToShow,
  worktreeFact,
} from '../../../../app/features/info/info-model.ts';
import type { ManagedWorktree } from '../../../../app/features/info/info-wire.ts';
import { ferretOf, NOW } from './fixtures.ts';

describe('INFO_TABS', () => {
  it('orders the tabs Ferrets owns and names each one', () => {
    expect(INFO_TABS).toEqual(['overview', 'runtime']);
    expect(INFO_TAB_LABEL.overview).toBe('Overview');
    expect(INFO_TAB_LABEL.runtime).toBe('Runtime');
    expect(Object.keys(INFO_HINT)).toContain('worktree');
  });
});

describe('harnessLabel / loginScope', () => {
  it('says Codex for a codex ferret, Claude Code for everything else', () => {
    expect(harnessLabel(ferretOf('a', { harness: 'codex' }))).toBe('Codex');
    expect(harnessLabel(ferretOf('a', { harness: 'claude-code' }))).toBe('Claude Code');
    expect(loginScope(ferretOf('a', { harness: 'codex' }))).toBe('Codex-only');
    expect(loginScope(ferretOf('a', { harness: 'claude-code' }))).toBe('Claude-only');
  });
});

const tree = (overrides: Partial<ManagedWorktree> = {}): ManagedWorktree => ({
  path: '/wt/app-feature',
  branch: 'feature',
  ...overrides,
});

describe('worktreeFact', () => {
  it('is unknown, never the main checkout, until the list is read', () => {
    expect(worktreeFact(ferretOf('a'), null)).toEqual({ kind: 'unknown' });
  });

  it('is the main checkout when the folder is in no managed worktree', () => {
    expect(worktreeFact(ferretOf('a', { folder: '/work/app' }), [tree()])).toEqual({ kind: 'main' });
  });

  it('picks the deepest managed worktree containing the folder, and reads its live branch and dirtiness', () => {
    const fact = worktreeFact(ferretOf('a', { folder: '/wt/app-feature/packages/x' }), [
      tree({ path: '/wt', branch: 'outer' }),
      tree({
        live: { branch: 'renamed', status: { staged: false, unstaged: true, untracked: false, conflicted: false } },
      }),
    ]);
    expect(fact).toEqual({ kind: 'worktree', path: '/wt/app-feature', branch: 'renamed', dirty: true });
  });

  it('does not match a sibling path that only shares a prefix, nor a removed worktree', () => {
    expect(worktreeFact(ferretOf('a', { folder: '/wt/app-feature-2' }), [tree()])).toEqual({ kind: 'main' });
    expect(worktreeFact(ferretOf('a', { folder: '/wt/app-feature' }), [tree({ removedAt: 'x' })])).toEqual({
      kind: 'main',
    });
  });

  it('says dirty is unknown when Git did not say', () => {
    expect(worktreeFact(ferretOf('a', { folder: '/wt/app-feature' }), [tree()])).toMatchObject({ dirty: null });
  });
});

describe('lineage', () => {
  const parent = ferretOf('p1');
  const first = ferretOf('c1', { parent: 'p1', createdAt: '2026-11-07T10:00:00.000Z' });
  const second = ferretOf('c2', { parent: 'p1', createdAt: '2026-11-07T11:00:00.000Z' });

  it('names the parent among the ferrets read, else just its id, and lists children newest first', () => {
    expect(lineage(first, [parent, first, second])).toMatchObject({ parent });
    expect(lineage(first, [first]).parent).toBe('p1');
    expect(lineage(parent, [parent, first, second]).children.map(child => String(child.id))).toEqual(['c2', 'c1']);
    expect(lineage(parent, undefined)).toEqual({ parent: null, children: [] });
  });
});

describe('projectFact', () => {
  it('is nothing for a ferret on no project and the id for one on a project', () => {
    expect(projectFact(ferretOf('a'))).toBeNull();
    expect(projectFact(ferretOf('a', { projectId: 'unfiled' }))).toBeNull();
    expect(projectFact(ferretOf('a', { projectId: '3f6f2a8e-0000-4000-8000-000000000001' }))).toBe(
      '3f6f2a8e-0000-4000-8000-000000000001',
    );
  });
});

describe('relativeTime', () => {
  it('says now, minutes, hours and days; and a dash for nothing', () => {
    expect(relativeTime('2026-11-07T11:59:30.000Z', NOW)).toBe('now');
    expect(relativeTime('2026-11-07T11:55:00.000Z', NOW)).toBe('5m ago');
    expect(relativeTime('2026-11-07T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(relativeTime('2026-11-05T12:00:00.000Z', NOW)).toBe('2d ago');
    expect(relativeTime(undefined, NOW)).toBe('—');
    expect(relativeTime('not a date', NOW)).toBe('—');
  });
});

describe('scrollToShow', () => {
  it('moves a tab row only as far as needed', () => {
    expect(scrollToShow(100, 50, 40, 200)).toBe(50);
    expect(scrollToShow(0, 180, 60, 200)).toBe(40);
    expect(scrollToShow(10, 50, 40, 200)).toBe(10);
  });
});

describe('readableReason', () => {
  it('keeps a short sentence and replaces a parse dump', () => {
    expect(readableReason('no ferret')).toBe('no ferret');
    expect(readableReason('{"issues":[]}')).toBe('the daemon answered with something this page cannot read');
    expect(readableReason('x'.repeat(200))).toBe('the daemon answered with something this page cannot read');
  });
});
