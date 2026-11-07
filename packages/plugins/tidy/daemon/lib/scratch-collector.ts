/**
 * The scratch collector: copied from today's `adapters/scratch/file-scratch-collector.ts`, now over Ferrets' list of
 * stopped ferrets and the `worktrees` root (no `node:fs`). It owns no ferret state: it reads each ferret fresh and
 * treats anything it cannot read as a refusal.
 *
 * WHAT IT MAY REMOVE. Only the direct children of a STOPPED ferret's folder, and only when that folder is inside
 * `<FY_HOME>-worktrees/` (a folder the owner named is never touched), is not a git worktree, is not shared with a ferret
 * that still works, and nothing in it changed inside the wait. A link is listed but never followed or removed (counted
 * as a failure rather than risked).
 *
 * KERNEL GAP: this needs `RootHandle.lstat` (the leaf not followed), which `rebuild/port-kernel` adds and `rebuild/5.0`
 * does not carry yet. `stat` and `remove` follow a link, so without `lstat` a link to another worktree could be deleted
 * through this one. Until it lands the collector plans and sweeps nothing.
 */
import type { FerretSummary, FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FolderRefusal, RootHandle } from '@ferretry/kernel/contract';
import type { Instant, Result } from '@ferretry/std';
import type { ScratchEntry, ScratchPlanView, ScratchSweepView } from '../../contract/index.ts';
import { scratchEligibility } from './scratch-policy.ts';

/** What is AT a name, the leaf not followed (the kernel's `RootLstat`). */
export interface ScratchLstat {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly modified: Instant;
}

/** The part of a root handle the collector uses; `lstat` is optional until the kernel carries it (see the header). */
export interface ScratchFolders {
  resolve(relative: string): Result<FencedPath, FolderRefusal>;
  list(path: FencedPath): Promise<readonly string[]>;
  remove(path: FencedPath): Promise<void>;
  lstat?(path: FencedPath): Promise<ScratchLstat | undefined>;
}
// A real root handle must stay assignable to the port.
export const rootAsFolders = (root: RootHandle): ScratchFolders => root as ScratchFolders;

export interface ScratchConfig {
  readonly enabled: boolean;
  readonly ttlHours: number;
  readonly perSweep: number;
}

export interface ScratchPorts {
  readonly ferrets: Pick<FerretsApi, 'list'>;
  readonly worktrees: ScratchFolders;
  readonly nowMs: () => number;
  readonly config: () => ScratchConfig;
  /** Adds what one sweep reclaimed to the totals the health report states. */
  readonly record: (reclaimed: { readonly ferrets: number; readonly bytes: number }) => Promise<void>;
}

interface Scan {
  readonly entries: readonly ScratchEntry[];
  readonly bytes: number;
  readonly newestMtimeMs: number | undefined;
  readonly gitWorktree: boolean;
}

const GIT = '.git';

export class ScratchCollector {
  constructor(private readonly ports: ScratchPorts) {}

  async plan(limit = this.ports.config().perSweep): Promise<readonly ScratchPlanView[]> {
    const { ferrets, worktrees } = this.ports;
    if (worktrees.lstat === undefined) return [];
    const all = await ferrets.list();
    const liveFolders = new Set(all.filter(ferret => ferret.state !== 'stopped').map(ferret => ferret.folder));
    const stopped = all
      .filter(ferret => ferret.state === 'stopped')
      .sort((left, right) => Date.parse(left.stateAt) - Date.parse(right.stateAt));
    const root = worktrees.resolve('');
    const plans: ScratchPlanView[] = [];
    const ttlMs = Math.max(1, this.ports.config().ttlHours) * 3_600_000;
    for (const ferret of stopped) {
      if (plans.filter(plan => plan.eligible).length >= limit) break;
      const folder = worktrees.resolve(ferret.folder);
      if (!folder.ok || (root.ok && folder.value === root.value)) continue;
      const scan = await this.scan(folder.value, worktrees.lstat.bind(worktrees));
      if (scan === undefined || scan.entries.length === 0) continue;
      const verdict = scratchEligibility({
        stopped: true,
        stoppedAtMs: Date.parse(ferret.stateAt),
        newestMtimeMs: scan.newestMtimeMs,
        nowMs: this.ports.nowMs(),
        ttlMs,
        gitWorktree: scan.gitWorktree,
        sharedWithLive: liveFolders.has(ferret.folder),
      });
      plans.push(viewOf(ferret, folder.value, scan, verdict));
    }
    return plans;
  }

  async sweep(force = false): Promise<ScratchSweepView> {
    if (!force && !this.ports.config().enabled) return { ferrets: 0, bytes: 0, failures: 0 };
    let ferrets = 0;
    let bytes = 0;
    let failures = 0;
    for (const plan of await this.plan()) {
      if (!plan.eligible) continue;
      const result = await this.reclaim(plan.directory as FencedPath, plan.entries);
      failures += result.failures;
      if (result.removed === 0) continue;
      ferrets += 1;
      bytes += result.bytes;
    }
    if (ferrets > 0) await this.ports.record({ ferrets, bytes });
    return { ferrets, bytes, failures };
  }

  /** Lists the direct children with their sizes; `undefined` when the folder cannot be read at all. */
  private async scan(directory: FencedPath, lstat: NonNullable<ScratchFolders['lstat']>): Promise<Scan | undefined> {
    const { worktrees } = this.ports;
    let names: readonly string[];
    try {
      names = await worktrees.list(directory);
    } catch {
      return undefined;
    }
    const entries: ScratchEntry[] = [];
    let bytes = 0;
    let newest: number | undefined;
    for (const name of names) {
      const child = worktrees.resolve(`${directory}/${name}`);
      if (!child.ok) continue;
      const measured = await this.measure(child.value, lstat);
      newest = newest === undefined ? measured.newestMtimeMs : Math.max(newest, measured.newestMtimeMs ?? 0);
      entries.push({ name, bytes: measured.bytes, kind: measured.kind });
      bytes += measured.bytes;
    }
    entries.sort((left, right) => right.bytes - left.bytes);
    return { entries, bytes, newestMtimeMs: newest, gitWorktree: names.includes(GIT) };
  }

  private async measure(
    path: FencedPath,
    lstat: NonNullable<ScratchFolders['lstat']>,
  ): Promise<{ bytes: number; newestMtimeMs: number | undefined; kind: ScratchEntry['kind'] }> {
    const { worktrees } = this.ports;
    let info: ScratchLstat | undefined;
    try {
      info = await lstat(path);
    } catch {
      return { bytes: 0, newestMtimeMs: undefined, kind: 'file' };
    }
    if (info === undefined) return { bytes: 0, newestMtimeMs: undefined, kind: 'file' };
    const modified = Date.parse(info.modified);
    // A link counts as itself: never followed, so a loop or a link out of the root costs nothing.
    if (info.kind === 'symlink') return { bytes: 0, newestMtimeMs: modified, kind: 'symlink' };
    if (info.kind !== 'directory') return { bytes: info.size, newestMtimeMs: modified, kind: 'file' };
    let bytes = info.size;
    let newest: number | undefined = modified;
    let names: readonly string[] = [];
    try {
      names = await worktrees.list(path);
    } catch {
      /* unreadable: its own size and time stand */
    }
    for (const name of names) {
      const child = worktrees.resolve(`${path}/${name}`);
      if (!child.ok) continue;
      const inner = await this.measure(child.value, lstat);
      bytes += inner.bytes;
      newest = newest === undefined ? inner.newestMtimeMs : Math.max(newest, inner.newestMtimeMs ?? 0);
    }
    return { bytes, newestMtimeMs: newest, kind: 'directory' };
  }

  /** Removes direct children only; containment is checked again by the root handle at deletion. */
  private async reclaim(
    directory: FencedPath,
    entries: readonly ScratchEntry[],
  ): Promise<{ removed: number; bytes: number; failures: number }> {
    const { worktrees } = this.ports;
    let removed = 0;
    let bytes = 0;
    let failures = 0;
    for (const entry of entries) {
      if (entry.kind === 'symlink' || entry.name === GIT || entry.name.includes('/')) {
        failures += 1;
        continue;
      }
      const path = worktrees.resolve(`${directory}/${entry.name}`);
      if (!path.ok) {
        failures += 1;
        continue;
      }
      try {
        await worktrees.remove(path.value);
        removed += 1;
        bytes += entry.bytes;
      } catch {
        failures += 1;
      }
    }
    return { removed, bytes, failures };
  }
}

function viewOf(
  ferret: FerretSummary,
  directory: string,
  scan: Scan,
  verdict: { readonly eligible: boolean; readonly reason?: string },
): ScratchPlanView {
  const base = { ferret: ferret.id, name: ferret.name, directory, bytes: scan.bytes, entries: [...scan.entries] };
  return verdict.eligible
    ? { ...base, eligible: true }
    : { ...base, eligible: false, reason: verdict.reason ?? 'not eligible' };
}
