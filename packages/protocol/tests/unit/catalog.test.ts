import { describe, it } from 'bun:test';
import should from 'should';
import { AvailableSkillSchema, ProjectInfoSchema, SessionSkillsSchema } from '../../src/lib/catalog.ts';

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
});
