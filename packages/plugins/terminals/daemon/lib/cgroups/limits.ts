/**
 * Turning resolved limits into the property values the host manager takes.
 *
 * ONE OWNER FOR THE FORMAT. Every value written to a unit, every value a fixture shows and every value
 * the status prints comes from here. systemd takes a decimal byte string (or `infinity`) for memory, a
 * plain integer for weights and task counts, and a percentage string for `CPUQuota`.
 *
 * `CPUQuota` is a share of the WHOLE machine (`cpuPercent: 50` on 8 CPUs is `CPUQuota=400%`), the only
 * reading under which a fleet quota and a per-ferret quota compose.
 *
 * Pure: no IO, no clock, no globals.
 */
import type { Cap, ResolvedFerretLimits, ResolvedFleetLimits } from '../protocol/limits.ts';
import type { CgroupHostFacts } from './ports.ts';

const value = (cap: Cap): string => (cap === null ? 'infinity' : String(Math.max(1, Math.floor(cap))));

function quota(percent: number | null, cpus: number): string {
  return percent === null ? '' : `${Math.max(1, Math.round((percent / 100) * cpus * 100))}%`;
}

/**
 * The properties on `<product>_fleet.slice`. `CPUQuota=` is written EMPTY when there is no quota, so
 * removing a quota from `limits.yaml` actually removes it from a slice an earlier daemon configured.
 */
export function fleetSliceProperties(limits: ResolvedFleetLimits, host: CgroupHostFacts): readonly string[] {
  return [
    `CPUWeight=${limits.cpuWeight}`,
    `CPUQuota=${quota(limits.cpuPercent, host.cpus)}`,
    `MemoryHigh=${value(limits.memoryHigh)}`,
    `MemoryMax=${value(limits.memoryMax)}`,
    `MemorySwapMax=${limits.swapMax === null ? 'infinity' : String(Math.max(0, Math.floor(limits.swapMax)))}`,
    `TasksMax=${value(limits.tasksMax)}`,
  ];
}

/** The properties on one ferret's slice. A person's own ferret gets the heavier CPU weight. */
export function ferretScopeProperties(
  limits: ResolvedFerretLimits,
  host: CgroupHostFacts,
  interactive: boolean,
): readonly string[] {
  return [
    `CPUWeight=${interactive ? limits.interactiveCpuWeight : limits.cpuWeight}`,
    `CPUQuota=${quota(limits.cpuPercent, host.cpus)}`,
    `MemoryHigh=${value(limits.memoryHigh)}`,
    `MemoryMax=${value(limits.memoryMax)}`,
    `TasksMax=${value(limits.tasksMax)}`,
  ];
}
