import { describe, expect, test } from 'bun:test';
import { LocalSkillSourceSchema, SkillsItemSchema } from '../../contract/index.ts';
import { fakeSkills, skillsConformance } from '../../contract/testing/index.ts';
import manifest from '../../manifest.ts';

const route = (key: string) => manifest.actions.routes.find(candidate => candidate.key === key);
const demand = (key: string) => `${String(route(key)?.capability?.capability)}.${route(key)?.capability?.axis}`;
const COPY = manifest.actions.routes.filter(candidate => candidate.path.startsWith('/v1/skill-installs/local'));

describe('skills contract', () => {
  test('the fake passes the conformance suite', async () => {
    expect((await skillsConformance(fakeSkills)).ok).toBe(true);
  });

  test('the manifest declares 11 routes, 8 verbs, 2 reference renderers and takes launch.parts', () => {
    expect(manifest.actions.routes.length).toBe(11);
    expect(manifest.actions.cli.length).toBe(8);
    expect(manifest.ui.renderers.map(entry => entry.key)).toEqual(['reference:/', 'reference:$']);
    expect(manifest.hooks.takes.map(take => take.hook.name)).toEqual(['launch.parts']);
  });

  test('G172 (declaration only) both previews are filesystem.use', () => {
    expect(demand('POST /v1/skill-installs/local/project/preview')).toBe('filesystem.use');
    expect(demand('POST /v1/skill-installs/local/runtime/preview')).toBe('filesystem.use');
  });

  test('G173 (declaration only) a project apply or remove is filesystem.configure, a runtime one fleet.configure', () => {
    expect(demand('POST /v1/skill-installs/local/project')).toBe('filesystem.configure');
    expect(demand('DELETE /v1/skill-installs/local/project/:installId')).toBe('filesystem.configure');
    expect(demand('POST /v1/skill-installs/local/runtime')).toBe('fleet.configure');
    expect(demand('DELETE /v1/skill-installs/local/runtime/:installId')).toBe('fleet.configure');
  });

  test('G174 (declaration only) every copy route is a person act, so a ferret is refused all of them', () => {
    expect(COPY.length).toBe(7);
    for (const candidate of COPY) expect(candidate.caller).toBe('person');
  });

  test('G175 (declaration only) the copy source is a path the inventory lists, never a body field of its own', () => {
    expect(LocalSkillSourceSchema.safeParse({ path: '/home/x/SKILL.md' }).success).toBe(true);
    expect(LocalSkillSourceSchema.safeParse({ path: 'relative/SKILL.md' }).success).toBe(false);
    expect(LocalSkillSourceSchema.safeParse({ path: '/a/SKILL.md', files: [] }).success).toBe(false);
  });

  test('a skills item lists each folder once', () => {
    expect(SkillsItemSchema.safeParse({ items: ['a', 'b'] }).success).toBe(true);
    expect(SkillsItemSchema.safeParse({ items: ['a', 'a'] }).success).toBe(false);
    expect(SkillsItemSchema.safeParse({ items: ['../x'] }).success).toBe(false);
  });
});
