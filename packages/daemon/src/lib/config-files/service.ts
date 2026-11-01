/**
 * This daemon's configuration files (docs/config-files.md): read, watched, put into effect file by file
 * with the last good version winning, and written by every editor through one door.
 *
 * ## One evaluation, many readers
 *
 * A load scans the directory and evaluates it (`@ferretry/fleet`'s `evaluateConfigFiles`): a broken
 * file is reported and its last good version stays in effect, and an edit that loosens spend or
 * authority waits for the owner.
 *
 * Every reader on a timer — the fleet catalogue, the provider presets and model catalogs, the Warden,
 * Learning — reads {@link ConfigFilesService.inEffect}, which answers the LAST load and loads only
 * when nothing has yet or the tree has reported a change. It used to load on every read: each one listed
 * the whole tree, read and checked
 * every file and evaluated them again, several times a second on a busy machine, for a directory that
 * changes when a person saves a file. What moves the configuration is a short list, and each of them
 * loads: the watcher on a change it sees (file events, with a slow backstop for one the platform lost),
 * this daemon's own writes and confirmations, and the first read. A file event marks the last load
 * stale at once, before the watcher's debounce, so the next reader loads; concurrent readers join one
 * load. A decision about authority — an agent-control switch, Pack mode's limits — still calls
 * {@link ConfigFilesService.load}, because "in effect the moment it is saved" cannot wait for an event.
 *
 * ## The accepted record
 *
 * What is in effect is remembered in the state home, file by file, with its text — so the last good
 * version of a file survives a restart, and a loosening confirmed once is not asked about again. It is
 * the daemon's record, not a configuration: nothing edits it but this service.
 *
 * ## Writing
 *
 * - A write the daemon makes on the owner's behalf (a reviewed fleet change, the Warden settings form)
 *   is ACKNOWLEDGED before it lands: its text is recorded as accepted first, so the watcher never
 *   mistakes the owner's own act for an unconfirmed loosening.
 * - A write from an editor (`PUT /v1/config/file`, an agent's `config.write`) is validated first and
 *   refused whole if it does not check. A loosening is acknowledged only when the caller may confirm
 *   it in the same act; otherwise the file is written and the edit waits, the tighter version in effect.
 *
 * Every load and every write runs one at a time, so two of them can never each decide against a record
 * the other is about to replace.
 */

import {
  ABSENT_CONFIG_ETAG,
  type AcceptedConfigFiles,
  CONFIG_FILE_STARTERS,
  type ConfigEvaluation,
  type ConfigFileText,
  checkConfigFile,
  type Credential,
  configLoosening,
  evaluateConfigFiles,
  loginLoosening,
  type Runtime,
  runtimeLoosening,
  SINGLETON_DEFAULTS,
  type SingletonKind,
} from '@ferretry/fleet';
import {
  CONFIG_SCHEMA_DIRECTORY,
  type ConfigFileAddress,
  type ConfigFileView,
  type ConfigIssue,
  type ConfigPending,
  type ConfigStatusView,
  classifyConfigPath,
  configChangeKindsForPaths,
  configSchemaId,
  configSchemaModeline,
} from '@ferretry/protocol';
import { type ConfigChangeSink, changedConfigPaths } from './changes.ts';

/** The configuration directory, as this service needs it. */
export interface ConfigDirectoryPort {
  /** The directory, absolute. */
  readonly directory: string;
  /**
   * Every `.yaml` and `.yml` file under it, by path relative to it, the schema directory excluded —
   * read when it is an ordinary file of a sensible size, otherwise named in `unreadable`.
   */
  list(): Promise<{ readonly files: readonly ConfigFileText[]; readonly unreadable: readonly string[] }>;
  /** A value that changes whenever any file under the directory does; what the watcher polls. */
  fingerprint(): Promise<string>;
  /** One file's text, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Write one file atomically, owner-only, creating its directory. */
  write(path: string, text: string): Promise<void>;
  /** Remove one file; a file already gone is no error. */
  remove(path: string): Promise<void>;
  /** Replace the JSON Schemas editors read, by schema id. */
  writeSchemas(schemas: ReadonlyMap<string, string>): Promise<void>;
}

/** The accepted record, in the state home. */
export interface AcceptedConfigStore {
  read(): Promise<AcceptedConfigFiles>;
  write(accepted: AcceptedConfigFiles): Promise<void>;
}

/** Where what the owner must know is said when nobody is looking: the daemon log. */
interface ConfigFilesLog {
  issue(issue: ConfigIssue): void;
  pending(pending: ConfigPending): void;
}

export interface ConfigFilesServiceDeps {
  readonly directory: ConfigDirectoryPort;
  readonly accepted: AcceptedConfigStore;
  readonly log: ConfigFilesLog;
  /** sha256 of the text's UTF-8 bytes, hex: the provisioner's revision, so a file's etag is its revision. */
  digest(text: string): string;
  now(): Date;
  /** Told the kinds a load found changed since the last load. Absent, nobody is told. */
  readonly changes?: ConfigChangeSink;
}

/** A refused edit, with every located reason. */
export class ConfigFileInvalidError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      `the file does not check: ${issues
        .filter(issue => issue.severity === 'error')
        .map(issue => `${issue.path}${issue.line === undefined ? '' : `:${String(issue.line)}`} ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'ConfigFileInvalidError';
  }
}

/** An edit made against a version of the file that is no longer there. */
export class ConfigFileConflictError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed since it was read; read it again and redo the edit`);
    this.name = 'ConfigFileConflictError';
  }
}

/** One load: the evaluation, and the texts it was made from. */
export interface ConfigSnapshot {
  readonly evaluation: ConfigEvaluation;
  /** Every file found, by path, with its etag. */
  readonly files: ReadonlyMap<string, { readonly text: string; readonly etag: string }>;
  /** Every file found and not read (a link, or too large). */
  readonly unreadable: readonly string[];
  readonly at: Date;
}

/** What a write did. */
export interface ConfigWriteOutcome {
  readonly etag: string;
  readonly outcome: 'applied' | 'pending';
  /** Whether the write put a loosening into effect — what spends a passkey proved for the act. */
  readonly loosened: boolean;
  readonly pending?: ConfigPending;
}

/** How long an acknowledged write may take to land before the acknowledgement lapses. */
export const ACKNOWLEDGEMENT_TTL_MS = 10 * 60_000;

const issueKey = (issue: ConfigIssue): string =>
  `${issue.path}\u0000${String(issue.line)}\u0000${String(issue.column)}\u0000${issue.message}`;

const isSingletonAddress = (address: ConfigFileAddress): address is { readonly kind: SingletonKind } =>
  address.kind in SINGLETON_DEFAULTS;

export class ConfigFilesService {
  #queue: Promise<unknown> = Promise.resolve();
  #snapshot: ConfigSnapshot | undefined;
  /** The last snapshot a LOAD made — never the empty stand-in `current` answers before one — so a
   *  change is always judged against something that was actually read. */
  #loaded: ConfigSnapshot | undefined;
  /** The load the readers are waiting on, so they share one instead of queueing one each. */
  #reloading: Promise<ConfigSnapshot> | undefined;
  /** Whether the tree reported a change after the last load began. */
  #changed = false;
  /** What the log has already been told, so a broken file is reported once, not on every read. */
  #reported = new Set<string>();
  /**
   * Texts the daemon is about to write on the owner's behalf, by path. Held here rather than in the
   * accepted record because the write lands AFTER the acknowledgement — through the provisioner, for a
   * fleet change — and a load in between would read the record's entry for a file that is not there
   * yet as a deletion. One is consumed by the first load that finds exactly those bytes on disk.
   */
  #acknowledged = new Map<string, { readonly etag: string; readonly text: string; readonly at: number }>();
  /** Removals the daemon makes on the owner's behalf, by path, with when: in effect once the file is gone. */
  #acknowledgedRemovals = new Map<string, number>();

  #warnings: ((snapshot: ConfigSnapshot) => Promise<readonly ConfigIssue[]>) | undefined;

  constructor(private readonly deps: ConfigFilesServiceDeps) {}

  /**
   * Findings only the daemon can make — a default account that names an account this machine does not have —
   * added to {@link status} as warnings. Set once at the composition root, after the services it reads exist.
   */
  warnWith(source: (snapshot: ConfigSnapshot) => Promise<readonly ConfigIssue[]>): void {
    this.#warnings = source;
  }

  /** Run `work` after every load and write already queued, and before any queued after it. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Scan, evaluate, remember: what the watcher runs on a change, and what a caller about to edit a file
   * reads so it starts from the bytes on disk. A reader that only wants the configuration in effect
   * reads {@link inEffect}.
   */
  async load(): Promise<ConfigSnapshot> {
    return await this.#serial(async () => await this.#load());
  }

  /**
   * The configuration in effect: the last load's, without touching the directory. Loads first only
   * when nothing has loaded yet or the tree has reported a change since ({@link invalidate}), and
   * every reader that arrives meanwhile waits on that one load.
   */
  async inEffect(): Promise<ConfigSnapshot> {
    if (this.#loaded !== undefined && !this.#changed) return this.#loaded;
    this.#reloading ??= this.load().finally(() => {
      this.#reloading = undefined;
    });
    return await this.#reloading;
  }

  /** The tree may have changed: the next {@link inEffect} loads rather than answering the last load. */
  invalidate(): void {
    this.#changed = true;
  }

  /**
   * The last load, for a reader that cannot wait (a sync config getter). Before the first load it is
   * the configuration of an empty directory — every setting at its default, which is the safe
   * direction: nothing loosened is in effect until a load has judged it.
   */
  current(): ConfigSnapshot {
    this.#snapshot ??= {
      evaluation: evaluateConfigFiles({ files: [], accepted: {}, digest: text => this.deps.digest(text) }),
      files: new Map(),
      unreadable: [],
      at: this.deps.now(),
    };
    return this.#snapshot;
  }

  async #load(): Promise<ConfigSnapshot> {
    // Cleared BEFORE the scan, so a change reported while it runs makes the next reader load again.
    this.#changed = false;
    const { files, unreadable } = await this.deps.directory.list();
    const stored = await this.deps.accepted.read();
    const accepted = { ...stored };
    const now = this.deps.now().getTime();
    for (const [path, acknowledged] of this.#acknowledged) {
      const disk = files.find(file => file.path === path);
      if (disk !== undefined && this.deps.digest(disk.text) === acknowledged.etag) {
        accepted[path] = { etag: acknowledged.etag, text: acknowledged.text };
        this.#acknowledged.delete(path);
      } else if (now - acknowledged.at > ACKNOWLEDGEMENT_TTL_MS) {
        // A write that never landed: its apply was refused or rolled back.
        this.#acknowledged.delete(path);
      }
    }
    for (const [path, at] of this.#acknowledgedRemovals) {
      if (!files.some(file => file.path === path)) {
        delete accepted[path];
        this.#acknowledgedRemovals.delete(path);
      } else if (now - at > ACKNOWLEDGEMENT_TTL_MS) this.#acknowledgedRemovals.delete(path);
    }
    const evaluation = evaluateConfigFiles({ files, unreadable, accepted, digest: text => this.deps.digest(text) });
    if (JSON.stringify(evaluation.accepted) !== JSON.stringify(stored)) {
      await this.deps.accepted.write(evaluation.accepted);
    }
    this.#report(evaluation);
    const snapshot: ConfigSnapshot = {
      evaluation,
      files: new Map(files.map(file => [file.path, { text: file.text, etag: this.deps.digest(file.text) }])),
      unreadable,
      at: this.deps.now(),
    };
    this.#snapshot = snapshot;
    this.#announce(this.#loaded, snapshot);
    this.#loaded = snapshot;
    return snapshot;
  }

  /**
   * Tell the change sink what this load found different from the last one. The first load is the
   * baseline, not a change: there is nothing a reader could have read before it.
   */
  #announce(previous: ConfigSnapshot | undefined, next: ConfigSnapshot): void {
    if (previous === undefined || this.deps.changes === undefined) return;
    const paths = changedConfigPaths(previous, next);
    if (paths.length > 0) this.deps.changes.announce(configChangeKindsForPaths(paths));
  }

  /** Tell the log about every issue and held edit it has not been told about yet. */
  #report(evaluation: ConfigEvaluation): void {
    const seen = new Set<string>();
    for (const issue of evaluation.issues) {
      const key = issueKey(issue);
      seen.add(key);
      if (!this.#reported.has(key)) this.deps.log.issue(issue);
    }
    for (const pending of evaluation.pending) {
      const key = `pending\u0000${pending.path}\u0000${pending.etag}`;
      seen.add(key);
      if (!this.#reported.has(key)) this.deps.log.pending(pending);
    }
    this.#reported = seen;
  }

  /** What the watcher polls: changes whenever any file under the directory does. */
  async fingerprint(): Promise<string> {
    return await this.deps.directory.fingerprint();
  }

  /** Write the JSON Schemas editors read, so every file's modeline resolves. */
  async publishSchemas(schemas: ReadonlyMap<string, string>): Promise<void> {
    await this.deps.directory.writeSchemas(schemas);
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────────

  /** `GET /v1/config/status`. */
  async status(): Promise<ConfigStatusView> {
    const snapshot = await this.load();
    const { evaluation, at } = snapshot;
    const extra = await this.#warnings?.(snapshot).catch(() => []);
    return {
      directory: this.deps.directory.directory,
      files: [...evaluation.files],
      issues: [...evaluation.issues, ...(extra ?? [])],
      pending: [...evaluation.pending],
      checkedAt: at.toISOString(),
    };
  }

  /** `GET /v1/config/file?path=`: the file on disk, or the starter a new file of its kind begins with. */
  async file(path: string): Promise<ConfigFileView> {
    const address = this.#address(path);
    const { evaluation, files } = await this.load();
    const disk = files.get(path);
    const schema = configSchemaId(address);
    return {
      path,
      absolutePath: `${this.deps.directory.directory}/${path}`,
      kind: address.kind,
      schema,
      exists: disk !== undefined,
      text: disk?.text ?? `${configSchemaModeline(address)}\n${CONFIG_FILE_STARTERS[schema]}`,
      etag: disk?.etag ?? ABSENT_CONFIG_ETAG,
      state: evaluation.files.find(file => file.path === path)?.state ?? 'ok',
      issues: evaluation.issues.filter(issue => issue.path === path),
    };
  }

  #address(path: string): ConfigFileAddress {
    const address = classifyConfigPath(path);
    if (address === undefined || path.startsWith(`${CONFIG_SCHEMA_DIRECTORY}/`)) {
      throw new ConfigFileInvalidError([
        {
          path,
          severity: 'error',
          message: 'Ferretry does not read this file',
          fix: 'name a Ferretry configuration file',
        },
      ]);
    }
    return address;
  }

  /**
   * Check `text` as if it were `path`, the rest of the directory as it is — so a profile naming a
   * component that is not there is caught before it is written. Writes nothing.
   */
  async validate(path: string, text: string): Promise<readonly ConfigIssue[]> {
    this.#address(path);
    const { files, unreadable, evaluation } = await this.load();
    const trial = evaluateConfigFiles({
      files: [
        ...[...files.entries()]
          .filter(([name]) => name !== path)
          .map(([name, file]) => ({ path: name, text: file.text })),
        { path, text },
      ],
      unreadable: unreadable.filter(name => name !== path),
      accepted: evaluation.accepted,
      digest: candidate => this.deps.digest(candidate),
    });
    // Only this file's own issues: a write is never blocked by a different file that is broken now.
    return trial.issues.filter(issue => issue.path === path);
  }

  // ── Writing ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Accept `text` for `path` before the daemon writes it on the owner's behalf: the first load that
   * finds exactly those bytes there puts them into effect without a hold. An acknowledgement whose write
   * never lands is harmless — it is accepted only if those exact bytes appear — and lapses after
   * {@link ACKNOWLEDGEMENT_TTL_MS}.
   */
  acknowledge(path: string, text: string): void {
    this.#acknowledged.set(path, { etag: this.deps.digest(text), text, at: this.deps.now().getTime() });
  }

  /**
   * The removal of `path` is the owner's own reviewed act (a `fy login rm`, a runtime removed): once the file
   * is gone it is out of effect at once, rather than held as an unconfirmed loosening. A removal that never
   * lands lapses like an acknowledged write.
   */
  acknowledgeRemoval(path: string): void {
    this.#acknowledgedRemovals.set(path, this.deps.now().getTime());
  }

  /**
   * Write a file the daemon owns the decision for (the Warden form): acknowledged, then written.
   *
   * `inEffect` is for a file with an edit held for the owner: the owner's change is made to BOTH
   * versions, so `text` (the held edit, changed) is written and `inEffect` (the version in effect,
   * changed) is recorded as accepted. The owner's act is in effect at once, and the held edit is still
   * held — judged against the new record by the load — rather than discarded by a save that never
   * mentioned it, or put into effect by one that never confirmed it.
   */
  async writeOwn(path: string, text: string, inEffect: string = text): Promise<void> {
    await this.#serial(async () => {
      if (inEffect === text) this.acknowledge(path, text);
      else {
        const accepted = { ...(await this.deps.accepted.read()) };
        accepted[path] = { etag: this.deps.digest(inEffect), text: inEffect };
        await this.deps.accepted.write(accepted);
      }
      await this.deps.directory.write(path, text);
      await this.#load();
    });
  }

  /**
   * The owner's own act changed what is in effect for a file and nothing on disk: record `inEffect` as accepted and
   * leave the file alone. For a file that is absent (its deletion held) or does not check (the owner is still fixing
   * it), where an owner act must still take effect but there is no text of it to write.
   */
  async acceptOwn(path: string, inEffect: string): Promise<void> {
    await this.#serial(async () => {
      const accepted = { ...(await this.deps.accepted.read()) };
      accepted[path] = { etag: this.deps.digest(inEffect), text: inEffect };
      await this.deps.accepted.write(accepted);
      await this.#load();
    });
  }

  /**
   * An editor's write: refused unless it checks, refused if the file moved since `ifMatch`, and — when
   * it loosens — in effect now only if `mayLoosen`, otherwise written and held for confirmation.
   */
  async write(
    path: string,
    text: string,
    ifMatch: string | undefined,
    mayLoosen: boolean,
  ): Promise<ConfigWriteOutcome> {
    const address = this.#address(path);
    const issues = await this.validate(path, text);
    if (issues.some(issue => issue.severity === 'error')) throw new ConfigFileInvalidError(issues);
    return await this.#serial(async () => {
      const disk = await this.deps.directory.read(path);
      const found = disk === undefined ? ABSENT_CONFIG_ETAG : this.deps.digest(disk);
      if (ifMatch !== undefined && ifMatch !== found) throw new ConfigFileConflictError(path);
      const etag = this.deps.digest(text);
      const loosening = isSingletonAddress(address)
        ? this.#loosening(address.kind, path, text)
        : address.kind === 'login'
          ? this.#loginLoosening(address.name, path, text)
          : address.kind === 'runtime'
            ? this.#runtimeLoosening(address.name, path, text)
            : [];
      if (loosening.length === 0 || mayLoosen) this.acknowledge(path, text);
      await this.deps.directory.write(path, text);
      const snapshot = await this.#load();
      const pending = snapshot.evaluation.pending.find(item => item.path === path && item.etag === etag);
      return pending === undefined
        ? { etag, outcome: 'applied', loosened: loosening.length > 0 }
        : { etag, outcome: 'pending', loosened: false, pending };
    });
  }

  /** What putting `text` into effect for a singleton would loosen, against what is in effect now. */
  #loosening(kind: SingletonKind, path: string, text: string): readonly string[] {
    const checked = checkConfigFile(path, text);
    // Already validated by the caller; a file that does not check loosens nothing because it is refused.
    if (!checked.ok) return [];
    const effective = this.current().evaluation.effective;
    const before =
      kind === 'machine' ? { machine: effective.model.machine, advanced: effective.model.advanced } : effective[kind];
    return configLoosening(kind, before as never, checked.value as never);
  }

  /** What putting `text` into effect for login `id` would loosen in its budget, against what is in effect now. */
  #loginLoosening(id: string, path: string, text: string): readonly string[] {
    const checked = checkConfigFile(path, text);
    if (!checked.ok) return [];
    const before = this.current().evaluation.effective.model.credentials[id];
    return loginLoosening(id, before, checked.value as Credential);
  }

  /** What putting `text` into effect for runtime `name` would loosen: leaving a login with a budget in effect. */
  #runtimeLoosening(name: string, path: string, text: string): readonly string[] {
    const checked = checkConfigFile(path, text);
    if (!checked.ok) return [];
    const model = this.current().evaluation.effective.model;
    return runtimeLoosening(
      name,
      model.runtimes[name],
      checked.value as Runtime,
      login => model.credentials[login]?.budget !== undefined,
    );
  }

  /**
   * Confirm ONE held edit, named by the etag that was reviewed. `false` when there is no such held
   * edit any more — the file moved on, or it was confirmed already — so a confirmation can never put
   * into effect an edit nobody saw.
   */
  async confirm(path: string, etag: string): Promise<boolean> {
    return await this.#serial(async () => {
      const snapshot = await this.#load();
      const held = snapshot.evaluation.pending.find(item => item.path === path && item.etag === etag);
      if (held === undefined) return false;
      const accepted = { ...(await this.deps.accepted.read()) };
      const disk = snapshot.files.get(path);
      if (disk === undefined) delete accepted[path];
      else accepted[path] = { etag: disk.etag, text: disk.text };
      await this.deps.accepted.write(accepted);
      await this.#load();
      return true;
    });
  }

  /**
   * Drop ONE held edit, named by the etag that was reviewed: the file goes back to the version in effect —
   * its accepted text written over it, or, for a new file that was never in effect, the file removed (its
   * defaults are what is in effect). Answers `false`, touching nothing, when there is no such held edit any
   * more, so a discard can never drop an edit nobody saw. Discarding only ever tightens.
   */
  async discard(path: string, etag: string): Promise<boolean> {
    return await this.#serial(async () => {
      const snapshot = await this.#load();
      const held = snapshot.evaluation.pending.find(item => item.path === path && item.etag === etag);
      if (held === undefined) return false;
      const inEffect = snapshot.evaluation.accepted[path];
      if (inEffect === undefined) await this.deps.directory.remove(path);
      else {
        this.acknowledge(path, inEffect.text);
        await this.deps.directory.write(path, inEffect.text);
      }
      await this.#load();
      return true;
    });
  }
}
