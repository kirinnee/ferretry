import type { CgroupHostFacts } from './ports.ts';

/** Whether this host can enforce cgroup limits at all: the unified hierarchy, on Linux. */
export function cgroupsSupported(host: CgroupHostFacts): boolean {
  return host.platform === 'linux' && host.unifiedHierarchy;
}
