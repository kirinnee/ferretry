/**
 * U4b part 4a (skills): Skills reads a harness through its own layout table and refuses one it has no row for, instead
 * of reading it as Claude or Codex. `fake-third` is a harness key the table has no row for.
 */
import { describe, expect, it } from 'bun:test';
import { skillsCatalogRuntime } from '../../daemon/lib/catalog-runtime.ts';
import {
  FerretSkillsInventorySchema,
  isSkillsAddSlotProps,
  isSkillsHarnessKey,
  SkillEntrySchema,
  SkillsHarnessKeySchema,
  skillsHarnessKeys,
  skillsHarnessOf,
  skillsLayout,
  SkillsItemSchema,
  UnsupportedSkillsHarnessError,
} from '../../contract/index.ts';
import { skillHarnessLabel, skillInsertText } from '../../app/lib/skills-model.ts';
import { SkillsInventoryService } from '../../daemon/lib/inventory.ts';

const THIRD = 'fake-third';

describe('the harnesses Skills has a layout for', () => {
  it('should keep exactly the words and folders the two shipped harnesses had', () => {
    expect(skillsHarnessKeys()).toEqual(['claude-code', 'codex']);
    expect(skillInsertText('claude-code', 'review')).toBe('/review');
    expect(skillInsertText('codex', 'review')).toBe('$review');
    expect(skillHarnessLabel('claude-code')).toBe('Claude · inserts /name');
    expect(skillHarnessLabel('codex')).toBe('Codex · inserts $name');
    expect(skillsLayout('claude-code')).toMatchObject({ projectFolder: '.claude', homeShadowsProject: true });
    expect(skillsLayout('codex')).toMatchObject({ projectFolder: '.agents', homeShadowsProject: false });
  });

  it('should refuse a harness it has no row for, naming it, and never answer it with another harness', () => {
    expect(isSkillsHarnessKey(THIRD)).toBe(false);
    expect(isSkillsHarnessKey('__proto__')).toBe(false);
    expect(() => skillsHarnessOf(THIRD)).toThrow(UnsupportedSkillsHarnessError);
    expect(() => skillsHarnessOf(THIRD)).toThrow(/fake-third/u);
    expect(skillsHarnessOf('codex')).toBe('codex');
  });

  it('should not parse a skills document that names a harness it has no row for', () => {
    const entry = {
      name: 'review',
      description: 'd',
      harness: THIRD,
      scope: 'user',
      path: '/s/SKILL.md',
      runtimes: [],
    };
    expect(SkillEntrySchema.safeParse({ ...entry, harness: 'codex' }).success).toBe(true);
    expect(SkillEntrySchema.safeParse(entry).success).toBe(false);
    expect(SkillsHarnessKeySchema.safeParse(THIRD).success).toBe(false);
    expect(
      FerretSkillsInventorySchema.safeParse({
        ferretId: 'f',
        harness: THIRD,
        folder: '/w',
        skills: [],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(SkillsItemSchema.safeParse({ items: ['a'], harness: THIRD }).success).toBe(false);
    expect(SkillsItemSchema.safeParse({ items: ['a'], harness: 'codex' }).success).toBe(true);
  });

  it('should offer no add-skills panel to a ferret on such a harness', () => {
    const props = { ferret: 'f1', folder: '/work', scopes: [] as string[] };
    expect(isSkillsAddSlotProps({ ...props, harness: 'codex' })).toBe(true);
    expect(isSkillsAddSlotProps({ ...props, harness: THIRD })).toBe(false);
  });

  it('should list a project once per harness it has a layout for, each in its own folder, with the shadowing each reads', async () => {
    // Arrange
    const listed: string[] = [];
    const service = new SkillsInventoryService({
      files: {
        list: async directory => {
          listed.push(directory);
          return [];
        },
        read: async () => undefined,
      },
      homes: async () => [],
      projects: async () => [{ id: 'p', name: 'app', path: '/work/app' }],
    });

    // Act
    await service.machine();

    // Assert
    expect(listed).toEqual(['/work/app/.claude/skills', '/work/app/.agents/skills']);
  });
});

describe('the runtimes a catalog skill can be installed into', () => {
  it('should name a runtime on a harness Skills has no row for by its own key, never as claude', async () => {
    // Arrange
    const runtimes = {
      list: async () => [
        { id: 'a', profile: 'work', harness: 'claude-code' },
        { id: 'b', profile: 'work', harness: 'codex' },
        { id: 'c', profile: 'work', harness: THIRD },
      ],
    };
    const installer = skillsCatalogRuntime({ runtimes: () => runtimes as never, items: () => new Map() } as never);

    // Act
    const listed = await installer.runtimes();

    // Assert
    expect(listed.runtimes.map(runtime => `${runtime.id}:${runtime.harness}`)).toEqual([
      'a:claude',
      'b:codex',
      `c:${THIRD}`,
    ]);
  });
});
