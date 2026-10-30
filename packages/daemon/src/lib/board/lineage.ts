import type { SessionParents } from './ports.ts';

/** Deeper than any real Pack tree; a bound so a damaged chain can never walk forever. */
export const MAX_LINEAGE_DEPTH = 64;

/**
 * The sessions above `sessionId`, nearest first, walked up `config.parent` (the same direction the
 * daemon's only other lineage walk takes, `session/provenance/lineage.ts`). A parent that resolves
 * nowhere ends the walk: unknown ancestry grants nothing. A loop ends it at the first repeat.
 */
export const ancestorsOf = async (sessionId: string, parents: SessionParents): Promise<readonly string[]> => {
  const seen = new Set<string>([sessionId]);
  const ancestors: string[] = [];
  let current = sessionId;
  while (ancestors.length < MAX_LINEAGE_DEPTH) {
    const parent = await parents.parentOf(current);
    if (parent === undefined || seen.has(parent)) break;
    seen.add(parent);
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
};
