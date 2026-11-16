import { describe, expect, test } from 'bun:test';
import type { ProjectInfo } from '../../../contract/index.ts';
import { discoveriesFrom } from '../../../app/lib/discoveries.ts';
import { baseName, coveringProject, normalizeProjectPath, relativeTime } from '../../../app/lib/folders.ts';
import { isProjectId, projectPath, projectsPath } from '../../../app/lib/paths.ts';

const project = (path: string, name = baseName(path)): ProjectInfo => ({
  id: '11111111-1111-4111-8111-111111111111' as ProjectInfo['id'],
  name,
  path,
  source: 'existing-folder',
  createdAt: '2026-08-01T00:00:00.000Z' as ProjectInfo['createdAt'],
});

describe('folder identity', () => {
  test('a trailing separator is not part of a folder’s identity; a root answers itself', () => {
    expect(normalizeProjectPath('/work/repo/')).toBe('/work/repo');
    expect(normalizeProjectPath('/')).toBe('/');
    expect(baseName('/home/k/.config/home-manager')).toBe('home-manager');
    expect(baseName('/')).toBe('/');
  });

  test('the longest registered path that prefixes a folder covers it, so a nested worktree keeps its own project', () => {
    const outer = project('/work/repo');
    const inner = { ...project('/work/repo-worktrees/feature'), id: '22222222-2222-4222-8222-222222222222' as never };
    const nested = { ...project('/work/repo/packages/app'), id: '33333333-3333-4333-8333-333333333333' as never };

    expect(coveringProject('/work/repo/packages/app/src', [outer, nested])?.path).toBe('/work/repo/packages/app');
    expect(coveringProject('/work/repo-worktrees/feature', [outer, inner])?.path).toBe('/work/repo-worktrees/feature');
    expect(coveringProject('/work/repository', [outer])).toBeUndefined();
  });

  test('relative time rounds to the largest unit and shows a dash for a missing instant', () => {
    const now = Date.parse('2026-08-10T12:00:00.000Z');
    expect(relativeTime('2026-08-10T11:59:50.000Z', now)).toBe('now');
    expect(relativeTime('2026-08-10T11:30:00.000Z', now)).toBe('30m ago');
    expect(relativeTime('2026-08-10T07:00:00.000Z', now)).toBe('5h ago');
    expect(relativeTime('2026-08-07T12:00:00.000Z', now)).toBe('3d ago');
    expect(relativeTime(undefined, now)).toBe('—');
  });
});

describe('discoveries', () => {
  test('are null while the ferret list is unread, never an empty claim', () => {
    expect(discoveriesFrom(null, [])).toBeNull();
  });

  test('list recent unregistered folders newest first, once each, folding away what a project covers', () => {
    const found = discoveriesFrom(
      [
        { folder: '/work/a', stateAt: '2026-08-01T00:00:00.000Z' },
        { folder: '/work/a/', stateAt: '2026-08-05T00:00:00.000Z' },
        { folder: '/work/b', stateAt: '2026-08-03T00:00:00.000Z' },
        { folder: '/work/registered/sub', stateAt: '2026-08-09T00:00:00.000Z' },
        { folder: '   ', stateAt: '2026-08-09T00:00:00.000Z' },
      ],
      [project('/work/registered')],
    );

    expect(found?.map(option => [option.path, option.name, option.lastActivity])).toEqual([
      ['/work/a', 'a', '2026-08-05T00:00:00.000Z'],
      ['/work/b', 'b', '2026-08-03T00:00:00.000Z'],
    ]);
  });

  test('an unread registry folds nothing away rather than guessing', () => {
    const found = discoveriesFrom([{ folder: '/work/a', stateAt: '2026-08-01T00:00:00.000Z' }], null);

    expect(found?.map(option => option.path)).toEqual(['/work/a']);
  });
});

describe('screen addresses', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  test('S-0377 the projects address is per daemon', () => {
    expect(projectsPath('workstation')).toBe('/d/workstation/projects');
    expect(projectsPath('daemon/laptop')).toBe('/d/daemon%2Flaptop/projects');
  });

  test('S-0376 a project address is minted only for a registered project UUID', () => {
    expect(projectPath('workstation', id)).toBe(`/d/workstation/projects/${id}`);
    expect(() => projectPath('workstation', '')).toThrow('must not be empty');
    expect(() => projectPath('workstation', '/work/ferretry')).toThrow('registered project UUID');
    expect(() => projectPath('workstation', 'ferretry')).toThrow('registered project UUID');
    expect(isProjectId(id)).toBe(true);
    expect(isProjectId('unfiled')).toBe(false);
  });
});
