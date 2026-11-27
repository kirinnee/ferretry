import { constants, readFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BrowserIdentityKeySchema, DEFAULT_BROWSER_IDENTITY } from '../../../../contract/index.ts';
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
import {
  clearRecordedChrome,
  type OrphanChromeInspector,
  type ProcessIdentity,
  type SignalOutcome,
} from './orphan-chrome.ts';
import { tryProfileReclaimLock } from './profile-reclaim-lock.ts';

// GAP (kernel port, banned-globals stays visible here): Chrome takes a REAL `--user-data-dir`, so the agent profile, its
// lease file and the symlink checks need a real state path and a lease no kernel port gives (`kernel.state` stores
// documents, not a folder Chrome writes); the lease's `acquiredAt` (`new Date()`) moves to the clock with it.

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

// The real process table (`/proc`) and a signal: the only way to prove which Chrome is Ferretry's and stop it.
/** Field 22 of `/proc/<pid>/stat` (start time in ticks) and the state, after the parenthesised command name. */
function readStat(text: string): { readonly state: string; readonly ticks: string } | undefined {
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  const state = rest[0];
  const ticks = rest[19];
  return state && ticks ? { state, ticks } : undefined;
}

/** What the process table is read and signalled through; the real `/proc` and `kill` by default. */
export interface ProcessTable {
  readonly readText: (file: string) => string;
  readonly kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
}

const systemProcessTable: ProcessTable = {
  readText: file => readFileSync(file, 'utf8'),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

type ProcessRead =
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | (ProcessIdentity & { readonly kind: 'live' });

/**
 * Identity from `/proc` (Linux). Where there is no `/proc` nothing can be identified, so nothing is ever signalled:
 * a flattened `ps` line loses argument boundaries and cannot prove which profile a process holds.
 *
 * Every read here is synchronous, and `signalIf` reads the identity and sends the signal in one step with no `await`
 * between them (see the GAP in orphan-chrome.ts for the one kernel race that remains without a pidfd).
 */
export function systemOrphanChromeInspector(table: ProcessTable = systemProcessTable): OrphanChromeInspector {
  let bootId: string | undefined;
  const boot = (): string | undefined => {
    if (bootId !== undefined) return bootId;
    try {
      bootId = table.readText('/proc/sys/kernel/random/boot_id').trim();
    } catch {
      return undefined;
    }
    return bootId;
  };
  const read = (pid: number): ProcessRead => {
    try {
      const id = boot();
      if (id === undefined) return { kind: 'unreadable' };
      const before = readStat(table.readText(`/proc/${pid}/stat`));
      if (before === undefined) return { kind: 'unreadable' };
      if (before.state === 'Z' || before.state === 'X') return { kind: 'gone' };
      const args = table
        .readText(`/proc/${pid}/cmdline`)
        .split('\0')
        .filter(part => part !== '');
      // The same process answered both reads, or neither is trusted.
      const after = readStat(table.readText(`/proc/${pid}/stat`));
      if (after?.ticks !== before.ticks) return { kind: 'unreadable' };
      return { kind: 'live', startedAt: `${id}:${before.ticks}`, args };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'gone' } : { kind: 'unreadable' };
    }
  };
  return {
    identify: pid => {
      const found = read(pid);
      return found.kind === 'live' ? { startedAt: found.startedAt, args: found.args } : undefined;
    },
    signalIf: (pid, signal, accept): SignalOutcome => {
      const found = read(pid);
      if (found.kind !== 'live') return found.kind;
      if (!accept({ startedAt: found.startedAt, args: found.args })) return 'rejected';
      try {
        table.kill(pid, signal);
        return 'delivered';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'denied';
      }
    },
    sleep: milliseconds => Bun.sleep(milliseconds),
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

/** Where one identity keeps its profile folder and the files beside it. */
interface IdentityPaths {
  readonly identity: string;
  readonly profile: string;
  readonly leaseFile: string;
  readonly reclaimFile: string;
  readonly metadataFile: string;
  readonly primedFile: string;
}

/** Node filesystem implementation of the daemon's private browser profiles, one per identity. */
export class BrowserProfileStore implements BrowserProfilePort {
  readonly browserDirectory: string;
  /** Where a private X display keeps the cookie file its clients must present. */
  readonly displayDirectory: string;
  private readonly daemonPid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly orphans: OrphanChromeInspector;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(stateDirectory: string, options: BrowserProfileStoreOptions = {}) {
    // `state/browsers/` (§9.2): each identity's Chrome profile under `data/<key>`, the display cookies under `x11/`.
    this.browserDirectory = stateDirectory;
    this.displayDirectory = path.join(this.browserDirectory, 'x11');
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
    this.orphans = options.orphans ?? systemOrphanChromeInspector();
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? (milliseconds => Bun.sleep(milliseconds));
  }

  /**
   * The folders and files of one identity. The key is parsed here, so a key that could leave `data/` (`/`, `..`,
   * capitals) never becomes a path. The built-in identity keeps the names the machine's one agent browser has always
   * used (`profile.lock`, `profile.metadata.json`, `profile.primed.json`), so every login and lease already on disk
   * is its own; any other identity carries its key in the same names (`profile.<key>.lock`).
   */
  paths(identity: string): IdentityPaths {
    const parsed = BrowserIdentityKeySchema.safeParse(identity);
    if (!parsed.success) {
      throw new BrowserControlError(
        'bad_request',
        'a browser identity is a short lowercase name: letters, digits and dashes, starting with a letter',
      );
    }
    const key = parsed.data;
    const stem = key === DEFAULT_BROWSER_IDENTITY ? 'profile' : `profile.${key}`;
    return {
      identity: key,
      profile: path.join(this.browserDirectory, 'data', key),
      leaseFile: path.join(this.browserDirectory, `${stem}.lock`),
      reclaimFile: path.join(this.browserDirectory, `${stem}.lock.reclaim`),
      metadataFile: path.join(this.browserDirectory, `${stem}.metadata.json`),
      primedFile: path.join(this.browserDirectory, `${stem}.primed.json`),
    };
  }

  async acquire(
    identity: string,
    options: {
      readonly sessionId: string;
      readonly chromeVersion?: string;
    },
  ): Promise<BrowserProfileLease> {
    const paths = this.paths(identity);
    if (!options.sessionId.trim())
      throw new BrowserControlError('bad_request', 'a browser profile session id is required');
    await this.ensureProfile(paths, options.chromeVersion);
    let recoveredDeadOwner = false;
    for (;;) {
      const desired: BrowserProfileLeaseRecord = {
        sessionId: options.sessionId,
        daemonPid: this.daemonPid,
        acquiredAt: this.now().toISOString(),
      };
      try {
        await this.createExclusive(paths.leaseFile, desired);
        // A live Chrome holding the profile with no lease naming it is never signalled: with no Ferretry launch
        // record it may be the owner's own browser, so it blocks (and is named) rather than being stopped.
        const singleton = await this.singletonLockState(paths);
        if (singleton.kind === 'live') {
          await this.releaseRecord(paths, desired);
          throw new BrowserProfileBusyError(
            'chrome',
            `browser profile "${paths.identity}" is in use by Chrome pid ${singleton.pid}`,
          );
        }
        if (singleton.kind === 'unknown') {
          await this.releaseRecord(paths, desired);
          throw new BrowserProfileBusyError(
            'unknown',
            `browser profile "${paths.identity}" lock cannot be verified: ${singleton.detail}`,
          );
        }
        // Chrome is not running on the profile now, and nobody else holds it: its own preferences are set here, on
        // every lease, so a profile made before this rule gets it too. A profile that cannot be kept from saving
        // passwords is not handed out.
        try {
          await this.keepPasswordsUnsaved(paths);
        } catch {
          await this.releaseRecord(paths, desired);
          throw new BrowserControlError(
            'launch_failed',
            `Ferretry could not turn off password saving in the "${paths.identity}" browser profile, so it did not start the browser`,
          );
        }
        return this.lease(paths, desired, recoveredDeadOwner || singleton.kind === 'stale');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const current = await this.readLease(paths);
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
          `browser profile "${paths.identity}" is leased by session ${current.sessionId}`,
        );
      }
      // The owning daemon is gone. A Chrome it named is only ever stopped when the lease's own launch record (pid AND
      // start time) proves Ferretry started that very process; a recycled pid is cleared without a signal, and
      // anything unproven or unreadable is refused.
      let chromeCleared: number | undefined;
      if (current.chromePid && this.isProcessAlive(current.chromePid)) {
        const outcome = await clearRecordedChrome(
          this.orphans,
          {
            pid: current.chromePid,
            ...(current.chromeStartedAt === undefined ? {} : { startedAt: current.chromeStartedAt }),
          },
          paths.profile,
        );
        if (outcome === 'refused') {
          throw new BrowserProfileBusyError(
            'chrome',
            `browser profile "${paths.identity}" has a live orphaned Chrome pid ${current.chromePid}`,
          );
        }
        chromeCleared = current.chromePid;
      }
      await this.reclaimDeadLease(paths, current, chromeCleared);
      recoveredDeadOwner = true;
    }
  }

  async isPrimed(identity: string): Promise<boolean> {
    return isPrimedMarker(await this.readJson(this.paths(identity).primedFile, z.unknown()));
  }

  async assertChromeVersionCompatible(identity: string, runningChromeVersion: string): Promise<void> {
    const paths = this.paths(identity);
    const metadata = await this.readJson(paths.metadataFile, BrowserProfileMetadataSchema);
    const recorded = highestChromeVersion(metadata);
    if (!recorded || compareChromeVersions(runningChromeVersion, recorded) !== -1) return;
    throw new BrowserControlError(
      'launch_failed',
      `Chrome ${runningChromeVersion.slice(0, 160)} is older than the Chrome ${recorded.slice(0, 160)} that made the "${paths.identity}" profile`,
    );
  }

  private lease(
    paths: IdentityPaths,
    record: BrowserProfileLeaseRecord,
    recoveredDeadOwner: boolean,
  ): BrowserProfileLease {
    return {
      identity: paths.identity,
      profile: paths.profile,
      sessionId: record.sessionId,
      daemonPid: record.daemonPid,
      acquiredAt: record.acquiredAt,
      recoveredDeadOwner,
      updateChromePid: async (pid, version) => await this.updateChromePid(paths, record, pid, version),
      cleanupStaleChromeLocks: async () => await this.cleanupStaleChromeLocks(paths, record, recoveredDeadOwner),
      markPrimed: async version => await this.markPrimed(paths, record, version),
      release: async () => await this.release(paths, record),
    };
  }

  /** Forces Chrome's password saving off in the profile's `Default/Preferences`, keeping everything else in it. */
  private async keepPasswordsUnsaved(paths: IdentityPaths): Promise<void> {
    const directory = path.join(paths.profile, 'Default');
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

  private async ensureProfile(paths: IdentityPaths, chromeVersion?: string): Promise<void> {
    // The key grammar cannot prevent filesystem aliases. Check every directory we write through before creating
    // folders, changing permissions or publishing metadata/a lease, including Chrome's own preferences directory.
    for (const directory of [
      this.browserDirectory,
      path.dirname(paths.profile),
      paths.profile,
      path.join(paths.profile, 'Default'),
    ]) {
      const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (info?.isSymbolicLink()) {
        throw new BrowserControlError(
          'launch_failed',
          `browser profile "${paths.identity}" contains a symlinked directory`,
        );
      }
    }
    await mkdir(paths.profile, { recursive: true, mode: 0o700 });
    await chmod(this.browserDirectory, 0o700);
    await chmod(paths.profile, 0o700);
    if (!(await this.readJson(paths.metadataFile, BrowserProfileMetadataSchema)) && chromeVersion?.trim()) {
      await this.writeJson(paths.metadataFile, {
        createdChromeVersion: chromeVersion.trim(),
        createdAt: this.now().toISOString(),
      });
    }
  }

  private async updateChromePid(
    paths: IdentityPaths,
    expected: BrowserProfileLeaseRecord,
    chromePid?: number,
    chromeVersion?: string,
  ): Promise<void> {
    if (chromePid !== undefined && !isPositiveInteger(chromePid)) {
      throw new BrowserControlError('bad_request', 'browser Chrome pid must be a positive integer');
    }
    // The launch record that later proves this process is Ferretry's: its start time. It is read HERE, before the
    // first `await`, so it is the identity of the process the caller has just spawned (both callers report the pid
    // in the same synchronous step as the spawn) and never of a replacement that took the pid during the file work.
    const startedAt = chromePid === undefined ? undefined : this.orphans.identify(chromePid)?.startedAt;
    const current = await this.requireOwner(paths, expected);
    if (chromeVersion !== undefined) await this.recordChromeVersion(paths, chromeVersion);
    const { chromePid: _previousChromePid, chromeStartedAt: _previousStart, ...withoutChromePid } = current;
    const updated =
      chromePid === undefined
        ? withoutChromePid
        : { ...withoutChromePid, chromePid, ...(startedAt === undefined ? {} : { chromeStartedAt: startedAt }) };
    await this.writeJson(paths.leaseFile, updated);
  }

  private async markPrimed(
    paths: IdentityPaths,
    expected: BrowserProfileLeaseRecord,
    chromeVersion: string,
  ): Promise<void> {
    await this.requireOwner(paths, expected);
    const version = chromeVersion.trim();
    if (!version)
      throw new BrowserControlError('bad_request', 'the Chrome version used to prime the profile is required');
    const metadata = (await this.readJson(paths.metadataFile, BrowserProfileMetadataSchema)) ?? {};
    const previous = highestChromeVersion(metadata);
    const latestChromeVersion = previous && compareChromeVersions(version, previous) === -1 ? previous : version;
    const now = this.now().toISOString();
    await this.writeJson(paths.metadataFile, {
      ...metadata,
      ...(metadata.createdChromeVersion ? {} : { createdChromeVersion: version, createdAt: now }),
      primedChromeVersion: version,
      primedAt: now,
      latestChromeVersion,
      latestAt: now,
    });
    await this.writeJson(paths.primedFile, { version, primedAt: now });
  }

  private async recordChromeVersion(paths: IdentityPaths, chromeVersion: string): Promise<void> {
    const version = chromeVersion.trim();
    if (compareChromeVersions(version, version) === undefined) {
      throw new BrowserControlError(
        'launch_failed',
        `Chrome returned an unreadable version for the "${paths.identity}" profile`,
      );
    }
    const metadata = (await this.readJson(paths.metadataFile, BrowserProfileMetadataSchema)) ?? {};
    const previous = highestChromeVersion(metadata);
    if (previous && compareChromeVersions(version, previous) !== 1) return;
    await this.writeJson(paths.metadataFile, {
      ...metadata,
      latestChromeVersion: version,
      latestAt: this.now().toISOString(),
    });
  }

  private async cleanupStaleChromeLocks(
    paths: IdentityPaths,
    expected: BrowserProfileLeaseRecord,
    recoveredDeadOwner: boolean,
  ): Promise<readonly string[]> {
    await this.requireOwner(paths, expected);
    const singleton = await this.singletonLockState(paths);
    if (singleton.kind === 'live')
      throw new BrowserProfileBusyError(
        'chrome',
        `browser profile "${paths.identity}" is in use by Chrome pid ${singleton.pid}`,
      );
    if (singleton.kind === 'unknown')
      throw new BrowserProfileBusyError(
        'unknown',
        `browser profile "${paths.identity}" lock cannot be verified: ${singleton.detail}`,
      );
    if (singleton.kind !== 'stale' && !recoveredDeadOwner) return [];
    const removed: string[] = [];
    for (const name of staleChromeFiles) {
      try {
        await lstat(path.join(paths.profile, name));
        await rm(path.join(paths.profile, name));
        removed.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }

  private async release(paths: IdentityPaths, expected: BrowserProfileLeaseRecord): Promise<boolean> {
    const current = await this.readLease(paths);
    if (!current || !sameBrowserProfileLease(current, expected)) return false;
    await rm(paths.leaseFile, { force: true });
    return true;
  }

  private async requireOwner(
    paths: IdentityPaths,
    expected: BrowserProfileLeaseRecord,
  ): Promise<BrowserProfileLeaseRecord> {
    const current = await this.readLease(paths);
    if (current && sameBrowserProfileLease(current, expected)) return current;
    throw new BrowserProfileBusyError(
      'lease',
      `the "${paths.identity}" browser profile lease is no longer owned by this session`,
    );
  }

  private async reclaimDeadLease(
    paths: IdentityPaths,
    expected: BrowserProfileLeaseRecord,
    chromeCleared?: number,
  ): Promise<void> {
    // The owner record can be abandoned. Its cleanup must share the same mutex as publication and lease removal:
    // a check followed by unlink alone lets a delayed stale observer remove a successor's LIVE guard. This inode is
    // never unlinked; the kernel releases the lock even if a reclaimer dies between its owner check and its cleanup.
    const mutex = `${paths.reclaimFile}.mutex`;
    const handle = await open(
      mutex,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile())
        throw new BrowserProfileBusyError('unknown', 'browser profile reclaim mutex is not a regular file');
      while (!tryProfileReclaimLock(handle.fd, process.platform)) await this.sleep(10);
      const current = await lstat(mutex);
      if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino)
        throw new BrowserProfileBusyError('unknown', 'browser profile reclaim mutex changed while acquiring it');
      await this.reclaimDeadLeaseUnderLock(paths, expected, chromeCleared);
    } finally {
      await handle.close();
    }
  }

  private async reclaimDeadLeaseUnderLock(
    paths: IdentityPaths,
    expected: BrowserProfileLeaseRecord,
    chromeCleared?: number,
  ): Promise<void> {
    const guard = paths.reclaimFile;
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
      const current = await this.readLease(paths);
      if (!current || !sameBrowserProfileLease(current, expected)) return;
      const chromeLive =
        current.chromePid !== undefined &&
        current.chromePid !== chromeCleared &&
        this.isProcessAlive(current.chromePid);
      if (this.isProcessAlive(current.daemonPid) || chromeLive) return;
      await rm(paths.leaseFile, { force: true });
    } finally {
      await rm(guard, { force: true });
    }
  }

  private async singletonLockState(paths: IdentityPaths): Promise<SingletonLockState> {
    let target: string;
    try {
      target = await readlink(path.join(paths.profile, 'SingletonLock'));
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

  private async readLease(paths: IdentityPaths): Promise<BrowserProfileLeaseRecord | undefined> {
    const record = await this.readLeaseFile(paths.leaseFile);
    if (record !== undefined) return record;
    try {
      await readFile(paths.leaseFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    }
    throw new BrowserProfileBusyError(
      'unknown',
      `the "${paths.identity}" browser profile lease is malformed and cannot be safely reclaimed`,
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
    const temporary = `${file}.tmp.${this.daemonPid}.${crypto.randomUUID()}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`);
      } finally {
        await handle.close();
      }
      // Exclusive publication of a complete record. No reader can mistake a guard still being written for a crash.
      await link(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async releaseRecord(paths: IdentityPaths, record: BrowserProfileLeaseRecord): Promise<void> {
    const current = await this.readLease(paths);
    if (current && sameBrowserProfileLease(current, record)) await rm(paths.leaseFile, { force: true });
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
