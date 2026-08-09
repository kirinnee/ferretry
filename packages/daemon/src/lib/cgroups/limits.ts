/**
 * Turning an operator's percentages into the two property values the host manager understands.
 *
 * THE PERCENTAGES ARE SHARES OF THE WHOLE HOST, not of one core. `cpuPercent: 80` on an eight-CPU
 * machine is `CPUQuota=640%`, because that is what "eighty percent of this machine" means and it is
 * the only reading under which the fleet aggregate and the per-agent cap compose. A UI that offered
 * a one-core percentage would let an operator set a fleet ceiling smaller than a single agent's.
 *
 * ONE OWNER FOR THE FORMAT. Every value on the wire, every value written to a unit, and every value
 * a fixture shows comes from this module. The manager takes a percentage STRING for CPU and a
 * decimal BYTE string for memory, and the earlier fixtures carried the unified hierarchy's raw
 * `cpu.max` pair (`"640000 100000"`) instead — two spellings of one fact, only one of which any
 * command would accept. There is one now, and it is this one.
 *
 * Pure: no IO, no clock, no globals.
 */

import type { CgroupConfig, CgroupConfigView, CgroupLimit } from '@ferretry/protocol';
import type { CgroupHostFacts } from './ports.ts';

/** The two properties one unit is given. */
export type CgroupUnitLimits = CgroupConfigView['effective']['fleet'];

/** Everything the view reports about what the saved percentages actually mean on this host. */
export type CgroupEffectiveLimits = CgroupConfigView['effective'];

/**
 * One limit pair, in the manager's own vocabulary.
 *
 * Both floors are at one rather than zero: a rounded-down share of a very small machine must still
 * be a runnable cap, and `CPUQuota=0%` or `MemoryMax=0` would name a unit nothing can execute in.
 * The schema already refuses a zero percentage, so the floor only ever bites on rounding.
 */
export function unitLimits(limit: CgroupLimit, host: CgroupHostFacts): CgroupUnitLimits {
  return {
    cpuQuota: `${Math.max(1, Math.round(limit.cpuPercent * host.cpus))}%`,
    memoryMax: String(Math.max(1, Math.floor((limit.memoryPercent / 100) * host.memoryBytes))),
  };
}

/** What the saved configuration means on this exact host, as the view reports it. */
export function effectiveCgroupLimits(config: CgroupConfig, host: CgroupHostFacts): CgroupEffectiveLimits {
  return {
    cpus: host.cpus,
    memoryBytes: host.memoryBytes,
    fleet: unitLimits(config.fleet, host),
    perAgent: unitLimits(config.perAgent, host),
  };
}

/** Whether this host can enforce anything at all: the unified hierarchy, on the one platform whose
 *  user manager this daemon knows how to ask. A machine that fails either is reported as
 *  unsupported and is never given a command it would refuse. */
export function cgroupsSupported(host: CgroupHostFacts): boolean {
  return host.platform === 'linux' && host.unifiedHierarchy;
}
