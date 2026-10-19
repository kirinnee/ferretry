/**
 * WHO MAY START A SUB-FERRET (docs/pack-mode.md): the limits a parent is held to, decided by the
 * daemon for every start that names a parent — `fy new`, and a plain `fy start` from inside a pane.
 *
 * - Depth: a top-level ferret is depth 0 and its sub-ferret 1. A start whose child would be deeper
 *   than `maxDepth` is refused, so with the default 2 a sub-ferret may start its own and those may not.
 * - Width: an INTERACTIVE parent (a person at it) may have `interactiveChildren` running at once, an
 *   unattended one `autoChildren`. A child counts while it is not finished.
 *
 * The machine's Pack switch does not gate a plain start: it decides what ferrets are TOLD, and whether
 * `fy new` serves them. The limits hold either way, because a runaway fan-out costs the same whichever
 * command made it.
 *
 * Pure: the facts in, a refusal or nothing out.
 */
import type { PackConfig, PackRefusal } from '@ferretry/protocol';

/** What admission needs to know about the parent. */
export interface ParentFacts {
  readonly id: string;
  readonly interactive: boolean;
  /** 0 for a top-level ferret. */
  readonly depth: number;
  /** Its children that have not finished. */
  readonly runningChildren: number;
}

/** Why `parent` may not start another sub-ferret, or `undefined` when it may. */
export function admitChild(parent: ParentFacts, limits: PackConfig['limits']): PackRefusal | undefined {
  if (parent.depth + 1 > limits.maxDepth)
    return {
      code: 'depth_exceeded',
      message: `${parent.id} is ${String(parent.depth)} level${parent.depth === 1 ? '' : 's'} deep; sub-ferrets may nest ${String(limits.maxDepth)} deep, so it may not start its own.`,
      remedy: 'Do this part yourself.',
    };
  const limit = parent.interactive ? limits.interactiveChildren : limits.autoChildren;
  if (parent.runningChildren >= limit)
    return {
      code: 'limit_reached',
      message: `${parent.id} already has ${String(parent.runningChildren)} running sub-ferret${parent.runningChildren === 1 ? '' : 's'}, the most ${parent.interactive ? 'an interactive' : 'an unattended'} ferret may have (${String(limit)}).`,
      remedy: 'Wait for one to finish (`wait <id>`), stop one, or do this part yourself.',
    };
  return undefined;
}

/**
 * Whether a ferret at `depth` is told about Pack mode: the machine's switch and its own are on, and it
 * may start a sub-ferret at all — a ferret at the deepest level is never told about a door it cannot open.
 */
export function packInstructed(config: PackConfig, ownSwitch: boolean | undefined, depth: number): boolean {
  return config.enabled && (ownSwitch ?? true) && depth + 1 <= config.limits.maxDepth;
}

/** A session in the parent chain, as {@link depthOf} walks it. */
export interface Lineage {
  readonly parent?: string | undefined;
}

/**
 * How deep a session sits: the number of parents above it. A chain that loops or names a session that
 * is gone stops there — a missing ancestor cannot make a session shallower than what was found, and a
 * loop cannot make the walk run forever.
 */
export async function depthOf(
  id: string,
  read: (id: string) => Promise<Lineage | undefined>,
  ceiling = 16,
): Promise<number> {
  const seen = new Set<string>([id]);
  let depth = 0;
  let current = await read(id);
  while (current?.parent !== undefined && !seen.has(current.parent) && depth < ceiling) {
    seen.add(current.parent);
    depth += 1;
    current = await read(current.parent);
  }
  return depth;
}
