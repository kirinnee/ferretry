/**
 * THE FLEET READING, KEPT CURRENT BY EVENTS (docs/design/housekeeping-worker.md §3, §4 PR 3).
 *
 * The fleet refresh used to re-read everything on a timer: every credential's store, every statusLine
 * file, every attributed rollout, every interval, whether or not any of them had changed. Now each input
 * is watched through the file-event hub and read only when it changes, and the timer is armed for the
 * one thing only time changes — a credential's active free read, due once its newest measured passive
 * reading is one interval old (the rule is unchanged; `model.ts` turns it into instants).
 *
 * - **Passive readings.** A Claude credential's `usage.json`, which `fy statusline` renames into place
 *   every few seconds while a session runs, and a Codex credential's attributed rollouts. A change is
 *   ONE passive job for that credential — coalesced, so a burst is one read in flight and one after — and
 *   the new reading pushes its credential's due time back. **It never starts a pass, never reads a store
 *   and never asks a provider.** The status service asks {@link passiveUsage} and is answered from here.
 * - **Store files.** Each credential's `.credentials.json` or canonical `auth.json`. A change bumps the
 *   file's generation, which is the stamp {@link stamp} answers while the watch is live, and re-reads
 *   the store's facts at once through main's kept facts. While nothing changes, deciding a view costs no
 *   system call at all.
 * - **Configuration.** {@link configLoaded}, from the config watcher's `afterLoad`: credentials added or
 *   removed open or close their watches.
 * - **Sessions.** Which rollouts are a Codex credential's comes from every session's config, read through
 *   the shared {@link SessionRosterReader}: once per roster generation, however many logins ask. A
 *   credential's rollout watch is re-derived only when the generation it was derived from has moved on.
 *
 * The boot pass always runs, as it did at boot before; and a feed with a source only time refreshes — an
 * external collector — keeps one pass an interval, whatever the credentials say.
 *
 * A WATCH THAT IS NOT LIVE IS NEVER TRUSTED. Where the hub polls a directory — a name the platform does
 * not report, a watch that failed — or a read has not finished yet, the answer is read directly, exactly
 * as before; and the due time counts a passive reading only once it is current, so it errs early, never
 * late. Correctness never depends on an event arriving; only how little is read does.
 */
import type { CredentialSubject, PassiveUsageRecord, StoredCredentialResolution } from '@ferretry/fleet';
import type { FileSubscription } from '../file-events/hub.ts';
import { attributedTranscripts } from '../fleet/credentials-service.ts';
import type { HousekeepingJobs } from '../housekeeping/ports.ts';
import {
  dueCredentials,
  EMPTY_FLEET_READING,
  type FleetReadingState,
  nextDueAt,
  readingFor,
  withObserved,
  withPassive,
  withPassiveUnknown,
} from './model.ts';
import type { SessionRosterReader, SessionRosterSnapshot } from './session-roster.ts';

/** One stored credential, as the reading watches it. */
export interface FleetReadingSubject {
  readonly id: string;
  readonly resolution: StoredCredentialResolution;
  /** The runtimes on it: whose sessions' rollouts are a Codex credential's passive readings. */
  readonly usedBy: readonly string[];
}

/** The timers the reading arms. */
export interface FleetReadingTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FleetReadingPorts {
  /** The stored credentials the configuration in effect names. */
  credentials(): Promise<readonly FleetReadingSubject[]>;
  /** The sessions this daemon has records for: where a Codex credential's rollouts are. Shared, kept. */
  readonly roster: SessionRosterReader;
  readonly jobs: HousekeepingJobs;
  /** Hear when a file may have changed (`FileEventHub.subscribe`): once at first, then on each change. */
  watch(path: string, listener: () => void): FileSubscription;
  /** A Claude credential's statusLine file. */
  passiveFile(id: string): string;
  /** Read a changed store's facts into main's kept facts. */
  refreshLocal(resolution: StoredCredentialResolution): Promise<void>;
  /** A file's own stamp, for a store file no live watch covers. */
  stamp(path: string): Promise<string | undefined>;
  now(): number;
  /** The usage interval: how old a passive reading may be before the active read is due. */
  intervalMs(): number;
  /**
   * Whether the usage feed has a source only time can refresh — an external collector (`usage.url`) —
   * so a pass is due at least once an interval whatever the credentials say, as the fixed timer had it.
   */
  pollsFeed(): boolean;
  readonly timers: FleetReadingTimers;
}

/** One credential's passive watch: the files it covers, and its one read in flight. */
interface PassiveWatch {
  readonly harness: StoredCredentialResolution['harness'];
  readonly files: readonly string[];
  readonly subscriptions: readonly FileSubscription[];
  running: boolean;
  again: boolean;
}

/** One store file's watch, the count of changes it has seen, and its one re-read in flight. */
interface StoreWatch {
  readonly resolution: StoredCredentialResolution;
  readonly subscription: FileSubscription;
  generation: number;
  running: boolean;
  again: boolean;
}

/** The file whose change means a store may have changed: what `CachedCredentialReads` stamps. */
const storeFile = (resolution: StoredCredentialResolution): string =>
  resolution.harness === 'claude' ? resolution.credentialFile : resolution.canonicalFile;

const sameFiles = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((file, index) => file === right[index]);

export class FleetReading {
  #state: FleetReadingState = EMPTY_FLEET_READING;
  readonly #subjects = new Map<string, FleetReadingSubject>();
  readonly #passive = new Map<string, PassiveWatch>();
  readonly #stores = new Map<string, StoreWatch>();
  /** The roster generation each Codex credential's rollout watch was last derived from. */
  readonly #derived = new Map<string, number>();
  #timer: unknown;
  #due: (() => void) | undefined;
  /** When the last pass finished; until the first, the boot pass is due. */
  #lastPass: number | undefined;
  #closed = false;

  constructor(private readonly ports: FleetReadingPorts) {}

  /** Opens every watch and arms the due timer; `due` is called whenever a credential's active read is due. */
  async start(due: () => void): Promise<void> {
    this.#due = due;
    await this.configLoaded();
  }

  /**
   * The configuration was (re)loaded: open the watches of credentials it added, close those of credentials
   * it removed. A configuration that cannot be read — or a machine with no account model at all — keeps the
   * watches it had, and the passes that are due without any credential still run.
   */
  async configLoaded(): Promise<void> {
    let subjects: readonly FleetReadingSubject[];
    try {
      subjects = await this.ports.credentials();
    } catch {
      this.#reschedule();
      return;
    }
    if (this.#closed) return;
    const ids = new Set(subjects.map(subject => subject.id));
    for (const id of [...this.#passive.keys()]) if (!ids.has(id)) this.#closePassive(id);
    for (const id of [...this.#derived.keys()]) if (!ids.has(id)) this.#derived.delete(id);
    const files = new Set(subjects.map(subject => storeFile(subject.resolution)));
    for (const [path, watch] of [...this.#stores]) {
      if (files.has(path)) continue;
      watch.subscription.close();
      this.#stores.delete(path);
    }
    this.#subjects.clear();
    for (const subject of subjects) {
      this.#subjects.set(subject.id, subject);
      const path = storeFile(subject.resolution);
      if (!this.#stores.has(path)) this.#watchStore(path, subject.resolution);
    }
    this.#state = readingFor(
      this.#state,
      subjects.map(subject => subject.id),
    );
    for (const subject of subjects) await this.#watchPassive(subject);
    this.#reschedule();
  }

  /**
   * A credential's newest passive reading: from its live watch when that has a current reading, read
   * directly otherwise. The status service's `passiveUsage` port.
   */
  async passiveUsage(subject: CredentialSubject): Promise<PassiveUsageRecord | undefined> {
    const known = this.#subjects.get(subject.id);
    if (known === undefined) return await this.#readDirect(subject);
    if (known.resolution.harness === 'codex') {
      // One roster read for every login that asks while it holds; re-derived only on a new generation.
      const roster = await this.ports.roster.current();
      if (this.#derived.get(known.id) !== roster.generation) await this.#watchPassive(known, roster);
    }
    const watch = this.#passive.get(subject.id);
    const reading = this.#state.get(subject.id);
    if (watch !== undefined && reading?.passiveKnown === true && watch.subscriptions.every(open => open.live()))
      return reading.passive;
    return await this.#readDirect(subject);
  }

  /**
   * A store file's stamp for `CachedCredentialReads`: while a live watch covers it, the count of changes
   * that watch has seen — so an unchanged store costs no system call — and the file's own stamp otherwise.
   */
  async stamp(path: string): Promise<string | undefined> {
    const watch = this.#stores.get(path);
    if (watch?.subscription.live() === true) return `watched:${String(watch.generation)}`;
    return await this.ports.stamp(path);
  }

  /** The credentials due their active read now. */
  due(): readonly string[] {
    return dueCredentials(this.#state, this.ports.now(), this.ports.intervalMs());
  }

  /** A pass observed `ids`: each one's next due time moves on from now. */
  observed(ids: readonly string[]): void {
    this.#lastPass = this.ports.now();
    this.#state = withObserved(this.#state, ids, this.#lastPass);
    this.#reschedule();
  }

  /** Closes every watch and the timer. */
  close(): void {
    this.#closed = true;
    this.#disarm();
    for (const id of [...this.#passive.keys()]) this.#closePassive(id);
    for (const watch of this.#stores.values()) watch.subscription.close();
    this.#stores.clear();
  }

  /** The files a subject's passive reading comes from: its statusLine file, or its attributed rollouts. */
  async #passiveFiles(subject: FleetReadingSubject, roster?: SessionRosterSnapshot): Promise<readonly string[]> {
    if (subject.resolution.harness === 'claude') return [this.ports.passiveFile(subject.id)];
    const sessions = roster ?? (await this.ports.roster.current());
    this.#derived.set(subject.id, sessions.generation);
    return attributedTranscripts(subject, sessions.sessions);
  }

  /** Opens, or re-opens on a changed file set, a subject's passive watch. */
  async #watchPassive(subject: FleetReadingSubject, roster?: SessionRosterSnapshot): Promise<void> {
    const files = await this.#passiveFiles(subject, roster);
    const current = this.#passive.get(subject.id);
    if (this.#closed || (current !== undefined && sameFiles(current.files, files))) return;
    this.#closePassive(subject.id);
    if (files.length === 0) {
      this.#state = withPassive(this.#state, subject.id, undefined);
      return;
    }
    const watch: PassiveWatch = {
      harness: subject.resolution.harness,
      files,
      subscriptions: files.map(file => this.ports.watch(file, () => void this.#passiveChanged(subject.id, watch))),
      running: false,
      again: false,
    };
    this.#passive.set(subject.id, watch);
    // The hub reports a new subscription only at its directory's next check, which a quiet directory may
    // never have — so the first read is this one, through the same one-in-flight path a change takes.
    void this.#passiveChanged(subject.id, watch);
  }

  #closePassive(id: string): void {
    const watch = this.#passive.get(id);
    if (watch === undefined) return;
    this.#passive.delete(id);
    for (const subscription of watch.subscriptions) subscription.close();
    this.#state = withPassiveUnknown(this.#state, id);
  }

  /** One passive file changed: ONE read for the credential in flight, one more after it if needed. */
  async #passiveChanged(id: string, watch: PassiveWatch): Promise<void> {
    if (watch.running) {
      watch.again = true;
      return;
    }
    watch.running = true;
    try {
      do {
        watch.again = false;
        const reading = await this.#readFiles(id, watch.harness, watch.files);
        if (this.#passive.get(id) !== watch) return;
        this.#state = withPassive(this.#state, id, reading);
      } while (watch.again);
    } catch {
      if (this.#passive.get(id) === watch) this.#state = withPassiveUnknown(this.#state, id);
    } finally {
      watch.running = false;
      this.#reschedule();
    }
  }

  async #readFiles(
    id: string,
    harness: StoredCredentialResolution['harness'],
    files: readonly string[],
  ): Promise<PassiveUsageRecord | undefined> {
    const reading =
      harness === 'claude'
        ? await this.ports.jobs.run({ kind: 'usage.passive.claude', credential: id })
        : await this.ports.jobs.run({ kind: 'usage.passive.codex', files });
    return reading ?? undefined;
  }

  /** The reading with no watch to answer from: one read, as every pass made before. */
  async #readDirect(subject: CredentialSubject): Promise<PassiveUsageRecord | undefined> {
    const known = this.#subjects.get(subject.id);
    if (subject.resolution.harness === 'claude') return await this.#readFiles(subject.id, 'claude', []);
    const files = known === undefined ? [] : await this.#passiveFiles(known);
    return files.length === 0 ? undefined : await this.#readFiles(subject.id, 'codex', files);
  }

  #watchStore(path: string, resolution: StoredCredentialResolution): void {
    const watch: StoreWatch = {
      resolution,
      subscription: this.ports.watch(path, () => void this.#storeChanged(watch)),
      generation: 0,
      running: false,
      again: false,
    };
    this.#stores.set(path, watch);
  }

  /** A store file changed: its stamp moves on, and its facts are read again at once — one read in flight. */
  async #storeChanged(watch: StoreWatch): Promise<void> {
    watch.generation += 1;
    if (watch.running) {
      watch.again = true;
      return;
    }
    watch.running = true;
    try {
      do {
        watch.again = false;
        await this.ports.refreshLocal(watch.resolution);
      } while (watch.again && !this.#closed);
    } catch {
      // The next read through the kept facts sees the new generation and reads again.
    } finally {
      watch.running = false;
    }
  }

  /** Arms the timer for the earliest due credential, replacing any timer armed before. */
  #reschedule(): void {
    this.#disarm();
    const due = this.#due;
    if (this.#closed || due === undefined) return;
    const intervalMs = this.ports.intervalMs();
    const pass =
      this.#lastPass === undefined
        ? Number.NEGATIVE_INFINITY
        : this.ports.pollsFeed()
          ? this.#lastPass + intervalMs
          : undefined;
    const credential = nextDueAt(this.#state, intervalMs);
    const candidates = [pass, credential].filter((due): due is number => due !== undefined);
    if (candidates.length === 0) return;
    const next = Math.min(...candidates);
    this.#timer = this.ports.timers.setTimeout(
      () => {
        this.#timer = undefined;
        due();
      },
      Math.max(0, next - this.ports.now()),
    );
  }

  #disarm(): void {
    if (this.#timer !== undefined) this.ports.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
