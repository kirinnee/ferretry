import type { FencedPath } from '@ferretry/kernel/contract';
import type { HarnessKey, LaunchPart } from '@ferretry/core-ferrets/contract';
import type { SkillsItem } from '../../contract/index.ts';

/** Where a skill folder named by an item lives, fenced; `undefined` when the store does not hold it. */
export type SkillFolderResolver = (name: string) => FencedPath | undefined;

/**
 * The `launch.parts` a launch gets from `config/skills/*.yaml` (§4.9): one `skill` part per folder an item names, for
 * the harnesses the item allows (all of them when it names none). Inert: a part is a name and a fenced path. A folder
 * the store does not hold contributes nothing (the item names it before it is installed).
 */
export function skillParts(
  items: ReadonlyMap<string, SkillsItem>,
  harness: HarnessKey,
  resolve: SkillFolderResolver,
): readonly LaunchPart[] {
  const parts: LaunchPart[] = [];
  const seen = new Set<string>();
  for (const [, item] of [...items].sort(([left], [right]) => left.localeCompare(right))) {
    if (item.harness !== undefined && item.harness !== harness) continue;
    for (const name of item.items) {
      if (seen.has(name)) continue;
      const path = resolve(name);
      if (path === undefined) continue;
      seen.add(name);
      parts.push({ kind: 'skill', name, path });
    }
  }
  return parts;
}
