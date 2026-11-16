import type { SharedTree } from '@ferretry/kernel/contract';
import type { HarnessKey, LaunchPart } from '@ferretry/core-ferrets/contract';
import type { SkillsItem } from '../../contract/index.ts';

/** The shared folder of a skill named by an item, minted for this launch; `undefined` when the store does not hold it. */
export type SkillTreeResolver = (name: string) => Promise<SharedTree | undefined>;

/**
 * The `launch.parts` a launch gets from `config/skills/*.yaml` (§4.9): one `skill` part per folder an item names, for
 * the harnesses the item allows (all of them when it names none), and only for an item the launching runtime's profile
 * stack selects (`selected`, the item names `RuntimesApi.layers(runtime).skills` gives): an item no profile of this
 * runtime names is not handed to it. Inert: a part is a name and a shared folder, and the harness that receives it
 * decides nothing about where it came from. A folder the store does not hold contributes nothing (the item names it
 * before it is installed).
 */
export async function skillParts(
  items: ReadonlyMap<string, SkillsItem>,
  harness: HarnessKey,
  resolve: SkillTreeResolver,
  selected: ReadonlySet<string>,
): Promise<readonly LaunchPart[]> {
  const parts: LaunchPart[] = [];
  const seen = new Set<string>();
  for (const [name, item] of [...items].sort(([left], [right]) => left.localeCompare(right))) {
    if (!selected.has(name)) continue;
    if (item.harness !== undefined && item.harness !== harness) continue;
    for (const name of item.items) {
      if (seen.has(name)) continue;
      const tree = await resolve(name);
      if (tree === undefined) continue;
      seen.add(name);
      parts.push({ kind: 'skill', name, tree });
    }
  }
  return parts;
}
