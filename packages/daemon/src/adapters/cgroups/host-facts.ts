import { existsSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import type { CgroupHostFacts } from '../../lib/cgroups/index.ts';

/**
 * The controllers file the unified hierarchy roots itself at. Its PRESENCE is the whole test: a host
 * on the legacy hierarchy does not have it, and neither does a host with no cgroup filesystem at
 * all, which are the two cases this daemon must decline rather than write properties for.
 */
export const UNIFIED_HIERARCHY_MARKER = '/sys/fs/cgroup/cgroup.controllers';

/**
 * What the machine this daemon is running on can do, measured once.
 *
 * MEASURED ONCE ON PURPOSE. A host does not grow CPUs while a daemon runs, and reading the values
 * per request would let two derivations of the same percentage disagree — the effective limit the
 * surface displays and the property a launch writes have to be the same number.
 *
 * `availableParallelism` rather than the raw CPU count: it honours the affinity mask this daemon was
 * actually started with, so a daemon confined to four cores does not offer an operator a ceiling of
 * sixteen.
 */
export function hostCgroupFacts(
  now: { readonly platform: string; readonly cpus: number; readonly memoryBytes: number } = {
    platform: process.platform,
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
  },
  unifiedHierarchy: boolean = existsSync(UNIFIED_HIERARCHY_MARKER),
): CgroupHostFacts {
  return {
    platform: now.platform,
    unifiedHierarchy,
    // Floors at one so a host that reports something unusable cannot produce a limit of zero, which
    // would be a cap nothing can run inside rather than the absence of one.
    cpus: Math.max(1, Math.floor(now.cpus)),
    memoryBytes: Math.max(1, Math.floor(now.memoryBytes)),
  };
}
