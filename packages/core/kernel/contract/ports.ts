import type { SecretsPort } from './secrets.ts';
import type { Duration, Instant, Result } from '@ferretry/std';
import type { ActRunner, OpaqueId } from './act.ts';
import type { ChildEnvironment, FencedPath, FolderRefusal, Redaction } from './bound.ts';
import type { ConfigCollectionDef, ConfigFileDef, EventDef, StateFileDef } from './define.ts';
import type { ApiHeaders } from './http.ts';
import type { CarrierKey, FerretId } from './ids.ts';
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
  /**
   * A loopback listener that serves ONE declared socket route and stamps every arrival `carried` (a carrier whose
   * traffic reaches this host through a local forwarder, like the tunnel's `cloudflared`). Refused unless the manifest
   * takes that carrier's hook and declares the route.
   */
  readonly carrierListener: CarrierListenerPort;
  /** Who this daemon is, read-only: its id and name, never its key. */
  readonly identity: IdentityPort;
  /** Read-only facts about where things are on this machine (daemon halves only; never on the app or CLI contexts). */
  readonly paths: PathsPort;
  /** Read-only facts about this machine from `/proc` and `/sys`; only for a manifest with `permissions.hostFacts`. */
  readonly hostFacts: HostFactsPort;
  /** The running build and its self-update launch; only for a manifest with `permissions.updateHost` (Updates). */
  readonly updateHost: UpdateHostPort;
  /**
   * The daemon's time-bound rules as this boot runs them: the shipped numbers, or `FYD_TEST_TIMINGS`'s shorter ones
   * (R247). Read-only; Access's idle expiry counts in `idleDayMs`.
   */
  readonly timings: DaemonTimings;
  /** This plugin's OWN secrets, for its own daemon-side use: declared, named by its own config, known to the Vault. */
  readonly secrets: SecretsPort;
  /**
   * The daemon identity's fixed-label signatures (claim, tunnel, catalog), each refused unless this plugin is the
   * one allowed it (`sign`/`signTunnel`: Connections; `signCatalog`, `signLinkStoreRequest`: Catalogs). No key export, no raw signing.
   */
  readonly signer: IdentitySigner;
  /** The writer over every declared config file: Gate's alone, `undefined` for every other plugin. */
  readonly configFiles?: ConfigFilesWriter;
  readonly act: ActRunner;
  readonly ids: IdsPort;
  readonly redaction: Redaction;
  readonly snapshot: SnapshotPort;
  readonly lifecycle: LifecyclePort;
  /** This plugin's OWN effective contract hash, and no other package's (§9.6). */
  readonly contract: ContractPort;
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
  /** Own opaque named trees only. Metadata of the entry itself via lstat; a symlink is never followed. */
  stat(
    file: StateFileDef,
    name: string,
  ): Promise<{ readonly kind: 'file' | 'directory' | 'symlink'; readonly modifiedMs: number } | undefined>;
  /** Own opaque named trees only. Plain rmdir: never recursive, refuses links and nonempty directories. */
  removeEmptyDirectory(file: StateFileDef, name: string): Promise<void>;
  /** Own opaque named trees only. Exclusive mkdir, mode 0700; any existing entry is refused. */
  createPrivateDirectory(file: StateFileDef, name: string): Promise<void>;
  remove(file: StateFileDef, name?: string): Promise<void>;
  sqlite(file: StateFileDef, name?: string): SqliteHandle;
  /**
   * The absolute path of one of THIS plugin's own declared `opaque` state files (today's `tmux.sock` under
   * `state/terminals/`), for a child that makes or opens the file itself. An opaque def whose path ends `/*` is a
   * NAMED TREE: its name may be path-safe segments (`F12/turns/turn-001.md`, today's Conversation files), written
   * with `write` and handed on by this path. Any other store, or an undeclared file,
   * throws: a path is never handed out for a file the port reads and writes, nor for another plugin's.
   */
  pathOf(file: StateFileDef, name?: string): string;
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
  readonly column?: number;
  readonly message: string;
  /** The plain fix, when there is one. */
  readonly fix?: string;
}

/**
 * What a config write did (today's config-files contract), never thrown: `written` (in effect), `held` (written, but
 * a loosening waits for the owner — the tighter version stays in effect), `conflict` (the file moved since `ifMatch`
 * or since the last reload: an edit nobody has seen is never applied, so the caller reads again and redoes it),
 * `refused` (bad YAML, a raw secret, the schema, or not a def the caller may write).
 */
export type ConfigWriteOutcome =
  | {
      readonly kind: 'written';
      readonly etag: string;
      readonly loosened: readonly string[];
      /**
       * Only on an {@link ConfigPort.writeAsOwner} that left ANOTHER edit of the same file held: the owner's change is
       * in effect and the held edit (made to both versions, still held) waits for the owner.
       */
      readonly stillHeld?: { readonly id: string; readonly sentences: readonly string[] };
    }
  | { readonly kind: 'held'; readonly etag: string; readonly id: string; readonly sentences: readonly string[] }
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'refused';
      readonly reason: 'yaml' | 'raw_secret' | 'schema' | 'not_declared' | 'bad_name' | 'not_a_mapping';
      readonly issues: readonly ConfigWriteIssue[];
    }
  /**
   * Only from {@link ConfigPort.remove} with `refuseIfHeld`: the removal loosens and this call's judge did not let it
   * into effect, so it would have been held. Nothing was touched: the file is still in effect, nothing is held.
   */
  | {
      readonly kind: 'refused';
      readonly reason: 'would_hold';
      /** Always empty: nothing is wrong with the file; `sentences` say what the removal would loosen. */
      readonly issues: readonly ConfigWriteIssue[];
      readonly sentences: readonly string[];
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
  /**
   * The OWNER's own patch of one of its own files (today's rule 3, docs/config-files.md: "a save never discards a
   * held edit"). A patch only — top-level keys, `undefined` removes one — because the owner's act is the keys they
   * changed, never a whole text rendered from what is in effect.
   *
   * With no edit held it is {@link write} of that patch. With an edit of the same file held for the owner, the patch
   * is made to BOTH versions: the version in effect, patched, is recorded as accepted — at once when the patch itself
   * tightens or Gate's judge lets it loosen — and the held version (the file on disk), patched, stays in the file and
   * stays held, judged against the new record. The judge is asked about the owner's patch ONLY (the sentences of
   * what it changes in the version in effect), never about the held edit that rode along: a save can neither discard
   * a held edit nor put one into effect that nobody confirmed. When the judge holds the patch itself, the version in
   * effect is untouched and the patch waits with the held version.
   */
  writeAsOwner(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: { readonly patch: Readonly<Record<string, unknown>> },
    options?: { readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  /**
   * Removes one of its own files; removing what loosens (a budget, a rule) is judged and held like a write.
   * `refuseIfHeld`: a removal that would be held is refused `would_hold` instead, with the file left untouched and
   * nothing held. It is the same one judgement as the removal (asked once, in the same act), never a separate dry run.
   */
  remove(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    options?: { readonly ifMatch?: string; readonly refuseIfHeld?: true },
  ): Promise<ConfigWriteOutcome>;
}

/** One declared config file or collection item, named for the writer. */
export interface ConfigTarget {
  readonly plugin: string;
  readonly def: ConfigFileDef<any> | ConfigCollectionDef<any>;
  readonly name?: string;
}

/** One located problem with a config file, as an editor shows it: where, what, and the plain fix. Never a value. */
export interface ConfigFileIssue {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fix: string;
}

/** A config file as it is on disk, for an editor: its text, etag and state. */
export interface ConfigFileRead {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string | undefined;
  readonly etag: string;
  readonly status: ConfigFileStatus;
  /** What is wrong with the file, located (an invalid or unreadable file). Absent: none to show. */
  readonly issues?: readonly ConfigFileIssue[];
  /**
   * The version IN EFFECT as its text spells it out, before any default fills a gap: what an owner actually wrote, read
   * by the kernel's own bounded reader (the size cap, the alias budget, no YAML 1.1 tags). Absent when nothing is in
   * effect. A reader that needs to know what was written uses this, never a parse of `text` of its own: `text` is the
   * disk's, and a hand-written file there may be one that the kernel refused because reading it would never end.
   */
  readonly written?: unknown;
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
    options?: {
      readonly confirmedLoosening?: boolean;
      readonly ifMatch?: string;
      /** Asked only when the edit loosens and `confirmedLoosening` is not set: true puts it into effect (Gate's claim). */
      readonly judge?: (sentences: readonly string[], removal: boolean) => boolean;
      /**
       * An agent's own write: as untrusted as a plugin's, so an edit that adds a `${secret:NAME}` reference is held for
       * the owner and neither `confirmedLoosening` nor a judge confirms it (NN2).
       */
      readonly byAgent?: true;
    },
  ): Promise<ConfigWriteOutcome>;
  remove(
    target: ConfigTarget,
    options?: { readonly confirmedLoosening?: boolean; readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  held(): readonly HeldConfig[];
  /**
   * Confirms ONE held edit by id; `false` when there is no such edit any more. The id carries the FULL etag of the
   * edit that was reviewed and is matched against the disk inside the write queue, after a fresh reload: a file that
   * moved since is never confirmed.
   */
  confirm(id: string): Promise<boolean>;
  /** Drops ONE held edit: the file goes back to the version in effect. Matched like {@link ConfigFilesWriter.confirm}. */
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
  | 'credentials'
  /**
   * Ferrets' per-ferret session folders (`state/ferrets/sessions/<ferret>`, the plaintext session credential file
   * among them): Ferrets alone, even if another plugin declares it.
   */
  | 'sessions';

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

/** `RootHandle.readBytes` with a window: `length` bytes from `offset`; fewer at the end of the file. */
export interface RootReadWindow {
  readonly offset: number;
  readonly length: number;
}

/** `RootHandle.readTail`: the bytes, and the file's size when they were read. */
export interface RootTail {
  readonly bytes: Uint8Array;
  readonly size: number;
}

/** The longest window or tail one root read returns (today's rollout tail is 256 KiB). */
export const MAX_ROOT_WINDOW_BYTES = 4 * 1024 * 1024;

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

/** Which object a name reaches: the device and inode, so a caller can prove a path still names what it checked. */
export interface RootIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface RootPublishOptions {
  /** POSIX mode of the file this publish creates. Default `0o600`. */
  readonly mode?: number;
  /**
   * Create only: the name is taken by `link(2)` (create-if-absent in the kernel) and an existing name, a link
   * included, is reported as `exists` and left exactly as it was. Without it the new file replaces the name by rename.
   */
  readonly exclusive?: boolean;
}

/** What a {@link RootHandle.publish} came to: the file the name now reaches, or that someone else's was there first. */
export type RootPublished =
  | { readonly outcome: 'published'; readonly identity: RootIdentity }
  | { readonly outcome: 'exists' };

/** {@link RootHandle.readDurable}: the bytes, and the identity of the file they were read from. */
export interface RootDurableRead {
  readonly bytes: Uint8Array;
  readonly identity: RootIdentity;
}

/** The `hold` argument of {@link RootHandle.readDurable}: what was read, and a question the caller asks while the file is still held. */
export interface RootDurableHeld extends RootDurableRead {
  /** Whether the NAME still reaches the very inode that was read (the descriptor pins it, so it cannot be reused). */
  stillNames(): Promise<boolean>;
}

/**
 * A scoped handle on one root: resolves symlinks before checking, refuses `..`, keeps today's link and device-file
 * checks, and refuses everything inside the fence for an owner's root.
 */
export interface RootHandle {
  readonly name: RootName;
  /**
   * `true` for a root the kernel makes under the home (`agent-homes`, `downloads`, `credentials`, `sessions`), `false`
   * for an owner's root (`work`, `imports`, `harness-history`) or one outside the home (`worktrees`). A consumer that
   * must never sit on an owner's folder asserts it.
   */
  readonly internal: boolean;
  resolve(relative: string): Result<FencedPath, FolderRefusal>;
  readText(path: FencedPath, limitBytes?: number): Promise<string>;
  /**
   * The whole file (up to `limitBytes`), or, with a {@link RootReadWindow}, `length` bytes from `offset` (today's
   * Codex rollout index head window). A window longer than {@link MAX_ROOT_WINDOW_BYTES} is refused.
   */
  readBytes(path: FencedPath, limitOrWindow?: number | RootReadWindow): Promise<Uint8Array>;
  /**
   * The last `maxBytes` of a file (at most {@link MAX_ROOT_WINDOW_BYTES}) and its size, from one open (today's
   * rollout tail window): fenced exactly as `readBytes`.
   */
  readTail(path: FencedPath, maxBytes: number): Promise<RootTail>;
  /** Atomic replace by default; `exclusive` creates only (today's worktree registry write, `wx`). */
  writeText(path: FencedPath, text: string, options?: RootWriteOptions): Promise<void>;
  /** The same, for bytes. */
  writeBytes(path: FencedPath, bytes: Uint8Array, options?: RootWriteOptions): Promise<void>;
  /**
   * A DURABLE publish (the state filesystem's contract): missing folders are made (`0700`) and, parent first, every
   * ancestor this call created plus the folder's own parent are synced BEFORE anything is written; the bytes go into a
   * new temp file in the same folder (`O_EXCL | O_NOFOLLOW`, exactly `mode`, fsync'd); that is moved onto the name
   * (`exclusive`: by `link(2)`, losing reports `exists`; otherwise by rename); and the folder is synced last. The temp
   * name is never left behind, and a name this call did not create is never removed. Every step goes through the
   * fenced, descriptor-reached folder: no link is followed.
   */
  publish(path: FencedPath, bytes: Uint8Array, options?: RootPublishOptions): Promise<RootPublished>;
  /**
   * Reads a file through one held descriptor and fsyncs THAT descriptor before answering, so the bytes returned are
   * the bytes made durable; `undefined` only when nothing is at the name. Fenced exactly as `readBytes`; a name that
   * is mid-publish by `link` (two names for a moment) is waited out briefly rather than refused (and
   * a leftover second name of this root's own interrupted publish is removed, but ONLY on an internal, writable root: on a read-only or owner root it stays refused as `hard_link`). With `hold`, the descriptor stays OPEN
   * until `hold` settles and its answer is returned (`hold` is not called when nothing is at the name), so a caller
   * that syncs the folder and then asks `stillNames` compares against an inode that cannot have been freed and
   * reused meanwhile.
   */
  readDurable<T = RootDurableRead>(
    path: FencedPath,
    limitBytes?: number,
    hold?: (read: RootDurableHeld) => Promise<T>,
  ): Promise<T | undefined>;
  /**
   * Syncs one folder's entries, with `parent` the folder's own parent first (when that parent is still inside the root).
   * A platform that cannot sync a directory (`EINVAL`, `ENOTSUP`, `EPERM`) is tolerated; anything else throws.
   */
  syncDirectory(path: FencedPath, options?: { readonly parent?: boolean }): Promise<void>;
  /** The device and inode the NAME reaches now (the leaf never followed), or `undefined` when nothing is there. */
  fileIdentity(path: FencedPath): Promise<RootIdentity | undefined>;
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
  /**
   * `worker`: housekeeping (today's BackgroundLane). It waits until the lane opens (`FYD_BACKGROUND_DELAY_SECONDS`
   * after the daemon serves, two minutes by default), then runs ONE lane job at a time, handing the loop back between
   * jobs; a fire while the job already waits queues no second copy. `main` (the default) runs when it fires.
   */
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

/**
 * One of THIS plugin's declared roots a worker may READ: the name, or the name with the scope its handle takes (a
 * `subfolder` / `ferret` stays on the main thread; the worker only ever names the root). One grant per root name.
 */
export type WorkerRootGrant =
  | RootName
  | { readonly name: RootName; readonly scope?: { readonly ferret?: FerretId; readonly subfolder?: string } };

export interface WorkerStartOptions {
  readonly name?: string;
  /**
   * Declared sqlite state files the worker opens itself with `workerState().sqlite(def, name?)` from
   * `@ferretry/kernel/worker` (today's version archive runs bun:sqlite on a worker thread). The kernel resolves each
   * inside this plugin's state folder; an undeclared or non-sqlite file refuses the start. No path is passed in.
   */
  readonly state?: readonly WorkerStateGrant[];
  /**
   * Roots the worker READS with `rootPort(name)` from `@ferretry/kernel/worker`, whatever the manifest says about
   * writing: the worker side has no write, remove, copy, pin or real-path operation at all, and no path crosses into
   * the thread. Only roots THIS plugin's manifest declares (`permissions.roots`); an undeclared one refuses the start.
   * Every read is served by the main thread through the plugin's own root handle, so each is fenced as a main-thread
   * read is, links and `..` included. Paths are relative to the root: an absolute path is
   * refused `outside`, even one that falls inside it.
   *
   * GAP: this bounds what a worker gets THROUGH this port, no more. A worker is an in-process thread, not a sandbox:
   * it can still `import 'node:fs'`, call the global `fetch` or start a `Worker` of its own. What stops plugin code
   * doing that is the repo's lints (`banned-globals`, `fetch-binding`, `no-sync-io`) and the worker bundle diet
   * test, not this grant; the `state` grant above has the same limit. "Cannot widen" means: through the grant
   * channel, a forged message or a second `rootPort` gets nothing more than was granted.
   */
  readonly roots?: readonly WorkerRootGrant[];
  /**
   * HTTP from the worker with `fetchPort()` from `@ferretry/kernel/worker`, to ONLY the hosts THIS plugin's manifest
   * declares in `permissions.network`: `true` for all of them, or a list that must be a subset. Each request passes
   * the very guard `kernel.fetch` does (allowlist, no followed redirect), so a redirect to another host is a response
   * the worker would have to ask for again, and is refused then. Undeclared refuses the start. A worker may not set
   * the `Host` header, and a request body is capped at 8 MiB (`too_large`), as a response is.
   *
   * GAP: as for `roots`, the grant bounds the fetch THROUGH `fetchPort()` only; the thread is in-process, so
   * nothing but the lints and the diet test keep plugin code off the global `fetch`. On the main thread,
   * `kernel.fetch` still forwards a `Host` header a plugin sets (the guard judges the URL's host, as before);
   * only the worker channel refuses it.
   */
  readonly network?: true | readonly string[];
  /**
   * The worker's whole environment. Absent, a worker sees the process environment (a Bun `Worker` copies it); given,
   * it sees only these variables, `{}` being none. `fyd --check` starts its probes with `{}`.
   */
  readonly env?: Readonly<Record<string, string>>;
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

/**
 * HTTP to the hosts the manifest declared in `permissions.network`; anything else is refused before a socket opens.
 *
 * GAP: this main-thread port still forwards a `Host` header a plugin sets, because the guard judges the URL's host
 * and today's port did not refuse it either; only the worker grant channel refuses `Host`.
 */
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

// carrier listener ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What a carrier listener serves: one declared socket route, and how its arrivals are told apart. */
export interface CarrierListenerSurface {
  /** The plugin's declared socket, spelled as its manifest spells it: `GET /v1/rendezvous/:daemonId/client`. */
  readonly socket: string;
  /**
   * The rate-limit identity of one arrival, from its headers (the tunnel keys by the address its edge saw). It names
   * a bucket and nothing else: it can never make an arrival local. Absent: one shared identity for the listener.
   */
  readonly peer?: (headers: ApiHeaders) => string;
  /**
   * The browser origins an upgrade may present (today's `corsOrigins`). An upgrade whose `Origin` names another site is
   * answered 404 before admission, like every path this listener does not serve; an absent `Origin`, or the listener's
   * own, is not a browser cross-origin and passes. Absent: no origin gate.
   */
  readonly origins?: readonly string[];
}

/** A bound carrier listener. */
export interface CarrierListenerHandle {
  /** The ephemeral loopback port (127.0.0.1) the carrier's forwarder is pointed at. */
  readonly port: number;
  /** Frees the port. Idempotent; a daemon stop closes every listener still open. */
  close(): Promise<void>;
}

/**
 * A second loopback listener for a carrier that arrives through a local forwarder (§15). A forwarder on this host
 * makes everything it carries come from a loopback peer, so pointing it at the API listener would make a phone beyond
 * the far edge indistinguishable from a browser at the machine. This listener is the other wall: it serves only the
 * declared route (404 to every other path and method; nothing else of the daemon is reachable) and stamps EVERY arrival
 * `{ kind: 'carried', carrier }`, never local (G15, G16): admission governs it as remote.
 */
export interface CarrierListenerPort {
  open(input: {
    readonly carrier: CarrierKey;
    readonly surface: CarrierListenerSurface;
  }): Promise<CarrierListenerHandle>;
}

// identity ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where the owner's files are, read-only (today's `homedir()`). A name, never a capability: nothing here opens,
 * resolves or reaches a path; reaching one goes through a declared root.
 */
/** A per-process file under `/proc/<pid>/` (or `/proc/self/`) that `hostFacts.procFile` reads. */
export type ProcPidFile = 'stat' | 'status' | 'comm' | 'cmdline' | 'cgroup' | 'statm';

/** A machine-wide file under `/proc/` that `hostFacts.procSystemFile` reads. */
export type ProcSystemFile = 'stat' | 'meminfo' | 'sys/kernel/pid_max' | 'net/tcp' | 'net/tcp6';

/** A cgroup-v2 interface file under `/sys/fs/cgroup/<path>/` that `hostFacts.cgroupFile` reads. */
export type CgroupFile =
  | 'cgroup.controllers'
  | 'cgroup.procs'
  | 'memory.events'
  | 'memory.events.local'
  | 'memory.high'
  | 'memory.max'
  | 'memory.swap.max'
  | 'pids.max'
  | 'cpu.weight'
  | 'cpu.max';

/**
 * Whether a daemon a test booted must refuse to launch a real harness, and where it looks for one. The kernel decides
 * `active` ONCE at boot (`FERRETRY_TEST=1`, or the home's real path under `os.tmpdir()`, `/tmp` or `/var/folders`)
 * and hands the daemon's `PATH`; no plugin reads the environment.
 */
export interface HostLaunchGuard {
  readonly active: boolean;
  /** The daemon's `PATH`; absent when it has none. */
  readonly searchPath?: string;
}

/**
 * The machine reads today's Terminals made through `node:fs` (its interim `adapters/host/fs.ts`), as narrow methods
 * that each name one kind of file: a pid is a whole number, a descriptor is digits, a cgroup path is plain segments,
 * and no method takes a free path. Each throws as the read it replaces did (a vanished process, a missing file), so
 * a caller keeps its own catch.
 */
export interface HostFactsPort {
  /** `process.platform`. */
  readonly platform: string;
  /** `os.availableParallelism()`. */
  readonly cpus: number;
  /** `os.totalmem()`. */
  readonly totalMemoryBytes: number;
  /** The numeric entries of `/proc`. */
  pids(): Promise<readonly number[]>;
  procFile(pid: number | 'self', file: ProcPidFile): Promise<string>;
  procSystemFile(file: ProcSystemFile): Promise<string>;
  /** `readdir /proc/<pid>/task`. */
  procTasks(pid: number): Promise<readonly string[]>;
  /** `/proc/<pid>/task/<task>/children`. */
  procTaskChildren(pid: number, task: number): Promise<string>;
  /** `readdir /proc/<pid>/fd`. */
  procFds(pid: number): Promise<readonly string[]>;
  /** `readlink /proc/<pid>/fd/<fd>`. */
  procFdLink(pid: number, fd: string): Promise<string>;
  /** What `stat /proc/<pid>/fd/<fd>` reaches: whether a character device, and which (`rdev`). */
  procFdReach(pid: number, fd: string): Promise<{ readonly character: boolean; readonly device: number }>;
  /** `readlink /proc/<pid>/exe`. */
  procExecutable(pid: number): Promise<string>;
  /** `/sys/fs/cgroup/<path>/<file>`; `path` is relative (`''` is the root). */
  cgroupFile(path: string, file: CgroupFile): Promise<string>;
  /** `readdir /sys/fs/cgroup/<path>`. */
  cgroupChildren(path: string): Promise<readonly string[]>;
  /**
   * A block device's I/O scheduler (`/sys/dev/block/<major>:<minor>`, resolved; a partition reads its parent
   * disk's `queue/scheduler`): the device's name and the file's text.
   */
  blockScheduler(major: number, minor: number): Promise<{ readonly device: string; readonly scheduler: string }>;
  /** The launch-guard fact (see {@link HostLaunchGuard}); like every host fact, refused to a plugin without `permissions.hostFacts`. */
  launchGuard(): HostLaunchGuard;
}

/** What the running daemon executable is (today's update install facts seams). */
export interface ExecutableFacts {
  /** `process.argv0`: the path the daemon was launched as (a link the install made, often). */
  readonly argv0: string;
  /** `process.execPath`: the executable itself. */
  readonly execPath: string;
  /** `execPath` with every link resolved; `execPath` itself when it cannot be resolved. */
  readonly resolvedExecPath: string;
  /** `Bun.main`: `/$bunfs/…` inside a compiled binary, a source file otherwise. */
  readonly main: string;
  readonly workingDirectory: string;
  readonly platform: string;
}

export type UpdateLaunchOutcome = { readonly kind: 'started' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * The daemon's own update seam (today's `DaemonUpdateService` host parts): the release this build carries, what the
 * running executable is, and one launch: `<fy> update --run --to <target> --report <report>` (the verb is the host's
 * `UPDATE_LAUNCH_VERB`), detached in its own process group so it survives the daemon's restart. The plugin's declared
 * state files `report` and `log` (its manifest `data.state`) say where the report is written and the output is
 * appended; the host spells neither path. No other command.
 */
export interface UpdateHostPort {
  /** The release number this build carries. */
  readonly release: string;
  /** Whether this is a compiled release (a source run has no release to compare with). */
  readonly compiled: boolean;
  /**
   * Whether the daemon asks GitHub for a newer release: a compiled build AND `FY_UPDATE_CHECK` not `off` (the
   * operator / CI switch). The kernel reads the switch, so the plugin never reads the environment.
   */
  readonly checks: boolean;
  executable(): Promise<ExecutableFacts>;
  /** `target` is a release number (`5.1.0`, `v5.1.0-rc.1`); anything else is refused without a launch. */
  launchUpdate(target: string): Promise<UpdateLaunchOutcome>;
}

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
  /**
   * Read-only: whether an owner-named ABSOLUTE path is a directory, and its real path (links and platform aliases
   * resolved). Never creates anything. A relative path, a path that does not exist and a path that is not a directory
   * are refused with a sentence the owner can read.
   */
  checkDirectory(absolutePath: string): Promise<Result<CheckedDirectory, DirectoryRefusal>>;
}

/** {@link PathsPort.checkDirectory} accepted: the canonical path. */
export interface CheckedDirectory {
  readonly realPath: string;
}

/** {@link PathsPort.checkDirectory} refused: why, and the sentence for the person who named the path. */
export interface DirectoryRefusal {
  readonly reason: 'not_absolute' | 'not_a_directory';
  readonly message: string;
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
  /**
   * The product's binary names, single-sourced from the `bin` keys of `packages/cli/package.json` and this package:
   * the client the owner types (`fy`) and the daemon (`fyd`). Plugins name them in sentences and requests from here,
   * never as a literal.
   */
  readonly binaries: BinaryNames;
}

/** The names of the two programs the product ships. */
export interface BinaryNames {
  readonly client: string;
  readonly daemon: string;
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

/** Which hash of its own contract a plugin asks for: the whole effective surface (absent) or its member table only. */
export type ContractSurface = 'member';

/**
 * The contract hash of the plugin that holds this port. With no argument it is the effective hash: the one value
 * `GET /v1/plugins` shows for it. `hash('member')` is the hash over its member-table routes only (§9.6), so a change to
 * its owner routes does not move it; a plugin that declares no member routes has none and the call throws. It takes no
 * id, so a plugin can read its own hash and never another package's (no inventory leak).
 */
export interface ContractPort {
  hash(surface?: ContractSurface): string;
}
