import type { AvailableSkill, FerretSkills, FerretSkillsInventory } from '../../contract/index.ts';

/**
 * The composer's `/` and `$` list (today's `NodeCatalog.skills`): the home's skills as `global`, the working folder's
 * as `project`, a project skill replacing a global one of the same name, sorted by name. Derived from the inventory a
 * ferret sees, so the two can never disagree.
 */
export function composerSkills(inventory: FerretSkillsInventory): FerretSkills {
  const merged = new Map<string, AvailableSkill>();
  const entries = [...inventory.skills].sort(
    (left, right) => Number(left.scope === 'project') - Number(right.scope === 'project'),
  );
  for (const skill of entries)
    merged.set(skill.name, {
      name: skill.name,
      description: skill.description,
      scope: skill.scope === 'project' ? 'project' : 'global',
      origin: inventory.harness,
    });
  return {
    harness: inventory.harness,
    skills: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}
