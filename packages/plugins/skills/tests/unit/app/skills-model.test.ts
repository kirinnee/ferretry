import { describe, expect, it } from 'bun:test';
import {
  activeSkillsLine,
  appendSkillInvocation,
  loadedSkillCount,
  referenceScope,
  skillChips,
  skillHarnessLabel,
  skillInsertText,
  skillNameOf,
  skillOverride,
  sortedSkills,
  splitFrontMatter,
  visibleSkills,
} from '../../../app/lib/skills-model.ts';
import { ferretInventory, skill } from './skills-support.ts';

describe('the insertion contract', () => {
  it('inserts /name for Claude and $name for Codex, and says which', () => {
    expect(skillInsertText('claude-code', 'summary')).toBe('/summary');
    expect(skillInsertText('codex', 'summary')).toBe('$summary');
    expect(skillHarnessLabel('codex')).toBe('Codex · inserts $name');
    expect(skillHarnessLabel('claude-code')).toBe('Claude · inserts /name');
  });

  it('appends one invocation as a new token and keeps real content', () => {
    expect(appendSkillInvocation('', '/review')).toBe('/review ');
    expect(appendSkillInvocation('  ', '/review')).toBe('/review ');
    expect(appendSkillInvocation('look at this', '/review')).toBe('look at this /review ');
    expect(appendSkillInvocation('look at this ', '/review')).toBe('look at this /review ');
  });
});

describe('a ferret’s skills list', () => {
  const skills = [
    skill('zeta', { scope: 'user' }),
    skill('alpha', { scope: 'ferretry' }),
    skill('mid', { scope: 'project' }),
    skill('beta', { scope: 'user', shadowedBy: 'project' }),
  ];

  it('lists the winners first — Project, then account, then Ferretry — then by name', () => {
    expect(sortedSkills(skills).map(entry => entry.name)).toEqual(['mid', 'zeta', 'alpha', 'beta']);
  });

  it('breaks a tie of scope by name, ignoring case', () => {
    const tied = [
      skill('Zulu', { scope: 'user' }),
      skill('alpha', { scope: 'user' }),
      skill('Mike', { scope: 'user' }),
    ];
    expect(sortedSkills(tied).map(entry => entry.name)).toEqual(['alpha', 'Mike', 'Zulu']);
  });

  it('says why a shadowed skill is not active, and counts only the ones that load', () => {
    expect(skillOverride(skills[3] as never)).toBe('Not active: the skill of the same name in This project wins');
    expect(skillOverride(skills[0] as never)).toBeUndefined();
    expect(loadedSkillCount(skills)).toBe(3);
  });

  it('offers a scope chip only when the ferret has a skill from it, counted under the search', () => {
    expect(skillChips(skills, '').map(chip => [chip.key, chip.count])).toEqual([
      ['all', 4],
      ['project', 1],
      ['user', 2],
      ['ferretry', 1],
    ]);
    expect(skillChips([skill('only')], '').map(chip => chip.key)).toEqual(['all', 'user']);
    expect(skillChips(skills, 'zeta').find(chip => chip.key === 'user')?.count).toBe(1);
  });

  it('narrows by chip and by every word of name, description or scope', () => {
    expect(visibleSkills(skills, '', 'user').map(entry => entry.name)).toEqual(['zeta', 'beta']);
    expect(visibleSkills(skills, 'THIS PROJECT', 'all').map(entry => entry.name)).toEqual(['mid']);
    expect(visibleSkills(skills, 'does one thing', 'ferretry').map(entry => entry.name)).toEqual(['alpha']);
  });

  it('answers “are these in my system?” in words, with the account and a cut-short list', () => {
    expect(activeSkillsLine(ferretInventory(skills))).toBe(
      '3 active in this ferret · Claude · inserts /name · account claude-default',
    );
    expect(activeSkillsLine(ferretInventory([], { harness: 'codex', truncated: true, runtime: undefined }))).toBe(
      '0 active in this ferret · Codex · inserts $name · the list was cut short',
    );
  });

  it('splits a SKILL.md into its front matter and its document', () => {
    expect(splitFrontMatter('---\nname: a\n---\n# Hi')).toEqual({ frontMatter: 'name: a', body: '# Hi' });
    expect(splitFrontMatter('# Hi')).toEqual({ frontMatter: null, body: '# Hi' });
  });
});

describe('a /name or $name written anywhere', () => {
  it('reads a skill name by the grammar’s own rule: lowercase only, either sigil', () => {
    expect(skillNameOf('/summary')).toBe('summary');
    expect(skillNameOf('$summary')).toBe('summary');
    expect(skillNameOf('summary')).toBeUndefined();
    expect(skillNameOf('/summary.')).toBeUndefined();
    expect(skillNameOf({ name: '/review-2' })).toBe('review-2');
    expect(skillNameOf('$HOME')).toBeUndefined();
    expect(skillNameOf('/Summary')).toBeUndefined();
    expect(skillNameOf('/apps/web:deploy')).toBeUndefined();
    expect(skillNameOf(undefined)).toBeUndefined();
  });

  it('takes the ferret and daemon it was written in from the value, and no more', () => {
    expect(referenceScope('/summary')).toEqual({});
    expect(referenceScope({ name: 'x', ferretId: 'f1', daemon: 'studio', extra: 1 })).toEqual({
      ferretId: 'f1',
      daemon: 'studio',
    });
    expect(referenceScope({ ferretId: '' })).toEqual({});
  });
});
