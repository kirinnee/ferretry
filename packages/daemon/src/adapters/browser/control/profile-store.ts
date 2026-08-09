import { chmod, lstat, mkdir, open, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserControlError,
  BrowserProfileBusyError,
  compareChromeVersions,
  highestChromeVersion,
  isPositiveInteger,
  isPrimedMarker,
  parseBrowserProfileLease,
  sameBrowserProfileLease,
  type BrowserProfileLease,
  type BrowserProfileLeaseRecord,
  type BrowserProfileMetadata,
  type BrowserProfilePort,
} from '../../../lib/browser/control/index.ts';

const leaseName = 'profile.lock';
const reclaimName = 'profile.lock.reclaim';
const metadataName = 'profile.metadata.json';
const primedName = 'profile.primed.json';
const staleChromeFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'] as const;

type SingletonLockState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'stale'; readonly pid: number }
  | { readonly kind: 'live'; readonly pid: number }
  | { readonly kind: 'unknown'; readonly detail: string };

export interface BrowserProfileStoreOptions {
  readonly daemonPid?: number;
  readonly hostname?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Node filesystem implementation of the daemon-global, private browser profile. */
export class BrowserProfileStore implements BrowserProfilePort {
  readonly browserDirectory: string;
  readonly profile: string;
  readonly leaseFile: string;
  private readonly daemonPid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(daemonDirectory: string, options: BrowserProfileStoreOptions = {}) {
    this.browserDirectory = path.join(daemonDirectory, 'browser');
    this.profile = path.join(this.browserDirectory, 'profile');
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
        const singleton = await this.singletonLockState();
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
      if (current.chromePid && this.isProcessAlive(current.chromePid)) {
        throw new BrowserProfileBusyError(
          'chrome',
          `shared browser profile has a live orphaned Chrome pid ${current.chromePid}`,
        );
      }
      await this.reclaimDeadLease(current);
      recoveredDeadOwner = true;
    }
  }

  async isPrimed(): Promise<boolean> {
    return isPrimedMarker(await this.readJson(path.join(this.browserDirectory, primedName)));
  }

  async assertChromeVersionCompatible(runningChromeVersion: string): Promise<void> {
    const metadata = await this.readJson<BrowserProfileMetadata>(path.join(this.browserDirectory, metadataName));
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

  private async ensureProfile(chromeVersion?: string): Promise<void> {
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    await chmod(this.browserDirectory, 0o700);
    await chmod(this.profile, 0o700);
    const metadataFile = path.join(this.browserDirectory, metadataName);
    if (!(await this.readJson(metadataFile)) && chromeVersion?.trim()) {
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
    const metadata = (await this.readJson<BrowserProfileMetadata>(metadataFile)) ?? {};
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
    const metadata = (await this.readJson<BrowserProfileMetadata>(file)) ?? {};
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

  private async reclaimDeadLease(expected: BrowserProfileLeaseRecord): Promise<void> {
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
      if (this.isProcessAlive(current.daemonPid) || (current.chromePid && this.isProcessAlive(current.chromePid)))
        return;
      await rm(this.leaseFile, { force: true });
    } finally {
      await rm(guard, { force: true });
    }
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

  private async readJson<T = unknown>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
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
