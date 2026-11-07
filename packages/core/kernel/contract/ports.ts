import type { SecretsPort } from './secrets.ts';
import type { Duration, Instant, Result } from '@ferretry/std';
import type { ActRunner, OpaqueId } from './act.ts';
import type { ChildEnvironment, FencedPath, FolderRefusal, Redaction } from './bound.ts';
import type { ConfigCollectionDef, ConfigFileDef, EventDef, StateFileDef } from './define.ts';
import type { FerretId } from './ids.ts';
import type { HeldRoot, PinnedWorkingDirectory, PinOptions } from './pinned.ts';
import type { IdentitySigner } from './session.ts';
import type { PostBuildSnapshot } from './snapshot.ts';

/**
 * The kernel ports every subsystem may receive in `build`, and nothing else from the kernel (§7.4). Halves never use
 * `Date.now`, `setTimeout`, `node:fs`, `process.env`, `fetch` or `Bun.spawn` directly (`banned-globals`, §7.7).
 */
export interface KernelPorts {
  readonly clock: Clock;
  readonly log: Log;
  readonly state: StatePort;
  readonly config: ConfigPort;
  readonly roots: RootsPort;
  readonly events: EventsPort;
  readonly jobs: JobsPort;
  readonly workers: WorkersPort;
  readonly spawn: SpawnPort;
  /** Fresh private (0700) folders for staging files a child reads (today's diff scratch), removed on close. */
  readonly scratch: ScratchPort;
  readonly fetch: FetchPort;
  /** WebSocket clients to the hosts the manifest declared in `permissions.network` (`ws:`/`wss:` only). */
  readonly websocket: WebSocketPort;
  /** Who this daemon is, read-only: its id and name, never its key. */
  readonly identity: IdentityPort;
  /** Read-only facts about where things are on this machine (daemon halves only; never on the app or CLI contexts). */
  readonly paths: PathsPort;
  /**
   * The daemon's time-bound rules as this boot runs them: the shipped numbers, or `FYD_TEST_TIMINGS`'s shorter ones
   * (R247). Read-only; Access's idle expiry counts in `idleDayMs`.
   */
  readonly timings: DaemonTimings;
  /** This plugin's OWN secrets, for its own daemon-side use: declared, named by its own config, known to the Vault. */
  readonly secrets: SecretsPort;
  /**
   * The daemon identity's fixed-label signatures (claim, tunnel, catalog), each refused unless this plugin is the
   * one allowed it (`sign`/`signTunnel`: Connections; `signCatalog`: Catalogs). No key export, no raw signing.
   */
  readonly signer: IdentitySigner;
  /** The writer over every declared config file: Gate's alone, `undefined` for every other plugin. */
  readonly configFiles?: ConfigFilesWriter;
  readonly act: ActRunner;
  readonly ids: IdsPort;
  readonly redaction: Redaction;
  readonly snapshot: SnapshotPort;
  readonly lifecycle: LifecyclePort;
}

// ids ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The kernel's id factory (§4.7): the only source of an `OpaqueId` a write-only act may hand back. */
export interface IdsPort {
  mint(prefix: string): OpaqueId;
}

// clock ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Cancel = () => void;

/** `now()` and timers the test host drives. */
export interface Clock {
  now(): Instant;
  nowMs(): number;
  after(delay: Duration, fn: () => void): Cancel;
  every(interval: Duration, fn: () => void): Cancel;
  sleep(delay: Duration, signal?: AbortSignal): Promise<void>;
}

// log ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Logging scoped to the subsystem. Never a secret, token or pairing code in a message or a field. */
export interface Log {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(scope: string): Log;
}

// state ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a declared file could not be used (§9.3). A damaged subsystem answers `store_damaged`, never as empty. */
export interface StateDamage {
  readonly file: string;
  readonly reason: 'unparsable' | 'no_format' | 'lower_format' | 'higher_format' | 'schema' | 'missing' | 'io';
  readonly sentence: string;
}

export type StateRead<Shape> = Result<Shape | undefined, StateDamage>;

/** A SQLite handle on a declared `sqlite` / `sqlite-cache` file. */
export interface SqliteHandle {
  query<Row>(sql: string, params?: readonly unknown[]): readonly Row[];
  run(sql: string, params?: readonly unknown[]): { readonly changes: number };
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** {@link StatePort.version}: `etag` is opaque; equal etags mean the same file, unchanged. */
export interface StateVersion {
  readonly size: number;
  readonly etag: string;
}

/** A JSONL file read line by line: every record that checked, and how many lines did not (never their text). */
export interface JsonlRecords<Shape> {
  readonly records: readonly Shape[];
  /** Lines that were not JSON, not UTF-8, too large, or failed the format check. A torn last line is not counted. */
  readonly unreadable: number;
}

/** The most `tail` reads from the end of a file. */
export const MAX_STATE_TAIL_BYTES = 64 * 1024 * 1024;

/**
 * `state/<id>/` and nothing else: atomic JSON/JSONL, SQLite transactions, each declared file's format check. `name`
 * fills the `*` of a collection path. Writes stamp `format` first.
 */
export interface StatePort {
  read<Shape>(file: StateFileDef<string, Shape>, name?: string): Promise<StateRead<Shape>>;
  write<Shape>(file: StateFileDef<string, Shape>, value: Shape, name?: string): Promise<void>;
  /**
   * Read-modify-write on one serialization chain per file. `fn` may be async (it runs inside the chain). Returning
   * `current` itself (the same reference) DECLINES: nothing is written and `current` is answered (today's session
   * storage: a CAS loser or an already-applied transform has no write).
   */
  update<Shape>(
    file: StateFileDef<string, Shape>,
    fn: (current: Shape | undefined) => Shape | Promise<Shape>,
    name?: string,
  ): Promise<Result<Shape, StateDamage>>;
  append<Shape>(file: StateFileDef<string, Shape>, entry: Shape, name?: string): Promise<void>;
  /**
   * Each record in order. A line that does not parse or check is SKIPPED and reading goes on (today's journal read);
   * `records()` says how many were skipped. Only an io fault or a missing `required` file is damage.
   */
  lines<Shape>(file: StateFileDef<string, Shape>, name?: string): AsyncIterable<Shape>;
  /**
   * A cheap identity of one file from a single `lstat` (no read): its size and an etag that moves on any rewrite or
   * append, so a reader can tell "unchanged since I last looked" without re-reading a journal. `undefined` when absent.
   */
  version(file: StateFileDef, name?: string): Promise<StateVersion | undefined>;
  /**
   * Every line checked on its own (a log, a journal): a bad line is skipped and counted rather than damaging the file,
   * so one torn or hand-edited line never hides the rest. A missing file is no records.
   */
  records<Shape>(file: StateFileDef<string, Shape>, name?: string): Promise<JsonlRecords<Shape>>;
  /**
   * The same, over only the last `maxBytes` of the file (at most {@link MAX_STATE_TAIL_BYTES}): a line cut by the
   * window's start is dropped, not counted. Reads no more than that from disk.
   */
  tail<Shape>(
    file: StateFileDef<string, Shape>,
    options: { readonly maxBytes: number; readonly name?: string },
  ): Promise<JsonlRecords<Shape>>;
  list(file: StateFileDef): Promise<readonly string[]>;
  remove(file: StateFileDef, name?: string): Promise<void>;
  sqlite(file: StateFileDef, name?: string): SqliteHandle;
  /** Whether this subsystem is damaged, and which files. */
  damaged(): readonly StateDamage[];
}

// config ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where one declared config file stands (today's config-files entry state): `absent` (no file, nothing in effect),
 * `valid` (the file is in effect), `invalid` (the file does not check; its last good version stays in effect when
 * there is one — `inEffect: false` is a FIRST file that never checked: damage, not defaults), `held` (a loosening
 * edit waits for the owner; the tighter version stays in effect).
 */
export interface ConfigFileStatus {
  readonly state: 'absent' | 'valid' | 'invalid' | 'held';
  /** Whether some version (the file, or its last good one) is in effect. */
  readonly inEffect: boolean;
  /** Plain sentences naming what is wrong (an invalid file) or what widened (a held edit). Never a value. */
  readonly sentences: readonly string[];
}

/** A whole new YAML text, or a patch of top-level keys (`undefined` removes a key); a patch keeps comments. */
export type ConfigEdit = string | { readonly patch: Readonly<Record<string, unknown>> };

/** One problem with a config text, by line, never quoting a value. */
export interface ConfigWriteIssue {
  readonly path: string;
  readonly line?: number;
  readonly message: string;
}

/**
 * What a config write did (today's config-files contract), never thrown: `written` (in effect), `held` (written, but
 * a loosening waits for the owner — the tighter version stays in effect), `conflict` (the file moved since `ifMatch`),
 * `refused` (bad YAML, a raw secret, the schema, or not a def the caller may write).
 */
export type ConfigWriteOutcome =
  | { readonly kind: 'written'; readonly etag: string; readonly loosened: readonly string[] }
  | { readonly kind: 'held'; readonly etag: string; readonly id: string; readonly sentences: readonly string[] }
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'refused';
      readonly reason: 'yaml' | 'raw_secret' | 'schema' | 'not_declared' | 'bad_name' | 'not_a_mapping';
      readonly issues: readonly ConfigWriteIssue[];
    };

/** Its declared config files and collections, parsed, live (§7.2). */
export interface ConfigPort {
  file<Shape>(def: ConfigFileDef<Shape>): Shape | undefined;
  collection<Shape>(def: ConfigCollectionDef<Shape>): ReadonlyMap<string, Shape>;
  watch(def: ConfigFileDef<any> | ConfigCollectionDef<any>, listener: () => void): Cancel;
  /** Tells an absent file from an invalid one (and a held one); `name` picks a collection item. */
  fileState(def: ConfigFileDef<any> | ConfigCollectionDef<any>, name?: string): ConfigFileStatus;
  /**
   * Writes one of ITS OWN declared files (`name`: the collection item, `undefined` for a file) through the one
   * kernel config writer Gate's config route also uses: only the changed keys are edited, a raw secret is refused,
   * the last good version is kept, and a loosening is put into effect only when Gate's judge
   * (`Admission.judgeConfigWrite`) says this call may; otherwise it is HELD for the owner. Another plugin's def is
   * refused `not_declared`.
   */
  write(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: ConfigEdit,
    options?: { readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  /** Removes one of its own files; removing what loosens (a budget, a rule) is judged and held like a write. */
  remove(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    options?: { readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
}

/** One declared config file or collection item, named for the writer. */
export interface ConfigTarget {
  readonly plugin: string;
  readonly def: ConfigFileDef<any> | ConfigCollectionDef<any>;
  readonly name?: string;
}

/** A config file as it is on disk, for an editor: its text, etag and state. */
export interface ConfigFileRead {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string | undefined;
  readonly etag: string;
  readonly status: ConfigFileStatus;
}

/** An edit held for the owner (the tighter version stays in effect until it is confirmed or discarded). */
export interface HeldConfig {
  readonly id: string;
  readonly plugin: string;
  readonly path: string;
  readonly name?: string;
  readonly etag: string;
  readonly removal: boolean;
  readonly sentences: readonly string[];
}

/**
 * The writer over EVERY declared config file, given to Gate alone (`kernel.configFiles`; `undefined` for every other
 * plugin). Gate's config route decides who may write and whether this act may confirm a loosening
 * (`confirmedLoosening`, after its step-up); the mechanism — atomic write, `ifMatch` conflict, last good, held
 * loosening, comment-keeping patches, raw-secret refusal — is the kernel's (today's `ConfigFilesService`).
 */
export interface ConfigFilesWriter {
  declarations(): readonly { readonly plugin: string; readonly def: ConfigFileDef<any> | ConfigCollectionDef<any> }[];
  read(target: ConfigTarget): Promise<ConfigFileRead | undefined>;
  write(
    target: ConfigTarget,
    edit: ConfigEdit,
    options?: { readonly confirmedLoosening?: boolean; readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  remove(
    target: ConfigTarget,
    options?: { readonly confirmedLoosening?: boolean; readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  held(): readonly HeldConfig[];
  /** Confirms ONE held edit by id; `false` when there is no such edit any more. */
  confirm(id: string): Promise<boolean>;
  /** Drops ONE held edit: the file goes back to the version in effect. */
  discard(id: string): Promise<boolean>;
}

// roots ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The declared roots (§7.7). */
export type RootName =
  | 'agent-homes'
  | 'harness-history'
  | 'worktrees'
  | 'work'
  | 'imports'
  | 'downloads'
  /** Logins' own sign-in material (`state/logins/credentials`): Logins alone, even if another plugin declares it. */
  | 'credentials';

/** `RootHandle.copyTree`: what to bring, and how. */
export interface TreeCopyOptions {
  /** Link the destination name to the source folder (today's skill link into a runtime home) instead of copying. */
  readonly link?: boolean;
  /** The most entries a copy walks (folders count); past it the copy stops and throws. Default 10 000. */
  readonly maxEntries?: number;
}

export interface RootStat {
  readonly kind: 'file' | 'directory';
  readonly size: number;
  readonly modified: Instant;
  /** POSIX permission bits (`& 0o7777`), so a copy or a replace can keep them. */
  readonly mode: number;
  /** Hard links to the object: a file with more than one may be a file from anywhere and is never read or copied. */
  readonly links: number;
}

/** What is AT a name, the leaf not followed: a link is reported as a `symlink`, never as what it points at. */
export interface RootLstat {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly modified: Instant;
  /** POSIX permission bits (`& 0o7777`) of the leaf itself. */
  readonly mode: number;
  /** Hard links to the leaf itself. */
  readonly links: number;
}

/** One name in a folder, as `RootHandle.entries` lists it: the leaf as it is, never followed. */
export interface RootEntry extends RootLstat {
  readonly name: string;
}

export interface RootWriteOptions {
  /** POSIX mode of a file this write creates. Default `0o600`. */
  readonly mode?: number;
  /** Create only: refused when anything (a file, a link) is already at the name; never follows a link. */
  readonly exclusive?: boolean;
  /**
   * Replace an EXISTING regular file only, never through a link (today's MCP project-file replace, O_NOFOLLOW):
   * refused when nothing, a link or anything but a regular file is at the name. The new file lands atomically
   * under the name and keeps the old file's mode unless `mode` is given.
   */
  readonly replaceExisting?: boolean;
}

/**
 * A scoped handle on one root: resolves symlinks before checking, refuses `..`, keeps today's link and device-file
 * checks, and refuses everything inside the fence for an owner's root.
 */
export interface RootHandle {
  readonly name: RootName;
  resolve(relative: string): Result<FencedPath, FolderRefusal>;
  readText(path: FencedPath, limitBytes?: number): Promise<string>;
  readBytes(path: FencedPath, limitBytes?: number): Promise<Uint8Array>;
  /** Atomic replace by default; `exclusive` creates only (today's worktree registry write, `wx`). */
  writeText(path: FencedPath, text: string, options?: RootWriteOptions): Promise<void>;
  /** The same, for bytes. */
  writeBytes(path: FencedPath, bytes: Uint8Array, options?: RootWriteOptions): Promise<void>;
  /**
   * Brings a folder from one of THIS plugin's root handles (`source`, maybe this one) to `to` in this root: a copy
   * (each file read off the disk, never through a link: a link inside is skipped, a file with a second hard link is
   * skipped, modes kept) or, with `link`, one link at `to` to the source folder's real path. Both ends are fenced.
   */
  copyTree(source: RootHandle, from: FencedPath, to: FencedPath, options?: TreeCopyOptions): Promise<void>;
  /** A folder made (or narrowed) to `0700`, refused when a link or a file is at the name. */
  ensurePrivateDirectory(path: FencedPath): Promise<void>;
  list(path: FencedPath): Promise<readonly string[]>;
  /** The folder's names with each leaf's own kind, size, mode and hard-link count (a link is listed, never entered). */
  entries(path: FencedPath): Promise<readonly RootEntry[]>;
  stat(path: FencedPath): Promise<RootStat | undefined>;
  /** The leaf's own kind (a link is `symlink`); its parents are resolved and fenced as for every call. */
  lstat(path: FencedPath): Promise<RootLstat | undefined>;
  /** `mkdir -p` inside the root; a new folder gets `mode` (default `0o700`). */
  makeDirectory(path: FencedPath, options?: { readonly mode?: number }): Promise<void>;
  /** The real path of an EXISTING name, links resolved, checked again to be inside the root. */
  realPath(path: FencedPath): Promise<FencedPath>;
  /**
   * Holds a folder in this root OPEN and walks beneath it by descriptor (today's session-viewer pinner): the
   * folder is fenced like every call, and the object actually held is checked again to be inside the root. Its
   * `policyCwd` is the only cwd `kernel.spawn` accepts as a pin, and only from the plugin whose root minted it.
   */
  pin(path: FencedPath, options?: PinOptions): Promise<HeldRoot>;
  remove(path: FencedPath): Promise<void>;
}

export interface RootsPort {
  /** Only roots the manifest declared in `permissions.roots`; anything else throws at build. */
  root(name: RootName, scope?: { readonly ferret?: FerretId; readonly subfolder?: string }): RootHandle;
}

// events ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EventsPort {
  /** Only types the manifest declared in `data.publishes`. Delivered after the caller's write, at most once. */
  publish<Name extends string, Payload>(event: EventDef<Name, Payload>, payload: Payload): void;
}

// jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type JobSchedule =
  | { readonly every: Duration }
  | { readonly cron: string }
  | { readonly onceAfterStart: true; readonly delay?: Duration };

export interface JobSpec {
  readonly id: string;
  readonly schedule: JobSchedule;
  /** Waits for each named job's first run. */
  readonly after?: readonly string[];
  readonly lane?: 'main' | 'worker';
  run(signal: AbortSignal): Promise<void>;
}

/** Jobs start after listen, in start order; a throwing job restarts with backoff and is named in `fy doctor`. */
export interface JobsPort {
  add(job: JobSpec): void;
  /** Runs a job now (e.g. after a config change), coalesced with a running one. */
  kick(id: string): void;
}

// workers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a worker ended: its exit code, and the uncaught error's message when one ended it. */
export interface WorkerExit {
  readonly code: number;
  readonly reason?: string;
}

export interface WorkerHandle {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  onMessage(listener: (message: unknown) => void): Cancel;
  /** Called once when the worker ends (a crash included), so a dead worker is seen rather than waited on. */
  onExit(listener: (exit: WorkerExit) => void): Cancel;
  terminate(): Promise<void>;
}

/** A declared `sqlite` / `sqlite-cache` state file a worker may open (a collection member names its `name`). */
export type WorkerStateGrant = StateFileDef | { readonly def: StateFileDef; readonly name: string };

export interface WorkerStartOptions {
  readonly name?: string;
  /**
   * Declared sqlite state files the worker opens itself with `workerState().sqlite(def, name?)` from
   * `@ferretry/kernel/worker` (today's version archive runs bun:sqlite on a worker thread). The kernel resolves each
   * inside this plugin's state folder; an undeclared or non-sqlite file refuses the start. No path is passed in.
   */
  readonly state?: readonly WorkerStateGrant[];
}

export interface WorkersPort {
  /** A Bun worker thread from the subsystem's own package (a module URL resolved from the half). */
  start(moduleUrl: URL, options?: WorkerStartOptions): WorkerHandle;
}

// spawn ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  /**
   * A fenced folder, or a directory held open by `RootHandle.pin` (`policyCwd`): the child starts INSIDE the held
   * object, installed for the instant of the spawn. A pin this plugin's roots did not mint is refused.
   */
  readonly cwd?: FencedPath | PinnedWorkingDirectory;
  /**
   * Plain values the half owns, or a Vault {@link ChildEnvironment} (secrets resolved for this child). A handle is
   * opened inside the kernel's adapter at exec time; its values never pass through the plugin (lead decision 9).
   */
  readonly env?: Readonly<Record<string, string>> | ChildEnvironment;
  readonly stdin?: string | Uint8Array;
  readonly timeout?: Duration;
  readonly signal?: AbortSignal;
  /** Runs inside this ferret's limits. */
  readonly forFerret?: FerretId;
  /**
   * `start` only: this many extra pipes beyond stdio 0-2, the child's fds 3, 4, … (today's Chrome launch,
   * `--remote-debugging-pipe` on 3 and 4). The daemon's ends are {@link ChildHandle.pipes}. At most 4.
   */
  readonly extraPipes?: number;
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `runBytes`: caps on what is kept of each stream (today's Git runner). */
export interface SpawnBytesOptions extends SpawnOptions {
  /** Default 1 MiB. Bytes past it are dropped and `stdoutTruncated` is set. */
  readonly maxStdoutBytes?: number;
  /** Default 64 KiB. */
  readonly maxStderrBytes?: number;
}

/** A finished child's raw stdout, capped (today's `GitExecution`). A timeout kills it (`SIGKILL`). */
export interface SpawnBytesResult {
  /** `-1` when the child was abandoned at its timeout. */
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
}

export interface ChildHandle {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  write(chunk: string | Uint8Array): void;
  kill(signal?: string): void;
  readonly exited: Promise<number | null>;
  /**
   * The daemon's ends of the {@link SpawnOptions.extraPipes}, in order (the child's fd 3 first); empty without any.
   * Close-on-exec, so no other child inherits one. Hand them on (a worker's transport) and close with `closePipes`.
   */
  readonly pipes: readonly number[];
  /** Closes the daemon's ends of the extra pipes, once; later calls do nothing. */
  closePipes(): void;
}

export interface SpawnPort {
  /** Only programs the manifest declared in `permissions.spawn`. */
  run(program: string, args: readonly string[], options?: SpawnOptions): Promise<SpawnResult>;
  /** The same, keeping stdout as bytes up to a cap and saying whether it was cut. */
  runBytes(program: string, args: readonly string[], options?: SpawnBytesOptions): Promise<SpawnBytesResult>;
  start(program: string, args: readonly string[], options?: SpawnOptions): ChildHandle;
}

// scratch ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One private folder; every name is relative to it, and nothing is written through a link it made. */
export interface ScratchDirectory {
  /** The folder, for a child's cwd or arguments. Gone after `close`. */
  readonly path: FencedPath;
  makeDirectory(rel: string, mode?: number): Promise<void>;
  /** Create only (refused when anything is at the name), with exactly `mode` (umask does not apply). */
  writeFile(rel: string, data: string | Uint8Array, mode?: number): Promise<void>;
  /** A link whose target is text, never followed here. */
  symlink(rel: string, target: string): Promise<void>;
  /** Removes the folder and everything in it. */
  close(): Promise<void>;
}

export interface ScratchPort {
  open(): Promise<ScratchDirectory>;
}

// fetch ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** HTTP to the hosts the manifest declared in `permissions.network`; anything else is refused before a socket opens. */
export interface FetchPort {
  request(url: string | URL, init?: RequestInit): Promise<Response>;
}

// websocket ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The subset of a WebSocket a client uses (today's relay carrier's `RelayWebSocket`), so a test supplies one. */
export interface WebSocketClient {
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Outbound WebSocket clients, restricted like {@link FetchPort}: `ws:`/`wss:` to a declared host only, refused
 * (a `PermissionError`, thrown synchronously) before a socket opens. Dialled as today's relay carrier dialled:
 * the URL alone, no extra headers; deadlines and keepalive are the caller's.
 */
export interface WebSocketPort {
  connect(url: string | URL): WebSocketClient;
}

// identity ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where the owner's files are, read-only (today's `homedir()`). A name, never a capability: nothing here opens,
 * resolves or reaches a path; reaching one goes through a declared root.
 */
/** A session's lease, its renewal lead and its cap, in milliseconds. */
export interface LeaseTimings {
  readonly leaseMs: number;
  readonly renewLeadMs: number;
  readonly maxSessionMs: number;
}

/** The daemon's time-bound rules (`kernel.timings`). */
export interface DaemonTimings {
  readonly lease: LeaseTimings;
  /** How long one idle day is: the unit `idleExpiryDays` counts in. */
  readonly idleDayMs: number;
}

export interface PathsPort {
  /** The owner's home directory as the OS reports it (Accounts orders sign-ins by work folders under it, I184). */
  home(): string;
}

/**
 * The daemon's identity as any plugin may read it (§2.2): the id the pairing QR and the rendezvous path carry, and
 * the daemon's display name (today's normalised hostname). The key is never reachable from here.
 */
export interface IdentityPort {
  /** `fy_daemon_` + base64url SHA-256 of the identity's SPKI (R41). */
  readonly daemonId: string;
  /** The host name with control and format characters removed, trimmed, at most 100 characters. */
  readonly daemonName: string;
}

// snapshot / lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────

/** The post-build snapshot; readers take it from the kernel, not a hook, so it adds no start-order edge. */
export interface SnapshotPort {
  /** Throws if called before the `bound` state. */
  current(): PostBuildSnapshot;
}

export interface LifecyclePort {
  onStop(fn: () => void | Promise<void>): void;
  stopping(): boolean;
  readonly signal: AbortSignal;
}
