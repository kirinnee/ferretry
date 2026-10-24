import { describe, it } from 'bun:test';
import should from 'should';
import { MachineSkillsInventorySchema, SkillEntrySchema, SkillScopeSchema } from '../../src/lib/skills-inventory.ts';

const ENTRY = {
  name: 'review',
  description: 'reviews',
  harness: 'claude',
  scope: 'ferretry',
  path: '/fy/fleet/homes/a/skills/review/SKILL.md',
  runtimes: ['claude-a'],
};

describe('the skills inventory wire shapes', () => {
  it('accepts an entry with only the required fields and a toggle that says why it is off', () => {
    should(SkillEntrySchema.safeParse(ENTRY).success).be.true();
    should(
      SkillEntrySchema.safeParse({ ...ENTRY, toggle: { supported: false, enabled: true, reason: 'profile' } }).success,
    ).be.true();
  });

  it('refuses an unknown scope and an entry without a path', () => {
    should(SkillScopeSchema.safeParse('global').success).be.false();
    should(SkillEntrySchema.safeParse({ ...ENTRY, path: undefined }).success).be.false();
  });

  it('parses a machine listing', () => {
    const parsed = MachineSkillsInventorySchema.parse({
      homes: [{ runtime: 'claude-a', harness: 'claude', home: '/h', skills: [ENTRY] }],
      projects: [{ name: 'P', root: '/p', skills: [] }],
      truncated: false,
    });
    should(parsed.homes[0]!.skills).have.length(1);
  });
});
