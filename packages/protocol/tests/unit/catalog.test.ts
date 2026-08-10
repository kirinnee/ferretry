import { describe, it } from 'bun:test';
import should from 'should';
import {
  AvailableSkillSchema,
  ProjectInfoSchema,
  ProjectPathSchema,
  RegisterProjectRequestSchema,
  SessionSkillsSchema,
} from '../../src/lib/catalog.ts';

describe('catalog protocol contracts', () => {
  it('should accept display-safe skills and project metadata', () => {
    should(
      SessionSkillsSchema.parse({
        harness: 'codex',
        skills: [{ name: 'release', description: 'Publish a snapshot', scope: 'project', origin: 'both' }],
      }),
    ).deepEqual({
      harness: 'codex',
      skills: [{ name: 'release', description: 'Publish a snapshot', scope: 'project', origin: 'both' }],
    });
    should(
      ProjectInfoSchema.parse({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'ferretry',
        path: '/work/ferretry',
        source: 'existing-folder',
        createdAt: '2026-08-04T00:00:00.000Z',
      }),
    ).deepEqual({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'ferretry',
      path: '/work/ferretry',
      source: 'existing-folder',
      createdAt: '2026-08-04T00:00:00.000Z',
    });
  });

  it('should refuse unrenderable catalog records', () => {
    should(
      AvailableSkillSchema.safeParse({ name: 'x', description: '', scope: 'global', origin: 'codex' }).success,
    ).be.false();
    should(
      ProjectInfoSchema.safeParse({ name: 'repo', path: '/work/repo', lastActivity: 'yesterday' }).success,
    ).be.false();
  });

  it('owns the absolute-path decision in the shared path schema', () => {
    for (const absolute of ['/work/ferretry', '/', '/a/b/c']) {
      should(ProjectPathSchema.safeParse(absolute).success).be.true();
    }
    // A relative path would resolve against the daemon's own directory; a shell tilde is not absolute either.
    for (const relative of ['relative/path', './here', '../escape', '~/home', 'bare', '']) {
      should(ProjectPathSchema.safeParse(relative).success).be.false();
    }
  });

  it('refuses a relative project path on every registration arm', () => {
    const arms = [
      { kind: 'existing-folder' },
      { kind: 'confirmed-discovery' },
      { kind: 'new-folder', initializeGit: false },
      { kind: 'clone', url: 'https://example.com/repo.git' },
    ] as const;
    for (const relative of ['relative/path', './here', '../escape', '~/home']) {
      for (const arm of arms) {
        should(RegisterProjectRequestSchema.safeParse({ ...arm, path: relative }).success).be.false();
      }
    }
  });

  it('preserves a valid absolute path on every registration arm', () => {
    const arms = [
      { kind: 'existing-folder', path: '/work/ferretry' },
      { kind: 'confirmed-discovery', path: '/work/ferretry' },
      { kind: 'new-folder', path: '/work/new', initializeGit: true },
      { kind: 'clone', url: 'https://example.com/repo.git', path: '/work/clone' },
    ] as const;
    for (const request of arms) {
      should(RegisterProjectRequestSchema.parse({ ...request }).path).equal(request.path);
    }
  });
});
