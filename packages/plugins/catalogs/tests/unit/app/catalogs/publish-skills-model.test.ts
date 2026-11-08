import { describe, expect, it } from 'bun:test';
import type { SkillEntry } from '../../../../app/lib/machine-skills.ts';
import { publishableSkills } from '../../../../app/features/catalogs/publish-skills-model.ts';
import { ownedCatalog } from '../support/catalog-views.ts';

const entry = (overrides: Partial<SkillEntry> & Pick<SkillEntry, 'name'>): SkillEntry => ({
  description: `What ${overrides.name} does`,
  harness: 'claude',
  scope: 'user',
  path: `/home/k/.claude/skills/${overrides.name}/SKILL.md`,
  runtimes: ['claude-work'],
  ...overrides,
});

describe('publishableSkills', () => {
  const catalog = ownedCatalog();

  it('lists each SKILL.md once, sorted by name, saying where it lives and whether this catalog holds it', () => {
    const rows = publishableSkills(
      [
        entry({ name: 'zeta' }),
        entry({ name: 'pdf-tools' }),
        entry({ name: 'pdf-tools', runtimes: ['claude-other'] }),
        entry({
          name: 'lint',
          scope: 'project',
          path: '/work/app/.claude/skills/lint/SKILL.md',
          project: { name: 'app', root: '/work/app' },
        }),
        entry({ name: 'babysit', scope: 'ferretry' }),
        entry({ name: 'alone', runtimes: [] }),
      ],
      catalog,
      '',
    );
    expect(rows.map(row => [row.name, row.where, row.held])).toEqual([
      ['alone', 'this machine', null],
      ['babysit', 'Ferretry', null],
      ['lint', 'project app', null],
      ['pdf-tools', 'account claude-work', 'In this catalog · v2'],
      ['zeta', 'account claude-work', null],
    ]);
  });

  it('says a project without naming one when the entry names no root, and orders same names by path', () => {
    const rows = publishableSkills(
      [
        entry({ name: 'dup', path: '/b/SKILL.md' }),
        entry({ name: 'dup', path: '/a/SKILL.md' }),
        entry({ name: 'loose', scope: 'project', path: '/work/loose/SKILL.md' }),
      ],
      catalog,
      '',
    );
    expect(rows.map(row => row.path)).toEqual(['/a/SKILL.md', '/b/SKILL.md', '/work/loose/SKILL.md']);
    expect(rows.at(-1)?.where).toBe('a project');
  });

  it('searches the name, the description and where it lives', () => {
    const entries = [entry({ name: 'pdf-tools' }), entry({ name: 'lint', scope: 'ferretry' })];
    expect(publishableSkills(entries, catalog, 'PDF').map(row => row.name)).toEqual(['pdf-tools']);
    expect(publishableSkills(entries, catalog, 'what lint').map(row => row.name)).toEqual(['lint']);
    expect(publishableSkills(entries, catalog, 'ferretry').map(row => row.name)).toEqual(['lint']);
    expect(publishableSkills(entries, catalog, 'nothing like it')).toEqual([]);
  });
});
