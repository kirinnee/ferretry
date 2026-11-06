import { describe, expect, it } from 'bun:test';
import type { AvailableSkill } from '@ferretry/protocol';

import {
  appendSkillInvocation,
  filterSkills,
  skillBadgeLabel,
  skillHarnessLabel,
  skillInsertText,
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

describe('skillBadgeLabel', () => {
  it('spells out every origin the protocol can report', () => {
    expect(skillBadgeLabel('claude')).toBe('Available for Claude');
    expect(skillBadgeLabel('codex')).toBe('Available for Codex');
    expect(skillBadgeLabel('both')).toBe('Available for Claude and Codex');
    expect(skillBadgeLabel('unknown')).toBe('Skill origin is unknown');
  });
});
