import { describe, expect, it } from 'bun:test';
import {
  isSkillsAddSlotProps,
  isSkillsRowSlotProps,
  SKILLS_ADD_SLOT,
  SKILLS_ROW_SLOT,
  SKILLS_SLOTS,
} from '../../contract/index.ts';

describe('the slots Skills offers', () => {
  it('are named in `<plugin>.<name>` form and listed', () => {
    expect(SKILLS_ADD_SLOT).toBe('skills.add');
    expect(SKILLS_ROW_SLOT).toBe('skills.row');
    expect([...SKILLS_SLOTS]).toEqual([SKILLS_ADD_SLOT, SKILLS_ROW_SLOT]);
  });

  it('a row panel accepts the one skill the row hands it and refuses anything short of it', () => {
    const props = {
      ferret: 'f1',
      name: 'review',
      invocation: '/review',
      path: '/s/review/SKILL.md',
      scope: 'user',
      runtimes: ['claude-default'],
    };
    expect(isSkillsRowSlotProps(props)).toBe(true);
    expect(isSkillsRowSlotProps({ ...props, runtimes: [] })).toBe(true);
    expect(isSkillsRowSlotProps({ ...props, runtimes: [1] })).toBe(false);
    for (const key of Object.keys(props)) expect(isSkillsRowSlotProps({ ...props, [key]: 3 })).toBe(false);
    expect(isSkillsRowSlotProps({ ferret: 'f1' })).toBe(false);
    expect(isSkillsRowSlotProps(null)).toBe(false);
  });

  it('a panel accepts the props the Skills tab hands it and refuses anything short of them', () => {
    const props = { ferret: 'f1', folder: '/work', harness: 'claude-code', scopes: ['user'] };
    expect(isSkillsAddSlotProps(props)).toBe(true);
    expect(isSkillsAddSlotProps({ ...props, runtime: 'box', harness: 'codex' })).toBe(true);
    expect(isSkillsAddSlotProps({ ...props, runtime: 3 })).toBe(false);
    expect(isSkillsAddSlotProps({ ...props, harness: 'other' })).toBe(false);
    expect(isSkillsAddSlotProps({ ...props, scopes: [1] })).toBe(false);
    expect(isSkillsAddSlotProps({ ...props, scopes: 'user' })).toBe(false);
    expect(isSkillsAddSlotProps({ ferret: 'f1' })).toBe(false);
    expect(isSkillsAddSlotProps(null)).toBe(false);
  });
});
