import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  BrowserControlError,
  BrowserProfileBusyError,
  type BrowserProfileLease,
  type BrowserProfileLeaseRecord,
  type BrowserProfileMetadata,
  type BrowserProfilePort,
  compareChromeVersions,
  highestChromeVersion,
  isPositiveInteger,
  isPrimedMarker,
  parseBrowserProfileLease,
  passwordSavingOff,
  sameBrowserProfileLease,
} from '../index.ts';
import { type OrphanChromeInspector, profileHolder } from './orphan-chrome.ts';

// GAP (kernel port, banned-globals stays visible here): Chrome takes a REAL `--user-data-dir`, so the agent profile, its
// lease file and the symlink checks need a real state path and a lease no kernel port gives (`kernel.state` stores
// documents, not a folder Chrome writes); the lease's `acquiredAt` (`new Date()`) moves to the clock with it.

const leaseName = 'profile.lock';
const reclaimName = 'profile.lock.reclaim';
const metadataName = 'profile.metadata.json';
const primedName = 'profile.primed.json';
const staleChromeFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'] as const;

/**
 * The profile's version record, read field by field: one damaged field costs that field alone, so a
 * hand edit to one version cannot erase the others that guard the profile against a Chrome downgrade.
 */
const MetadataFieldSchema = z.string().optional().catch(undefined);
const BrowserProfileMetadataSchema = z.object({
  createdChromeVersion: MetadataFieldSchema,
  createdAt: MetadataFieldSchema,
  primedChromeVersion: MetadataFieldSchema,
  primedAt: MetadataFieldSchema,
  latestChromeVersion: MetadataFieldSchema,
  latestAt: MetadataFieldSchema,
}) satisfies z.ZodType<BrowserProfileMetadata>;

// The system's way to read and stop a leftover Chrome: `/proc` (`ps` where there is none) and a signal, which need the
// real process table and a real clock, so they sit beside the store's other real-host reads.
async function readArgumentsFromProc(pid: number): Promise<readonly string[] | undefined> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(part => part !== '');
  } catch {
    return undefined;
  }
}

/** macOS has no `/proc`; `ps` prints the command line as one string, which is enough to find the flag. */
function readArgumentsFromPs(pid: number): Promise<readonly string[] | undefined> {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], (error, stdout) => {
      const line = stdout.trim();
      resolve(error || line === '' ? undefined : line.split(/\s+(?=--)/));
    });
  });
}

function aliveByProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function goneWithin(pid: number, milliseconds: number, alive: (pid: number) => boolean): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

/** SIGTERM first so Chrome can flush its profile, SIGKILL only if it ignores that. */
async function terminateProcess(
  pid: number,
  alive: (pid: number) => boolean = aliveByProbe,
  termMilliseconds = 2_000,
  killMilliseconds = 1_000,
): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  if (await goneWithin(pid, termMilliseconds, alive)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  return await goneWithin(pid, killMilliseconds, alive);
}

function systemOrphanChromeInspector(alive: (pid: number) => boolean = aliveByProbe): OrphanChromeInspector {
  return {
    readArguments: async pid => (await readArgumentsFromProc(pid)) ?? (await readArgumentsFromPs(pid)),
    terminate: pid => terminateProcess(pid, alive),
  };
}

type SingletonLockState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'stale'; readonly pid: number }
  | { readonly kind: 'live'; readonly pid: number }
  | { readonly kind: 'unknown'; readonly detail: string };

export interface BrowserProfileStoreOptions {
  readonly daemonPid?: number;
  readonly hostname?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  /** How a Chrome left behind on the profile is recognised and stopped; the system's by default. */
  readonly orphans?: OrphanChromeInspector;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Node filesystem implementation of the daemon-global, private browser profile. */
export class BrowserProfileStore implements BrowserProfilePort {
  readonly browserDirectory: string;
  /** Where a private X display keeps the cookie file its clients must present. */
  readonly displayDirectory: string;
  readonly profile: string;
  readonly leaseFile: string;
  private readonly daemonPid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly orphans: OrphanChromeInspector;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(stateDirectory: string, options: BrowserProfileStoreOptions = {}) {
    // `state/browsers/` (§9.2): Chrome's own profile under `data/agent`, the display cookies under `x11/`.
    this.browserDirectory = stateDirectory;
    this.displayDirectory = path.join(this.browserDirectory, 'x11');
    this.profile = path.join(this.browserDirectory, 'data', 'agent');
    this.leaseFile = path.join(this.browserDirectory, leaseName);
    this.daemonPid = options.daemonPid ?? process.pid;
    this.hostname = options.hostname ?? os.hostname();
    this.isProcessAlive =
      options.isProcessAlive ??
      (pid => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      });
    this.orphans = options.orphans ?? systemOrphanChromeInspector(this.isProcessAlive);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (milliseconds => Bun.sleep(milliseconds));
  }

  async acquire(options: {
    readonly sessionId: string;
    readonly chromeVersion?: string;
  }): Promise<BrowserProfileLease> {
    if (!options.sessionId.trim())
      throw new BrowserControlError('bad_request', 'a browser profile session id is required');
    await this.ensureProfile(options.chromeVersion);
    let recoveredDeadOwner = false;
    for (;;) {
      const desired: BrowserProfileLeaseRecord = {
        sessionId: options.sessionId,
        daemonPid: this.daemonPid,
        acquiredAt: this.now().toISOString(),
      };
      try {
        await this.createExclusive(this.leaseFile, desired);
        let singleton = await this.singletonLockState();
        // This daemon holds the one exclusive lease, so a live Chrome on the profile is nobody's session: when its
        // own command line names this profile it is a leftover, and it is stopped rather than left to block us.
        if (singleton.kind === 'live' && (await this.reapOrphan(singleton.pid))) {
          singleton = await this.singletonLockState();
        }
        if (singleton.kind === 'live') {
          await this.releaseRecord(desired);
          throw new BrowserProfileBusyError(
            'chrome',
            `shared browser profile is in use by Chrome pid ${singleton.pid}`,
          );
        }
        if (singleton.kind === 'unknown') {
          await this.releaseRecord(desired);
          throw new BrowserProfileBusyError(
            'unknown',
            `shared browser profile lock cannot be verified: ${singleton.detail}`,
          );
        }
        // Chrome is not running on the profile now, and nobody else holds it: its own preferences are set here, on
        // every lease, so a profile made before this rule gets it too. A profile that cannot be kept from saving
        // passwords is not handed out.
        try {
          await this.keepPasswordsUnsaved();
        } catch {
          await this.releaseRecord(desired);
          throw new BrowserControlError(
            'launch_failed',
            'Ferretry could not turn off password saving in the agent browser profile, so it did not start the browser',
          );
        }
        return this.lease(desired, recoveredDeadOwner || singleton.kind === 'stale');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const current = await this.readLease();
      if (!current) continue;
      // There is deliberately NO same-session shortcut here, and its absence is load-bearing. A lease
      // that still exists while this daemon holds no live browser is one the session launcher could
      // not prove safe to release, and the session it names is the FIRST caller to come back. Handing
      // it back would give a quarantined profile to exactly the retry the quarantine exists to stop,
      // and would alias one record to two holders that can release each other's lease. An extant
      // lease is exclusive against everyone, its own holder included: it is freed by its holder
      // releasing it, or reclaimed below once the owners it names are confirmed dead — never by
      // asking again.
      if (this.isProcessAlive(current.daemonPid)) {
        throw new BrowserProfileBusyError(
          current.daemonPid === this.daemonPid ? 'lease' : 'unknown',
          `shared browser profile is leased by session ${current.sessionId}`,
        );
      }
      // The owning daemon is gone. A Chrome it named is only ever stopped when that very process still runs on this
      // profile (a recycled pid is not it, and an unreadable one is never signalled); otherwise it is refused.
      let chromeCleared: number | undefined;
      if (current.chromePid && this.isProcessAlive(current.chromePid)) {
        const holder = await profileHolder(this.orphans, current.chromePid, this.profile);
        const gone =
          holder === 'other-process' ||
          (holder === 'holds-profile' && (await this.orphans.terminate(current.chromePid)));
        if (!gone) {
          throw new BrowserProfileBusyError(
            'chrome',
            `shared browser profile has a live orphaned Chrome pid ${current.chromePid}`,
          );
        }
        chromeCleared = current.chromePid;
      }
      await this.reclaimDeadLease(current, chromeCleared);
      recoveredDeadOwner = true;
    }
  }

  async isPrimed(): Promise<boolean> {
    return isPrimedMarker(await this.readJson(path.join(this.browserDirectory, primedName), z.unknown()));
  }

  async assertChromeVersionCompatible(runningChromeVersion: string): Promise<void> {
    const metadata = await this.readJson(path.join(this.browserDirectory, metadataName), BrowserProfileMetadataSchema);
    const recorded = highestChromeVersion(metadata);
    if (!recorded || compareChromeVersions(runningChromeVersion, recorded) !== -1) return;
    throw new BrowserControlError(
      'launch_failed',
      `Chrome ${runningChromeVersion.slice(0, 160)} is older than shared-profile Chrome ${recorded.slice(0, 160)}`,
    );
  }

  private lease(record: BrowserProfileLeaseRecord, recoveredDeadOwner: boolean): BrowserProfileLease {
    return {
      profile: this.profile,
      sessionId: record.sessionId,
      daemonPid: record.daemonPid,
      acquiredAt: record.acquiredAt,
      recoveredDeadOwner,
      updateChromePid: async (pid, version) => await this.updateChromePid(record, pid, version),
      cleanupStaleChromeLocks: async () => await this.cleanupStaleChromeLocks(record, recoveredDeadOwner),
      markPrimed: async version => await this.markPrimed(record, version),
      release: async () => await this.release(record),
    };
  }

  /** Forces Chrome's password saving off in the profile's `Default/Preferences`, keeping everything else in it. */
  private async keepPasswordsUnsaved(): Promise<void> {
    const directory = path.join(this.profile, 'Default');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'Preferences');
    const existing = await readFile(file, 'utf8').then(
      text => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return undefined;
        }
      },
      () => undefined,
    );
    await this.writeJson(file, passwordSavingOff(existing));
  }

  private async ensureProfile(chromeVersion?: string): Promise<void> {
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    await chmod(this.browserDirectory, 0o700);
    await chmod(this.profile, 0o700);
    const metadataFile = path.join(this.browserDirectory, metadataName);
    if (!(await this.readJson(metadataFile, BrowserProfileMetadataSchema)) && chromeVersion?.trim()) {
      await this.writeJson(metadataFile, {
        createdChromeVersion: chromeVersion.trim(),
        createdAt: this.now().toISOString(),
      });
    }
  }

  private async updateChromePid(
    expected: BrowserProfileLeaseRecord,
    chromePid?: number,
    chromeVersion?: string,
  ): Promise<void> {
    if (chromePid !== undefined && !isPositiveInteger(chromePid)) {
      throw new BrowserControlError('bad_request', 'browser Chrome pid must be a positive integer');
    }
    const current = await this.requireOwner(expected);
    if (chromeVersion !== undefined) await this.recordChromeVersion(chromeVersion);
    const { chromePid: _previousChromePid, ...withoutChromePid } = current;
    const updated = chromePid === undefined ? withoutChromePid : { ...withoutChromePid, chromePid };
    await this.writeJson(this.leaseFile, updated);
  }

  private async markPrimed(expected: BrowserProfileLeaseRecord, chromeVersion: string): Promise<void> {
    await this.requireOwner(expected);
    const version = chromeVersion.trim();
    if (!version)
      throw new BrowserControlError('bad_request', 'the Chrome version used to prime the profile is required');
    const metadataFile = path.join(this.browserDirectory, metadataName);
    const metadata = (await this.readJson(metadataFile, BrowserProfileMetadataSchema)) ?? {};
    const previous = highestChromeVersion(metadata);
    const latestChromeVersion = previous && compareChromeVersions(version, previous) === -1 ? previous : version;
    const now = this.now().toISOString();
    await this.writeJson(metadataFile, {
      ...metadata,
      ...(metadata.createdChromeVersion ? {} : { createdChromeVersion: version, createdAt: now }),
      primedChromeVersion: version,
      primedAt: now,
      latestChromeVersion,
      latestAt: now,
    });
    await this.writeJson(path.join(this.browserDirectory, primedName), { version, primedAt: now });
  }

  private async recordChromeVersion(chromeVersion: string): Promise<void> {
    const version = chromeVersion.trim();
    if (compareChromeVersions(version, version) === undefined) {
      throw new BrowserControlError('launch_failed', 'Chrome returned an unreadable version for the shared profile');
    }
    const file = path.join(this.browserDirectory, metadataName);
    const metadata = (await this.readJson(file, BrowserProfileMetadataSchema)) ?? {};
    const previous = highestChromeVersion(metadata);
    if (previous && compareChromeVersions(version, previous) !== 1) return;
    await this.writeJson(file, { ...metadata, latestChromeVersion: version, latestAt: this.now().toISOString() });
  }

  private async cleanupStaleChromeLocks(
    expected: BrowserProfileLeaseRecord,
    recoveredDeadOwner: boolean,
  ): Promise<readonly string[]> {
    await this.requireOwner(expected);
    const singleton = await this.singletonLockState();
    if (singleton.kind === 'live')
      throw new BrowserProfileBusyError('chrome', `shared browser profile is in use by Chrome pid ${singleton.pid}`);
    if (singleton.kind === 'unknown')
      throw new BrowserProfileBusyError(
        'unknown',
        `shared browser profile lock cannot be verified: ${singleton.detail}`,
      );
    if (singleton.kind !== 'stale' && !recoveredDeadOwner) return [];
    const removed: string[] = [];
    for (const name of staleChromeFiles) {
      try {
        await lstat(path.join(this.profile, name));
        await rm(path.join(this.profile, name));
        removed.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }

  private async release(expected: BrowserProfileLeaseRecord): Promise<boolean> {
    const current = await this.readLease();
    if (!current || !sameBrowserProfileLease(current, expected)) return false;
    await rm(this.leaseFile, { force: true });
    return true;
  }

  private async requireOwner(expected: BrowserProfileLeaseRecord): Promise<BrowserProfileLeaseRecord> {
    const current = await this.readLease();
    if (current && sameBrowserProfileLease(current, expected)) return current;
    throw new BrowserProfileBusyError('lease', 'shared browser profile lease is no longer owned by this session');
  }

  private async reclaimDeadLease(expected: BrowserProfileLeaseRecord, chromeCleared?: number): Promise<void> {
    const guard = path.join(this.browserDirectory, reclaimName);
    try {
      await this.createExclusive(guard, {
        sessionId: `reclaim-${this.daemonPid}`,
        daemonPid: this.daemonPid,
        acquiredAt: this.now().toISOString(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const reclaimer = await this.readLeaseFile(guard);
      if (!reclaimer || !this.isProcessAlive(reclaimer.daemonPid)) await rm(guard, { force: true });
      else await this.sleep(10);
      return;
    }
    try {
      const current = await this.readLease();
      if (!current || !sameBrowserProfileLease(current, expected)) return;
      const chromeLive =
        current.chromePid !== undefined &&
        current.chromePid !== chromeCleared &&
        this.isProcessAlive(current.chromePid);
      if (this.isProcessAlive(current.daemonPid) || chromeLive) return;
      await rm(this.leaseFile, { force: true });
    } finally {
      await rm(guard, { force: true });
    }
  }

  /** Stops `pid` only when its own command line says it runs Chrome on this profile; true once it is gone. */
  private async reapOrphan(pid: number): Promise<boolean> {
    if ((await profileHolder(this.orphans, pid, this.profile)) !== 'holds-profile') return false;
    return await this.orphans.terminate(pid);
  }

  private async singletonLockState(): Promise<SingletonLockState> {
    let target: string;
    try {
      target = await readlink(path.join(this.profile, 'SingletonLock'));
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'missing' }
        : { kind: 'unknown', detail: 'not a readable symlink' };
    }
    const match = path.basename(target).match(/^(.+)-(\d+)$/);
    if (!match || match[1] !== this.hostname || !isPositiveInteger(Number(match[2]))) {
      return { kind: 'unknown', detail: 'owner hostname or pid is not local and parseable' };
    }
    const pid = Number(match[2]);
    return this.isProcessAlive(pid) ? { kind: 'live', pid } : { kind: 'stale', pid };
  }

  private async readLease(): Promise<BrowserProfileLeaseRecord | undefined> {
    const record = await this.readLeaseFile(this.leaseFile);
    if (record !== undefined) return record;
    try {
      await readFile(this.leaseFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    }
    throw new BrowserProfileBusyError(
      'unknown',
      'shared browser profile lease is malformed and cannot be safely reclaimed',
    );
  }

  private async readLeaseFile(file: string): Promise<BrowserProfileLeaseRecord | undefined> {
    try {
      return parseBrowserProfileLease(await readFile(file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async createExclusive(file: string, value: BrowserProfileLeaseRecord): Promise<void> {
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
    } finally {
      await handle.close();
    }
  }

  private async releaseRecord(record: BrowserProfileLeaseRecord): Promise<void> {
    const current = await this.readLease();
    if (current && sameBrowserProfileLease(current, record)) await rm(this.leaseFile, { force: true });
  }

  private async readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      return schema.safeParse(JSON.parse(await readFile(file, 'utf8'))).data;
    } catch {
      return undefined;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.tmp.${this.daemonPid}.${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
