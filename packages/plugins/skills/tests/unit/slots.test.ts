import { describe, expect, it } from 'bun:test';
import { isSkillsAddSlotProps, SKILLS_ADD_SLOT, SKILLS_SLOTS } from '../../contract/index.ts';

describe('the slot Skills offers', () => {
  it('is named in `<plugin>.<name>` form and listed', () => {
    expect(SKILLS_ADD_SLOT).toBe('skills.add');
    expect([...SKILLS_SLOTS]).toEqual([SKILLS_ADD_SLOT]);
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
