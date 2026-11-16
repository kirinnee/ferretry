/**
 * What My catalogs' Publish skills picker lists (&B131 A3): every skill on this machine once, by its SKILL.md path,
 * with where it lives and whether the open catalog already holds it. Pure functions; the sheet only draws them.
 */

import type { OwnedCatalog } from '../../../contract/wire/index.ts';
import type { SkillEntry } from '../../lib/machine-skills.ts';
import { matchesQuery } from '@ferretry/app/ui';
import { ownedMatches, ownedVersion, versionChip } from './catalog-row-model.ts';

/** One skill the picker offers. */
export interface PublishableSkill {
  readonly name: string;
  readonly description: string;
  /** The SKILL.md path, which is what publishing names. */
  readonly path: string;
  /** "account claude-work", "project app" or "Ferretry". */
  readonly where: string;
  /** "In this catalog · v3" when the catalog already holds it, else `null`. */
  readonly held: string | null;
}

const lastSegment = (path: string): string =>
  path
    .split(/[\\/]/u)
    .filter(part => part !== '')
    .at(-1) ?? path;

/** Where a skill lives, in words a person recognises. */
function skillWhere(entry: SkillEntry): string {
  if (entry.scope === 'ferretry') return 'Ferretry';
  if (entry.scope === 'project')
    return entry.project === undefined ? 'a project' : `project ${lastSegment(entry.project.root)}`;
  const [runtime] = entry.runtimes;
  return runtime === undefined ? 'this machine' : `account ${runtime}`;
}

/** The catalog's hold on a skill, said once: "In this catalog · v3", or `null` when it does not hold it. */
function heldLine(catalog: OwnedCatalog, path: string): string | null {
  const version = ownedVersion(ownedMatches([catalog], { kind: 'skill', skill: path }));
  return version === null ? null : `In this catalog · ${versionChip(version)}`;
}

/**
 * The picker's rows: one per SKILL.md path (the same skill folder can be seen by several accounts), matching the
 * search on name, description and where it lives, sorted by name.
 */
export function publishableSkills(
  entries: readonly SkillEntry[],
  catalog: OwnedCatalog,
  query: string,
): readonly PublishableSkill[] {
  const byPath = new Map<string, PublishableSkill>();
  for (const entry of entries) {
    if (byPath.has(entry.path)) continue;
    const where = skillWhere(entry);
    if (!matchesQuery(query, entry.name, entry.description, where)) continue;
    byPath.set(entry.path, {
      name: entry.name,
      description: entry.description,
      path: entry.path,
      where,
      held: heldLine(catalog, entry.path),
    });
  }
  return [...byPath.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.path.localeCompare(right.path),
  );
}
