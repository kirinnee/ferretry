/**
 * How much memory the user may spend, from the cgroup tree above this daemon.
 *
 * THE MACHINE'S RAM IS NOT THE BUDGET. A host with 61 GiB gave the whole user slice `MemoryHigh=48G`:
 * past 48 GiB the kernel makes every task in the slice — the daemon's own thread included — reclaim
 * memory and sleep. A fleet sized from 61 GiB fills the 48 and the daemon is the one that stalls. So
 * the budget is the smallest finite `memory.max` / `memory.high` on any ancestor of the daemon's own
 * cgroup, or the physical RAM when there is none.
 *
 * Pure: the adapter reads the files; this decides what they mean.
 */

/** One finite cap found on an ancestor cgroup. */
export interface AncestorCap {
  /** The cgroup the cap is set on, below the cgroup root (`/user.slice/user-1000.slice`). */
  readonly path: string;
  readonly file: 'memory.max' | 'memory.high';
  readonly bytes: number;
}

/** The cgroup-v2 path in `/proc/<pid>/cgroup` text (`0::/user.slice/...`), or `undefined` on v1 or none. */
export function ownCgroupPath(procCgroup: string): string | undefined {
  for (const line of procCgroup.split('\n')) {
    if (!line.startsWith('0::')) continue;
    const path = line.slice(3).trim();
    return path.startsWith('/') ? path.replace(/ \(deleted\)$/u, '') : undefined;
  }
  return undefined;
}

/** Every ancestor of a cgroup path, root-most first, the path itself last. `/a/b` → `/a`, `/a/b`. */
export function ancestorPaths(path: string): readonly string[] {
  const parts = path.split('/').filter(part => part.length > 0);
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`);
}

/** A `memory.max` / `memory.high` value: bytes, or `undefined` for `max` (no cap) and anything unreadable. */
export function parseMemoryCap(text: string): number | undefined {
  const value = text.trim();
  if (!/^\d+$/u.test(value)) return undefined;
  const bytes = Number(value);
  // The kernel prints a page-rounded 2^63-ish number for "unlimited" on some setups; nothing real is that big.
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes < 2 ** 52 ? bytes : undefined;
}

/**
 * The user's cgroup manager: the path of the `user@<uid>.service` ancestor, whose child slices a
 * `systemd-run --user --slice=` unit lands in. `undefined` where the daemon is not under one (a system
 * service, a container, a plain shell without a user manager).
 */
export function userManagerPath(path: string): string | undefined {
  const parts = path.split('/').filter(part => part.length > 0);
  const index = parts.findIndex(part => /^user@\d+\.service$/u.test(part));
  return index < 0 ? undefined : `/${parts.slice(0, index + 1).join('/')}`;
}

export interface MemoryCeiling {
  readonly bytes: number;
  /** What set it, in words. */
  readonly source: string;
  /** The ancestor cap that set it; absent when the machine's own memory is the ceiling. */
  readonly cap?: AncestorCap;
}

/** The smallest of the physical RAM and every cap, with the name of whatever set it. */
export function memoryCeiling(physicalBytes: number, caps: readonly AncestorCap[]): MemoryCeiling {
  let best: MemoryCeiling = { bytes: Math.max(1, Math.floor(physicalBytes)), source: 'the machine’s memory' };
  for (const cap of caps) {
    if (cap.bytes >= best.bytes) continue;
    const name = cap.path.split('/').filter(Boolean).at(-1) ?? 'the root cgroup';
    best = { bytes: cap.bytes, source: `${cap.file} of ${name}`, cap };
  }
  return best;
}

/** `MemTotal`-style `SwapTotal: 8388604 kB` → bytes, or 0 when there is none. */
export function parseSwapTotal(meminfo: string): number {
  const match = /^SwapTotal:\s+(\d+)\s+kB$/mu.exec(meminfo);
  return match === null ? 0 : Number(match[1]) * 1024;
}
