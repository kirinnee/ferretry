import { describe, expect, it } from 'bun:test';
import type { AvailableSkill } from '@ferretry/protocol';

import {
  appendSkillInvocation,
  filterSkills,
  groupSkills,
  insertSkillIntoDraft,
  skillBadgeLabel,
  skillHarnessLabel,
  skillInsertText,
  skillsEmptyCopy,
  visibleSkillCount,
} from '../../../src/features/skills/skills-catalog.ts';

const skill = (overrides: Partial<AvailableSkill> & Pick<AvailableSkill, 'name'>): AvailableSkill => ({
  description: 'Does a useful thing.',
  scope: 'global',
  origin: 'claude',
  ...overrides,
});

const catalogSkills: AvailableSkill[] = [
  skill({ name: 'kteam', description: 'Coordinate detached teammates.' }),
  skill({ name: 'summary', description: 'Recap the current work.', origin: 'both' }),
  skill({ name: 'run', description: 'Launch the project app.', scope: 'project', origin: 'codex' }),
  skill({ name: 'floop', description: 'Review a diff until reviewers agree.', scope: 'project', origin: 'unknown' }),
];

describe('skillInsertText', () => {
  it('inserts the Claude slash form and the Codex dollar form', () => {
    expect(skillInsertText('claude', 'summary')).toBe('/summary');
    expect(skillInsertText('codex', 'summary')).toBe('$summary');
  });
});

describe('skillHarnessLabel', () => {
  it('names the harness and what it will insert', () => {
    expect(skillHarnessLabel('claude')).toBe('Claude · inserts /name');
    expect(skillHarnessLabel('codex')).toBe('Codex · inserts $name');
  });
});

describe('appendSkillInvocation', () => {
  it('is the only token when the draft is empty or whitespace', () => {
    expect(appendSkillInvocation('', '/summary')).toBe('/summary ');
    expect(appendSkillInvocation('   \n ', '/summary')).toBe('/summary ');
  });

  it('preserves real content and does not double a trailing space', () => {
    expect(appendSkillInvocation('ship it', '/summary')).toBe('ship it /summary ');
    expect(appendSkillInvocation('ship it ', '/summary')).toBe('ship it /summary ');
    expect(appendSkillInvocation('ship it\n', '/summary')).toBe('ship it\n/summary ');
  });
});

describe('filterSkills', () => {
  it('returns a copy of everything for an empty or whitespace query', () => {
    const all = filterSkills(catalogSkills, '  ');
    expect(all).toHaveLength(4);
    expect(all).not.toBe(catalogSkills);
  });

  it('matches name and description case-insensitively', () => {
    expect(filterSkills(catalogSkills, 'TEAMMATES').map(item => item.name)).toEqual(['kteam']);
    expect(filterSkills(catalogSkills, 'run').map(item => item.name)).toEqual(['run']);
    expect(filterSkills(catalogSkills, 'nothing here')).toEqual([]);
  });
});

describe('groupSkills', () => {
  it('always answers global first and project second, filtered by the query', () => {
    const groups = groupSkills(catalogSkills, '');
    expect(groups.map(group => group.scope)).toEqual(['global', 'project']);
    expect(groups.map(group => group.label)).toEqual(['Global', 'Project']);
    expect(groups[0]?.skills.map(item => item.name)).toEqual(['kteam', 'summary']);
    expect(groups[1]?.skills.map(item => item.name)).toEqual(['run', 'floop']);
  });

  it('keeps an empty group rather than reordering the survivors', () => {
    const groups = groupSkills(catalogSkills, 'diff');
    expect(groups[0]?.skills).toEqual([]);
    expect(groups[1]?.skills.map(item => item.name)).toEqual(['floop']);
  });
});

describe('skillBadgeLabel', () => {
  it('spells out every origin the protocol can report', () => {
    expect(skillBadgeLabel('claude')).toBe('Available for Claude');
    expect(skillBadgeLabel('codex')).toBe('Available for Codex');
    expect(skillBadgeLabel('both')).toBe('Available for Claude and Codex');
    expect(skillBadgeLabel('unknown')).toBe('Skill origin is unknown');
  });
});

describe('skillsEmptyCopy', () => {
  it('distinguishes a filtered-out catalog from an empty one', () => {
    expect(skillsEmptyCopy(' kubernetes ', 4)).toBe('No skills match “kubernetes”.');
    expect(skillsEmptyCopy('kubernetes', 0)).toBe('No skills are installed for this session.');
    expect(skillsEmptyCopy('', 0)).toBe('No skills are installed for this session.');
  });
});

describe('visibleSkillCount', () => {
  it('counts the survivors of the active search', () => {
    expect(visibleSkillCount({ harness: 'claude', skills: catalogSkills }, '')).toBe(4);
    expect(visibleSkillCount({ harness: 'claude', skills: catalogSkills }, 'diff')).toBe(1);
  });
});

describe('insertSkillIntoDraft', () => {
  it('hands the harness-correct invocation to the callback and returns it', () => {
    const seen: string[] = [];
    expect(insertSkillIntoDraft(value => seen.push(value), 'codex', 'run')).toBe('$run');
    expect(seen).toEqual(['$run']);
  });
});
