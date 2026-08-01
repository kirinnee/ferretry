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
    should(ProjectInfoSchema.parse({ name: 'ferretry', path: '/work/ferretry' })).deepEqual({
      name: 'ferretry',
      path: '/work/ferretry',
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
