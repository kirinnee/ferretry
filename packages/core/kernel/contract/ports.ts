import type { Duration, Instant, Result } from '@ferretry/std';
import type { ActRunner, OpaqueId } from './act.ts';
import type { ChildEnvironment, FencedPath, FolderRefusal, Redaction } from './bound.ts';
import type { ConfigCollectionDef, ConfigFileDef, EventDef, StateFileDef } from './define.ts';
import type { FerretId } from './ids.ts';
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
  readonly fetch: FetchPort;
  /** WebSocket clients to the hosts the manifest declared in `permissions.network` (`ws:`/`wss:` only). */
  readonly websocket: WebSocketPort;
  /** Who this daemon is, read-only: its id and name, never its key. */
  readonly identity: IdentityPort;
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

/**
 * `state/<id>/` and nothing else: atomic JSON/JSONL, SQLite transactions, each declared file's format check. `name`
 * fills the `*` of a collection path. Writes stamp `format` first.
 */
export interface StatePort {
  read<Shape>(file: StateFileDef<string, Shape>, name?: string): Promise<StateRead<Shape>>;
  write<Shape>(file: StateFileDef<string, Shape>, value: Shape, name?: string): Promise<void>;
  /** Read-modify-write on one serialization chain per file. */
  update<Shape>(
    file: StateFileDef<string, Shape>,
    fn: (current: Shape | undefined) => Shape,
    name?: string,
  ): Promise<Result<Shape, StateDamage>>;
  append<Shape>(file: StateFileDef<string, Shape>, entry: Shape, name?: string): Promise<void>;
  lines<Shape>(file: StateFileDef<string, Shape>, name?: string): AsyncIterable<Shape>;
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
export type RootName = 'agent-homes' | 'harness-history' | 'worktrees' | 'work' | 'imports' | 'downloads';

export interface RootStat {
  readonly kind: 'file' | 'directory';
  readonly size: number;
  readonly modified: Instant;
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
  writeText(path: FencedPath, text: string): Promise<void>;
  list(path: FencedPath): Promise<readonly string[]>;
  stat(path: FencedPath): Promise<RootStat | undefined>;
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

export interface WorkerHandle {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  onMessage(listener: (message: unknown) => void): Cancel;
  terminate(): Promise<void>;
}

export interface WorkersPort {
  /** A Bun worker thread from the subsystem's own package (a module URL resolved from the half). */
  start(moduleUrl: URL, options?: { readonly name?: string }): WorkerHandle;
}

// spawn ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  readonly cwd?: FencedPath;
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
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ChildHandle {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  write(chunk: string | Uint8Array): void;
  kill(signal?: string): void;
  readonly exited: Promise<number | null>;
}

export interface SpawnPort {
  /** Only programs the manifest declared in `permissions.spawn`. */
  run(program: string, args: readonly string[], options?: SpawnOptions): Promise<SpawnResult>;
  start(program: string, args: readonly string[], options?: SpawnOptions): ChildHandle;
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
