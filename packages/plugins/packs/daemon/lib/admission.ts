/**
 * WHO MAY START A HELPER (docs/pack-mode.md): the limits a parent is held to, decided by the
 * daemon for every start that names a parent — `fy new`, and a plain `fy start` from inside a pane.
 *
 * - Depth: a top-level ferret is depth 0 and its helper 1. A start whose child would be deeper
 *   than `maxDepth` is refused, so with the default 2 a helper may start its own and those may not.
 * - Width: an INTERACTIVE parent (a person at it) may have `interactiveChildren` running at once, an
 *   unattended one `autoChildren`. A child counts while it is not finished.
 *
 * The machine's Pack switch does not gate a plain start: it decides what ferrets are TOLD, and whether
 * `fy new` serves them. The limits hold either way, because a runaway fan-out costs the same whichever
 * command made it.
 *
 * Pure: the facts in, a refusal or nothing out.
 */
import type { PackConfig, PackRefusal } from '../../contract/index.ts';

/** What admission needs to know about the parent. */
export interface ParentFacts {
  readonly id: string;
  readonly interactive: boolean;
  /** 0 for a top-level ferret. */
  readonly depth: number;
  /** Its children that have not finished. */
  readonly runningChildren: number;
}

/** The ferret state a child is over in, and so stops counting against its parent's width. */
export const PACK_CHILD_FINISHED_STATES: ReadonlySet<string> = new Set(['stopped']);

/** One ferret as width counting reads it. */
export interface PackChild {
  readonly parent?: string | undefined;
  readonly state: string;
}

/**
 * How many of `parentId`'s children are not finished — {@link ParentFacts.runningChildren}.
 *
 * Every non-finished state counts, `starting` included: a start in flight will be a running child a
 * moment later.
 */
export function runningChildCount(parentId: string, children: readonly PackChild[]): number {
  return children.filter(child => child.parent === parentId && !PACK_CHILD_FINISHED_STATES.has(child.state)).length;
}

/** Why `parent` may not start another helper, or `undefined` when it may. */
export function admitChild(parent: ParentFacts, limits: PackConfig['limits']): PackRefusal | undefined {
  if (parent.depth + 1 > limits.maxDepth)
    return {
      code: 'depth_exceeded',
      message: `${parent.id} is ${String(parent.depth)} level${parent.depth === 1 ? '' : 's'} deep; helpers may nest ${String(limits.maxDepth)} deep, so it may not start its own.`,
      remedy: 'Do this part yourself.',
    };
  const limit = parent.interactive ? limits.interactiveChildren : limits.autoChildren;
  if (parent.runningChildren >= limit)
    return {
      code: 'limit_reached',
      message: `${parent.id} already has ${String(parent.runningChildren)} running helper${parent.runningChildren === 1 ? '' : 's'}, the most ${parent.interactive ? 'an interactive' : 'an unattended'} ferret may have (${String(limit)}).`,
      remedy: 'Wait for one to finish (`wait <id>`), stop one, or do this part yourself.',
    };
  return undefined;
}

/**
 * Whether a ferret at `depth` is told about Pack mode: the machine's switch and its own are on, and it
 * may start a helper at all — a ferret at the deepest level is never told about a door it cannot open.
 */
export function packInstructed(config: PackConfig, ownSwitch: boolean | undefined, depth: number): boolean {
  return config.enabled && (ownSwitch ?? true) && depth + 1 <= config.limits.maxDepth;
}

/** A ferret in the parent chain, as {@link depthOf} walks it. */
export interface Lineage {
  readonly parent?: string | undefined;
}

/**
 * How deep a ferret sits: the number of parents above it. A chain that loops or names a ferret that
 * is gone stops there — a missing ancestor cannot make a ferret shallower than what was found, and a
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

/** What deciding one ferret's Pack instruction at launch needs, read from its own record. */
export interface PackLaunchFacts {
  /** False for a learning miner or a warden's descendant, which are never told. */
  readonly eligible: boolean;
  /** `config.pack`; absent means on. */
  readonly ownSwitch: boolean | undefined;
  readonly depth: number;
}

/**
 * The `FY_PACK` a launch is handed when Pack mode has recorded nothing for this ferret: what its record says
 * (its own switch absent = on), the machine's switch and its depth. A value the store DOES hold still wins: it is
 * the owner's switch, or the start's own decision.
 */
export function packLaunchDefault(config: PackConfig, facts: PackLaunchFacts): '1' | '0' {
  return facts.eligible && packInstructed(config, facts.ownSwitch, facts.depth) ? '1' : '0';
}
