/** One step of lineage: the ferret that started this one. */
export interface FerretParents {
  parentOf(ferretId: string): Promise<string | undefined>;
}

/** Deeper than any real Pack tree; a bound so a damaged chain can never walk forever. */
const MAX_LINEAGE_DEPTH = 64;

/**
 * The ferrets above `ferretId`, nearest first, walked up the parent. A parent that resolves nowhere ends the walk:
 * unknown ancestry grants nothing. A loop ends it at the first repeat.
 */
export const ancestorsOf = async (ferretId: string, parents: FerretParents): Promise<readonly string[]> => {
  const seen = new Set<string>([ferretId]);
  const ancestors: string[] = [];
  let current = ferretId;
  while (ancestors.length < MAX_LINEAGE_DEPTH) {
    const parent = await parents.parentOf(current);
    if (parent === undefined || seen.has(parent)) break;
    seen.add(parent);
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
};
