import type { HookDecision } from '@ferretry/kernel/contract';
import type { PackConfig } from '../../contract/index.ts';
import { admitChild, type PackLaunchFacts, packLaunchDefault, type ParentFacts } from './admission.ts';

/**
 * Whose limits a `start.decide` is judged against: the parent of a START. A resume relaunches a ferret that was
 * already admitted, so it is not limited again (today: `pack.admit` ran on the start path only, `fyd.ts:2643`; the
 * resume services never asked it). Packs still ANSWERS a resume, and that answer is the child's admission (RULING #43).
 */
export function limitedParent(input: {
  readonly parent?: string | undefined;
  readonly by: string;
}): string | undefined {
  return input.by === 'resume' ? undefined : input.parent;
}

/**
 * `start.decide`: a child's depth and how many its parent may have, whichever command started it. A start with no
 * parent, or whose parent is not known here, is not Pack mode's to refuse.
 */
export function startDecision(parent: ParentFacts | undefined, limits: PackConfig['limits']): HookDecision {
  if (parent === undefined) return { allow: true };
  const refusal = admitChild(parent, limits);
  if (refusal === undefined) return { allow: true };
  return { allow: false, reason: `${refusal.message}${refusal.remedy === undefined ? '' : ` ${refusal.remedy}`}` };
}

/**
 * `launch.parts`: what a ferret is TOLD about Pack mode at this launch. `FY_PACK` is always set; the routing line is
 * derived (and kept per configuration) only for a ferret that is told.
 */
export async function launchEnvironment(
  config: PackConfig,
  facts: PackLaunchFacts,
  routingLine: () => Promise<string>,
): Promise<Readonly<Record<string, string>>> {
  const flag = packLaunchDefault(config, facts);
  return flag === '1' ? { FY_PACK: flag, FY_PACK_ROUTING: await routingLine() } : { FY_PACK: flag };
}
