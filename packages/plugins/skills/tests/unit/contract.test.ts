import { describe, expect, test } from 'bun:test';
import { SkillsItemSchema } from '../../contract/index.ts';
import { fakeSkills, skillsConformance } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

describe('skills contract', () => {
  test('the fake passes the conformance suite', async () => {
    expect((await skillsConformance(fakeSkills)).ok).toBe(true);
  });

  test('the manifest declares 4 routes, 5 verbs, 2 reference renderers and takes launch.parts and reference.catalog for / and $', () => {
    expect(manifest.actions.routes.length).toBe(4);
    expect(manifest.actions.cli.length).toBe(5);
    expect(manifest.ui.renderers.map(entry => entry.key)).toEqual(['reference:/', 'reference:$']);
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual([
      'launch.parts',
      'reference.catalog',
      'reference.catalog',
    ]);
  });

  test('a skills item lists each folder once', () => {
    expect(SkillsItemSchema.safeParse({ items: ['a', 'b'] }).success).toBe(true);
    expect(SkillsItemSchema.safeParse({ items: ['a', 'a'] }).success).toBe(false);
    expect(SkillsItemSchema.safeParse({ items: ['../x'] }).success).toBe(false);
  });
});
