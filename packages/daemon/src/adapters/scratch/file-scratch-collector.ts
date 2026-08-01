import { chmod, lstat, readdir, readlink, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  SessionConfigSchema,
  SessionStateSchema,
  type ScratchEntry,
  type ScratchPlanView,
  type ScratchSweepView,
} from '@ferretry/protocol';
import { isDaemonOwnedScratchEntry, scratchEligibility, type ScratchEligibility } from '../../lib/scratch/index.ts';

export interface ScratchSession {
  readonly id: string;
}

/** Durable session records and their directories, supplied by the composition root. */
export interface ScratchSessionDirectory {
  list(): readonly ScratchSession[];
  config(id: string): Promise<unknown | undefined>;
  state(id: string): Promise<unknown | undefined>;
  directory(id: string): string;
}

/** A live pane blocks reclamation even when its state document says terminal. */
export interface ScratchPaneObserver {
  alive(id: string): Promise<boolean>;
}

export interface ScratchCollectorConfig {
  readonly enabled: boolean;
  readonly ttlHours: number;
  readonly perSweep: number;
}

export const defaultScratchCollectorConfig = (): ScratchCollectorConfig => ({
  enabled: true,
  ttlHours: 24,
  perSweep: 20,
});

interface ScratchScan {
  readonly entries: readonly ScratchEntry[];
  readonly bytes: number;
  readonly newestMtimeMs: number | undefined;
}

interface ReclaimResult {
  readonly removed: readonly string[];
  readonly bytes: number;
  readonly failures: number;
}

async function measure(path: string): Promise<{ readonly bytes: number; readonly newestMtimeMs: number | undefined }> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return { bytes: 0, newestMtimeMs: undefined };
  if (!info.isDirectory()) return { bytes: info.size, newestMtimeMs: info.mtimeMs };
  let bytes = info.size;
  let newestMtimeMs: number | undefined = info.mtimeMs;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = await measure(join(path, entry.name));
    bytes += child.bytes;
    newestMtimeMs =
      newestMtimeMs === undefined ? child.newestMtimeMs : Math.max(newestMtimeMs, child.newestMtimeMs ?? 0);
  }
  return { bytes, newestMtimeMs };
}

/** Lists only the direct children which are not durable daemon material. */
export async function scanScratch(directory: string): Promise<ScratchScan> {
  const entries: ScratchEntry[] = [];
  let bytes = 0;
  let newestMtimeMs: number | undefined;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const measured = await measure(join(directory, entry.name));
    newestMtimeMs =
      newestMtimeMs === undefined ? measured.newestMtimeMs : Math.max(newestMtimeMs, measured.newestMtimeMs ?? 0);
    if (isDaemonOwnedScratchEntry(entry.name)) continue;
    entries.push({
      name: entry.name,
      bytes: measured.bytes,
      kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
    });
    bytes += measured.bytes;
  }
  entries.sort((left, right) => right.bytes - left.bytes);
  return { entries, bytes, newestMtimeMs };
}

async function relaxPermissions(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink()) return;
  await chmod(path, info.isDirectory() ? 0o700 : 0o600).catch(() => undefined);
  if (!info.isDirectory()) return;
  for (const name of await readdir(path).catch((): string[] => [])) await relaxPermissions(join(path, name));
}

/** Reclaims direct scratch children only; containment and ownership are checked again at deletion. */
export async function reclaimScratch(directory: string, entries: readonly ScratchEntry[]): Promise<ReclaimResult> {
  const root = resolve(directory);
  const removed: string[] = [];
  let bytes = 0;
  let failures = 0;
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (dirname(path) !== root || isDaemonOwnedScratchEntry(entry.name)) {
      failures += 1;
      continue;
    }
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path).catch(() => '?');
        await rm(path, { force: true });
        removed.push(`${entry.name} -> ${target}`);
        continue;
      }
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EACCES' && code !== 'EPERM') throw error;
        await relaxPermissions(path);
        await rm(path, { recursive: true, force: true });
      }
      removed.push(entry.name);
      bytes += entry.bytes;
    } catch {
      failures += 1;
    }
  }
  return { removed, bytes, failures };
}

async function trimSnapshots(directory: string, maxSnapshots: number): Promise<number> {
  if (!Number.isFinite(maxSnapshots) || maxSnapshots < 1) return 0;
  const snapshots = join(directory, 'snapshots');
  const names = (await readdir(snapshots).catch(() => [])).filter(name => name.endsWith('.txt')).sort();
  const excess = names.slice(0, Math.max(0, names.length - maxSnapshots));
  await Promise.all(excess.map(name => rm(join(snapshots, name), { force: true }).catch(() => undefined)));
  return excess.length;
}

function planFor(
  id: string,
  teammate: string | undefined,
  directory: string,
  scan: ScratchScan,
  verdict: ScratchEligibility,
): ScratchPlanView {
  return verdict.eligible
    ? {
        sessionId: id,
        ...(teammate === undefined ? {} : { teammate }),
        directory,
        bytes: scan.bytes,
        entries: [...scan.entries],
        eligible: true,
      }
    : {
        sessionId: id,
        ...(teammate === undefined ? {} : { teammate }),
        directory,
        bytes: scan.bytes,
        entries: [...scan.entries],
        eligible: false,
        reason: verdict.reason ?? 'not eligible',
      };
}

/**
 * The daemon-local scratch collector. It owns no session state: it reads each
 * current record and treats malformed data or an unobservable pane as a refusal.
 */
export class FileScratchCollector {
  private reclaimedSessions = 0;
  private reclaimedBytes = 0;

  constructor(
    private readonly sessions: ScratchSessionDirectory,
    private readonly panes: ScratchPaneObserver,
    private readonly config: ScratchCollectorConfig = defaultScratchCollectorConfig(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  totals(): { readonly enabled: boolean; readonly reclaimedSessions: number; readonly reclaimedBytes: number } {
    return {
      enabled: this.config.enabled,
      reclaimedSessions: this.reclaimedSessions,
      reclaimedBytes: this.reclaimedBytes,
    };
  }

  async plan(limit = this.config.perSweep): Promise<readonly ScratchPlanView[]> {
    const plans: ScratchPlanView[] = [];
    const sessions = this.sessions.list();
    for (const session of sessions) {
      if (plans.filter(plan => plan.eligible).length >= limit) break;
      const [rawConfig, rawState] = await Promise.all([
        this.sessions.config(session.id),
        this.sessions.state(session.id),
      ]);
      const config = SessionConfigSchema.safeParse(rawConfig);
      const state = SessionStateSchema.safeParse(rawState);
      if (!config.success || !state.success) continue;
      const directory = this.sessions.directory(session.id);
      const scan = await scanScratch(directory);
      if (scan.entries.length === 0) continue;
      // A failed pane observation is a live pane for safety: availability is never proof of death.
      const hasLivePane = await this.panes.alive(session.id).catch(() => true);
      const verdict = scratchEligibility({
        status: state.data.status,
        ...(state.data.finishedAt === undefined ? {} : { finishedAt: state.data.finishedAt }),
        ...(scan.newestMtimeMs === undefined ? {} : { newestMtimeMs: scan.newestMtimeMs }),
        nowMs: this.now(),
        ttlMs: Math.max(1, this.config.ttlHours) * 3_600_000,
        hasMonitor: false,
        hasLivePane,
        launching: false,
        wardenTarget: await this.hasLiveWarden(session.id, sessions),
      });
      plans.push(planFor(session.id, config.data.teammate, directory, scan, verdict));
    }
    return plans;
  }

  async sweep(force = false): Promise<ScratchSweepView> {
    if (!force && !this.config.enabled) return { sessions: 0, bytes: 0, failures: 0 };
    let sessions = 0;
    let bytes = 0;
    let failures = 0;
    for (const plan of await this.plan()) {
      if (!plan.eligible) continue;
      const result = await reclaimScratch(plan.directory, plan.entries);
      const config = SessionConfigSchema.safeParse(await this.sessions.config(plan.sessionId));
      await trimSnapshots(plan.directory, config.success ? config.data.maxSnapshots : 200);
      failures += result.failures;
      if (result.removed.length === 0) continue;
      sessions += 1;
      bytes += result.bytes;
      this.reclaimedSessions += 1;
      this.reclaimedBytes += result.bytes;
    }
    return { sessions, bytes, failures };
  }

  private async hasLiveWarden(id: string, sessions: readonly ScratchSession[]): Promise<boolean> {
    for (const session of sessions) {
      const [config, state] = await Promise.all([this.sessions.config(session.id), this.sessions.state(session.id)]);
      const parsedConfig = SessionConfigSchema.safeParse(config);
      const parsedState = SessionStateSchema.safeParse(state);
      if (!parsedConfig.success || !parsedState.success) continue;
      if (parsedConfig.data.label === 'warden' && parsedConfig.data.parent === id && !parsedState.data.finishedAt)
        return true;
    }
    return false;
  }
}
