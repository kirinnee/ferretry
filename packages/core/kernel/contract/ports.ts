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
  /**
   * This user's live processes, as pids and yes/no answers only, and SIGTERM to one that runs from this plugin's own
   * folder; only for a manifest with `permissions.processes` ({@link ProcessesPort}).
   */
  readonly processes: ProcessesPort;
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

/**
 * One file's move, as {@link ConfigPort.watchState} hears it: which collection item (`undefined` for a file), the
 * state it is in now, and its disk etag now (`'absent'` when there is no file). Never a value, never a sentence.
 */
export interface ConfigStateChange {
  readonly name?: string;
  readonly state: ConfigFileStatus['state'];
  readonly etag: string;
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
       * Only on a PATCH ({@link ConfigPort.write}, {@link ConfigPort.writeAsCaller} or {@link ConfigPort.writeAsOwner})
       * that left ANOTHER edit of the same file held: the caller's change is in effect and the held edit (made to both versions, still held)
       * waits for the owner.
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
  /**
   * Fires when one of THIS def's files moves on DISK or in state, which {@link watch} does not hear unless the version
   * in effect moved too: an edit written or held for the owner, a held edit confirmed or discarded, a file that broke
   * (`invalid`, its last good version still in effect) or was fixed, one removed (`absent`). One call per file that
   * moved (a collection's item named by `name`), after the reload that saw it; the first load is the baseline, never a
   * change. The change carries the file's state and its disk etag (the etag a write answers), NEVER its text, a value
   * or a sentence ({@link ConfigFileStatus.sentences} stay with {@link fileState}). Another plugin's def throws, as
   * {@link watch} does. A listener that throws is logged and never reaches the writer.
   */
  watchState(def: ConfigFileDef<any> | ConfigCollectionDef<any>, listener: (change: ConfigStateChange) => void): Cancel;
  /** Tells an absent file from an invalid one (and a held one); `name` picks a collection item. */
  fileState(def: ConfigFileDef<any> | ConfigCollectionDef<any>, name?: string): ConfigFileStatus;
  /**
   * The disk etag of ONE of ITS OWN declared files right now (`name` picks a collection item): the very etag
   * {@link write}, {@link writeAsOwner}, {@link remove} and {@link writeAll} compare an `ifMatch` with, or `'absent'`
   * when there is no file. It is the etag ONLY — never the file's text, a value or a sentence — so a plugin that must
   * pin an edit to what a caller read (a profile's layers, say) can do it without being handed the file.
   *
   * Read from the disk when asked, not from the version in effect. Another plugin's def is refused (it throws, as
   * {@link file} does); so is a name that is no file of this def (a name given for a single file, none or a name
   * outside the collection's grammar for a collection).
   */
  etag(def: ConfigFileDef<any> | ConfigCollectionDef<any>, name?: string): Promise<string>;
  /**
   * Writes one of ITS OWN declared files (`name`: the collection item, `undefined` for a file) through the one
   * kernel config writer Gate's config route also uses: only the changed keys are edited, a raw secret is refused,
   * the last good version is kept, and a loosening is put into effect only when Gate's judge
   * (`Admission.judgeConfigWrite`) says this call may; otherwise it is HELD for the owner. Another plugin's def is
   * refused `not_declared`.
   *
   * A PATCH of a file with an edit held for the owner is made to BOTH versions, as {@link writeAsOwner} makes one: the
   * caller's change is judged against the version in effect alone, and the held edit, changed, stays held (answered as
   * `stillHeld`), so a caller who may confirm a loosening never confirms the held one with it. A WHOLE text is the
   * caller's whole text and replaces the held edit.
   */
  write(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: ConfigEdit,
    options?: { readonly ifMatch?: string },
  ): Promise<ConfigWriteOutcome>;
  /**
   * The CALLER's own write of one of this plugin's declared files, for a route whose person authored the edit (an Add
   * form). Judged exactly as {@link write} — the same validation, `ifMatch`, size cap, hold rules, raw-secret refusal
   * and every other check — except for NN2: a `${secret:NAME}` reference the CALLER'S edit adds goes into effect (not
   * held) only when the AMBIENT call, which the kernel carries and a plugin can neither pass nor set, is the owner: the
   * host admin where the request arrived on the host (a relayed loopback is remote), or a governed device that holds the
   * file's configure capability and a passkey that already existed when the call was admitted, claimed once — what
   * `PUT /v1/config/file` asks of an add (`loosen-config`); the unlock alone is not enough, and a passkey proved
   * AFTER the call was admitted is never taken by the call or by work it spawns. A ferret's session credential, a job, a member call and a caller
   * outside a call keep the hold exactly as {@link write} holds it; no option can switch it off for an agent. The act is
   * logged with the file and the secret NAME, never a value, and the kernel never reads a value to judge it.
   *
   * The owner's answer covers ONLY the references the caller's own edit introduces relative to the text it edits. A
   * reference that only an edit already held names keeps the WHOLE write held, whoever asks, and the log credits the
   * owner for its own references alone. A PATCH of a file with an edit held for the owner is made to BOTH versions, as
   * {@link writeAsOwner} makes one (the version in effect, patched and judged as the caller's own act; the held version,
   * patched, stays held and is answered as `stillHeld`), so a patch of one field never puts the held edit into effect;
   * a WHOLE text is the caller's whole text, and replaces the held edit. The question
   * is SYNCHRONOUS (nothing can time out; a missing judge, a throw or no answer holds) and is asked of the standing as
   * it is WHEN THE WRITE HAPPENS, not as it was when the call was admitted: the ambient scope also covers work the call
   * spawns (a timer, a listener) long after it ended, so a device revoked, locked or narrowed since holds. A route that
   * declares no capability and does not consult the grants (`consultsGrants`) gives the call no grant standing, so it
   * holds every caller's add, the host admin's too.
   */
  writeAsCaller(
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
   *
   * `within` (optional) names TOP-LEVEL keys whose mapping the patch MERGES into instead of replacing, in both
   * versions, each into its own mapping — ONE level deep: each sub-key the patch names is replaced whole (`undefined`
   * removes it), and every sub-key it does not name is kept, so a section saved beside a held edit never puts the held
   * version's other sub-keys back to what is in effect (the 2026-10-29 price incident). A named key whose new or
   * current value is not a mapping is replaced as a plain patch replaces it; a key not named is replaced as before.
   * A merge extends the mapping the file itself holds, so a section the file lacks gets no schema defaults written
   * into it. A `within` that is not a list is refused (`schema`), never guessed at. Without `within` the patch is
   * exactly what it was. The schema, the loosening judgement and Gate's judge run on the MERGED versions; the conflict
   * check is made, on the disk's etag, before either version is patched. Both are written or neither, as for any patch.
   */
  writeAsOwner(
    def: ConfigFileDef<any> | ConfigCollectionDef<any>,
    name: string | undefined,
    edit: { readonly patch: Readonly<Record<string, unknown>>; readonly within?: readonly string[] },
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
  /**
   * Writes SEVERAL of its own declared files as ONE act: every document lands, or none does (a change that spans a
   * runtime, its profile and its model set, which must never be half in effect). Each document is checked exactly as
   * {@link write} checks one — its own def (`not_declared`), its name (`bad_name`), YAML, a raw secret, the schema, its
   * own `ifMatch` — and judged for loosening exactly as {@link write} and {@link writeAsOwner} are: against the version
   * in effect, by the same Gate judge with the call's actor, and an added `${secret:NAME}` is held for the owner
   * whatever the judge says. Every document is checked and judged BEFORE anything is written, so:
   *
   * - one document refused refuses the set (`refused`, naming that document), nothing written;
   * - one document stale (its `ifMatch`, or the disk moved since the last reload) is a `conflict` naming it, nothing
   *   written;
   * - one document the judge would HOLD holds the WHOLE set (`held`): nothing in the set is written or takes effect,
   *   and the outcome names every document that would be held, what each loosens, and says that the set is held.
   *   Nothing is left on disk for the owner to confirm: the caller has the owner make the change in an act Gate's judge
   *   lets through (a step-up), and it is then written whole.
   *
   * A document whose file has ANOTHER edit already held for the owner refuses the set (`already_held`): a set never
   * discards a held edit and never carries one into effect. A document whose file cannot be read (a link, over the
   * size cap) refuses it (`unreadable`), because the set could not put it back. The same file named twice refuses it
   * (`duplicate`). An empty set is `written` with no documents.
   *
   * CRASH: before the first file is touched the kernel records the set's intent (each file's text and accepted record
   * as they were) in its own state; the record is removed only once every file and every accepted record is written,
   * and that removal is the commit. A daemon that stops anywhere before it — between two files included — puts every
   * file of the set and its accepted record back as they were on its next load (boot loads first), so the last good
   * version of every document is what is in effect, and none of the set is. A failure that does not stop the daemon
   * (a disk error) puts them back at once and throws.
   */
  writeAll(documents: readonly ConfigWriteAllDocument[]): Promise<ConfigWriteAllOutcome>;
}

/** One document of a {@link ConfigPort.writeAll}: which of its own files, the edit (or its removal), the etag read. */
export interface ConfigWriteAllDocument {
  readonly def: ConfigFileDef<any> | ConfigCollectionDef<any>;
  /** The collection item; `undefined` for a file. */
  readonly name?: string;
  /** A whole new YAML text, a patch of top-level keys, or the file's removal (judged like {@link ConfigPort.remove}). */
  readonly edit: ConfigEdit | { readonly remove: true };
  /** The etag the caller read this document at (`'absent'` for "nothing there"). */
  readonly ifMatch?: string;
}

/** Where one document of a set is: its file under `config/` and, for a collection item, its name. Never a value. */
export interface ConfigDocumentRef {
  readonly path: string;
  readonly name?: string;
}

/**
 * What a {@link ConfigPort.writeAll} did, never thrown (only a disk failure the set was put back from throws):
 * `written` (every document is in effect), `held` (one or more would be held, so NONE was written: `sentence` says so
 * in words), `conflict` (that document moved since it was read), `refused` (that document, or the set, does not check).
 */
export type ConfigWriteAllOutcome =
  | {
      readonly kind: 'written';
      readonly documents: readonly (ConfigDocumentRef & {
        readonly etag: string;
        readonly removed: boolean;
        /** What this document loosened, when the judge let it into effect. */
        readonly loosened: readonly string[];
      })[];
    }
  | {
      readonly kind: 'held';
      /** Every document that would be held, and what each would loosen. */
      readonly held: readonly (ConfigDocumentRef & { readonly sentences: readonly string[] })[];
      /** The plain sentence: which document(s) loosen, that the set is held and that nothing in it was written. */
      readonly sentence: string;
    }
  | ({ readonly kind: 'conflict' } & ConfigDocumentRef)
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'yaml'
        | 'raw_secret'
        | 'schema'
        | 'not_declared'
        | 'bad_name'
        | 'not_a_mapping'
        | 'duplicate'
        | 'already_held'
        | 'unreadable';
      /** The document refused; absent only when the document named no def this plugin declared. */
      readonly document?: ConfigDocumentRef;
      readonly issues: readonly ConfigWriteIssue[];
    };

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
  | 'sessions'
  /**
   * The fleet folder (`<home>/fleet`: the wrappers in `bin/`, one harness home per runtime in `homes/<id>/`, `assets/`,
   * `shared/`, `setup/`, `ids.json`, `manifest.json`): Runtimes alone, even if another plugin declares it. Internal and
   * writable, made `0700` by the kernel, and reached exactly as `agent-homes` is — every call through checked,
   * no-follow descriptors, no link anywhere from the home down to it. A handle may be scoped to ONE relative folder in
   * it (`{ subfolder: 'homes/<id>' }`: one runtime's harness home and nothing beside it).
   */
  | 'fleet'
  /**
   * One harness's OWN home on this machine, as the harness itself resolves it (`CLAUDE_CONFIG_DIR` or `~/.claude`,
   * `CODEX_HOME` or `~/.codex`), for the first-run import's scan: an owner's root, READ-ONLY, Runtimes alone. The
   * handle is scoped to the ABSOLUTE folder the caller names (`{ subfolder: '/home/me/.claude' }`, exactly as
   * `harness-history` is), refuses everything inside the fence, and never follows a link out of that folder.
   */
  | 'harness-home'
  /**
   * A project folder's own files the plugin writes on the owner's behalf (MCP's `<root>/.mcp.json`, Skills'
   * `<root>/.claude/skills/<name>/**`): an owner's root, WRITABLE, and narrowed twice. The handle is scoped PER CALL to ONE
   * absolute folder (`{ subfolder: '/home/me/project' }`, exactly as `harness-home` is) and to the relative paths the
   * manifest declared in `permissions.projectFiles`; a name outside that set is refused `not_declared` whatever the
   * folder holds. A write is as `work`'s is, with this root's one extra rule that a link at ANY level (inside the folder)
   * and a file with a second hard link are refused, never followed. It refuses everything inside the fence.
   *
   * GAP, stated exactly (redesign §7.7): the write is a checked, no-follow DESCRIPTOR write where a path reaches the
   * held folder (`/proc/self/fd`) and where it does not (macOS: the held folder's own `openat`, `renameat`, `unlinkat`,
   * each folder proven by device and inode first), so a folder swapped for a link between the check and the syscall
   * overwrites nothing outside it. A host whose descriptor calls cannot be loaded writes by path after one re-proof, as
   * before. Even with reach the parent is proved, not held (an ABA swap is not seen). No link is made into or out of
   * this root, `copyTree` included.
   *
   * Whether the folder is one Projects or Ferrets names is the PLUGIN ADAPTER's rule, never the kernel's (declared limit,
   * redesign §7.7, which lists what an adapter must check).
   */
  | 'project-files';

/**
 * {@link RootHandle.linkTo}'s target: a name in one of THIS plugin's own root handles (maybe the same one). The link
 * written points at its REAL path, resolved and fenced by that handle, never at text the caller chose.
 */
export interface RootLinkTarget {
  readonly root: RootHandle;
  readonly path: FencedPath;
  /**
   * The target may not exist yet (today's credential link: an empty sign-in slot's file is written by the harness
   * THROUGH the link). Its folder must exist and is resolved and fenced; the missing leaf is judged by name. Without
   * it a missing target is refused, so a link never dangles by accident.
   */
  readonly dangling?: true;
}

/**
 * {@link RootsPort.harnessFile}: ONE file of the host's harness setup, read-only, and nothing beside it — no path
 * argument, no listing, no write. Every read goes through one held descriptor of a regular file with exactly one name
 * (`links === 1`) that is not a link; anything else is refused.
 */
export interface RootFileHandle {
  readonly name: 'harness-home';
  /** The file's absolute path, as the caller named it (never followed). */
  readonly path: string;
  stat(): Promise<RootStat | undefined>;
  lstat(): Promise<RootLstat | undefined>;
  readText(limitBytes?: number): Promise<string>;
  readBytes(limitOrWindow?: number | RootReadWindow): Promise<Uint8Array>;
  fileIdentity(): Promise<RootIdentity | undefined>;
  readDurable<T = RootDurableRead>(
    limitBytes?: number,
    hold?: (read: RootDurableHeld) => Promise<T>,
  ): Promise<T | undefined>;
}

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
   * `true` for a root the kernel makes under the home (`agent-homes`, `downloads`, `credentials`, `sessions`, `fleet`),
   * `false` for an owner's root (`work`, `imports`, `harness-history`, `harness-home`) or one outside the home
   * (`worktrees`). A consumer that must never sit on an owner's folder asserts it.
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
   * skipped, modes kept) or, with `link`, one link at `to` to the source folder's real path. Both ends are fenced. A link is
   * refused `link_escape`, nothing written, when `to` or the source is inside a credential home (the `agent-homes` and
   * `credentials` roots: a folder alias would carry a placed sign-in into another ferret's home).
   */
  copyTree(source: RootHandle, from: FencedPath, to: FencedPath, options?: TreeCopyOptions): Promise<void>;
  /**
   * Materializes a {@link SharedTree} another plugin minted (`RootsPort.share`: Skills' skill folder) at `to` in THIS
   * root, which must be an internal, writable root (`agent-homes`): any other is refused. A copy keeps `copyTree`'s
   * rules exactly (each file read off the disk through a checked descriptor, a link inside skipped, a file with a
   * second hard link skipped, modes kept, `maxEntries`, both ends fenced, a NEW folder at `to`). `link` asks for one
   * link at `to` to the tree's real path instead, and one link is made whenever it is asked for (a tree is always the
   * minter's own opaque state tree, so there is nothing else to weigh). The answer says which was made. A link made
   * stays until the harness removes it: revoking the tree stops new materializations only (a declared GAP).
   * A tree that is forged, rebuilt from its JSON, or whose minter stopped is refused.
   */
  copyShared(tree: SharedTree, to: FencedPath, options?: TreeCopyOptions): Promise<SharedTreeCopied>;
  /**
   * Makes ONE symlink at `to` to a {@link SharedCredential}'s file. Only on `agent-homes`, only by the plugin the credential
   * was minted for, only on a handle scoped to one subfolder (a ferret's home; the kernel does not know which ferret, so
   * the credential is bound to the receiver, not to a ferret), only at `<that folder>/<file>` (the
   * credential's own name, one level) and only when nothing is at `to`. The file must still be the very one minted (same
   * device and inode, one name): otherwise `changed`. Never a copy. This is the ONE call that does not ask the private-place
   * fence about the TARGET (the sign-in file is pinned by inode); the link's PLACE is fenced as usual. The credential is
   * SINGLE-USE: the first link that stays spends it, and any later link with it (after an unlink, or into another
   * ferret's home) is refused `not_shared`; an attempt that made no link does not spend it. The kernel records the link
   * it placed (by the link itself, not its name): `rename` on `agent-homes` refuses (`link_escape`, nothing written) to
   * move it, or a folder holding it, out of the home it was linked into; removing it (`unlink`, `remove`) stays allowed.
   * A link made stays until its holder removes it: revoking the credential stops new links only (a declared GAP).
   */
  linkCredential(credential: SharedCredential, to: FencedPath): Promise<void>;
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
  /**
   * Removes the name, a folder one entry at a time through descriptors. The LEAF IS NEVER FOLLOWED: the folder it sits in is
   * resolved and judged inside the root, then the entry is removed by its own name, so a link at the name goes as a link
   * and what it points at (inside the root or outside it) is untouched. Remove of a folder needs descriptor reach; refused `no_descriptor_reach` without it (macOS until the descriptor bracket lands), and an owner root refuses every remove then. On a host without descriptor reach a file or link of an internal root is unlinked by path after one re-proof of its folder: a parent swapped in between can delete ONE same-named file outside the root, never a tree (declared GAP). [own] BEFORE-GREEN(runtimes) closed by the bracket unit.
   *
   * With `onlyIfEmpty` a folder is removed with `rmdir` semantics: ONE kernel call, empty-check and removal in the same
   * syscall, so a folder that holds any entry (a link included) is refused `not_empty` and nothing is removed, never
   * recursing. A file or link at the name behaves as without the option. A folder without descriptor reach is refused
   * `no_descriptor_reach` exactly as above (the option never widens what a host without reach may remove).
   */
  remove(path: FencedPath, options?: { readonly onlyIfEmpty?: boolean }): Promise<void>;
  /**
   * A symlink at `at` (today's "stored once, never copied" link from a runtime home to the host's credential or
   * history) whose text is the REAL path of `target` in one of THIS plugin's own root handles — the rule `copyTree`'s
   * `link` keeps for a folder, for a file too. Only into an internal, writable root that takes links (`fleet`,
   * `agent-homes`); any other root refuses `read_only`, and another plugin's handle (or a look-alike) `not_declared`.
   * Refused `link_escape` too, nothing written, when `at` or `target` is inside a credential home (the `agent-homes` and
   * `credentials` roots): the dedicated `linkCredential` is the one way a sign-in is linked.
   * `at`'s folder must exist and be reached with no link on the way inside the root (`link_escape`); the link is made
   * through that folder's checked, no-follow descriptor, and refused when anything (a link included) is at the name.
   * A child that follows the link is the harness; the kernel's own reads still never follow it out of the root.
   */
  linkTo(at: FencedPath, target: RootLinkTarget): Promise<void>;
  /**
   * `fchmod` of an EXISTING file or folder at `path`, through a descriptor opened without following a link (a link at
   * the name is refused, never followed): today's provisioner keeping or narrowing a mode. Only permission bits: an
   * internal root keeps `mode & 0o700` (no group or other bit, ever), any other writable root `mode & 0o777` (never
   * setuid, setgid or sticky). Refused on a read-only root (`read_only`), for a file with a second hard link
   * (`hard_link`: its mode is also another name's) and for a mode that is not an integer in `0..0o7777`.
   */
  setMode(path: FencedPath, mode: number): Promise<void>;
  /**
   * Moves the entry at `from` to `to`, both in THIS handle's root (the provisioner moving a file aside as evidence
   * and moving it back to undo: a copy cannot, `copyTree` skips a link inside a home). Only into an internal, writable
   * root that takes links (`fleet`, `agent-homes`); any other root refuses `read_only`. Both ends are fenced and
   * every parent is opened without following a link (`link_escape`); the entry moves AS IS (a link stays a link and is
   * never followed, a directory moves whole; a link keeps the text it holds, so a RELATIVE link moved to a parent at
   * another depth points elsewhere afterwards, while kernel-made links are absolute). The move runs between the two
   * parents' descriptors (on macOS, where no path reaches a held folder, `renameat` between the two proven
   * descriptors), so a host with neither refuses `no_descriptor_reach` and moves nothing. `from` must exist and nothing may be at `to`
   * (`outside`, never overwritten; a look then the move, a declared GAP). Each end's parent folder must already exist
   * (`rename` makes none, as `writeText` does): a missing parent, or one that is a file, is `changed`, and a link on
   * the way to either end is `link_escape` (both ends' links are judged before either parent is opened), except a link
   * that reaches nothing, which is `changed` (its parent cannot be opened), on the testing host as on the real one.
   * There is no copy fallback: a
   * refused move (another device, a folder into itself) is `changed`, with no path or content in it.
   */
  rename(from: FencedPath, to: FencedPath): Promise<void>;
  /**
   * Removes the SYMLINK at `name` and nothing else: the link is never followed and what it points at (inside this root
   * or outside it) is never touched, so a link whose target lies outside the root is still removable (`remove` follows
   * the leaf and refuses that). Only inside an internal, writable root that takes links (`fleet`, `agent-homes`); any
   * other root refuses `read_only`. The name is fenced and every parent is opened without following a link
   * (`link_escape`). A name that is a file or folder, or is absent, is refused `outside` and left as it was. A refused
   * removal is `changed`; no refusal carries a path or content.
   */
  unlink(name: FencedPath): Promise<void>;
}

export interface RootsPort {
  /** Only roots the manifest declared in `permissions.roots`; anything else throws at build. */
  root(
    name: RootName,
    scope?: {
      readonly ferret?: FerretId;
      readonly subfolder?: string;
      /**
       * Optional ANCHOR, for the roots scoped to an absolute folder the caller names (`imports`, `harness-history`,
       * `harness-home`, `project-files`): the folder itself or one of its ancestors (compared component by component,
       * never by string prefix; plain, absolute, never `/`). The anchor ITSELF may be a link (a project folder reached
       * through a linked workspace still works); every folder BELOW it, down to `subfolder`, must be no link, and a
       * `project-files` scope must also resolve to exactly its spelling below the anchor: `realpath(subfolder)` equal to
       * `realpath(within)` joined with `subfolder`'s path relative to `within` (without `within`, `realpath(subfolder)`
       * equal to `subfolder`), else every call is refused `link_escape`. A `project-files` call then reaches its folder by
       * descriptor: the anchor opened once, each component below it opened from its parent's descriptor without following
       * (`O_DIRECTORY | O_NOFOLLOW`), and the leaf acted on through the last one, so a folder swapped for a link after the
       * check reaches nothing. An `imports` READ (a file, a stat, a listing) reaches its folder the same way, so a folder
       * swapped for a link at any step of ONE call reads nothing outside it; only a host with neither a descriptor path
       * nor the C library's calls lists and stats by path behind the link walk, and a host with the calls but not the
       * working-directory bracket lists by path (a listing there can answer an outside folder's names; file reads are
       * still refused by the spelling and identity proofs). An anchor that is not the folder or its ancestor, or one given to a root that takes no
       * absolute folder, names no folder: every call is refused `outside`. A caller that scopes `project-files` to a
       * project the person named passes THAT folder (or the folder it is reached from, when it is a link such as
       * `~/code -> /mnt/...`) as `within`: without it a project under a link is refused `link_escape`, and `within`
       * equal to `subfolder` checks nothing above the folder itself.
       */
      readonly within?: string;
    },
  ): RootHandle;
  /**
   * A read-only handle on exactly ONE file beside a harness home (`~/.claude.json`, which sits BESIDE `~/.claude`, so
   * no `harness-home` scope reaches it): only for a plugin that may hold `harness-home` (Runtimes) and declared it in
   * `permissions.roots`, and only for a basename listed in `permissions.harnessFiles`. The path must be absolute,
   * normalized and outside the fence. Its folder is never listable: the handle names that one file and nothing else.
   * Throws `not_declared` (or `outside` / `fenced` for the path) at the call.
   */
  harnessFile(absolutePath: string): RootFileHandle;
  /**
   * Mints a {@link SharedTree}: ONE existing folder of this plugin's own, handed read-only to whoever receives it
   * (Skills' skill folder in a launch part, for the harness that materializes it with `RootHandle.copyShared`). Only
   * with `permissions.shareTrees`, and only from what this plugin owns: one name of one of its own declared
   * `opaque` named trees (`installed/*`), never a kernel-made root's folder (`credentials`, `sessions`) and never a folder
   * of an owner's root (a project, an imports folder). Valid until this plugin stops.
   */
  share(source: SharedTreeSource): Promise<SharedTree>;
  /**
   * Mints a {@link SharedCredential}: ONE sign-in file of this plugin's own `credentials` root (`<folder>/<file>`), bound to
   * ONE receiving plugin. Only for the plugin that may hold `credentials` (Logins alone) and has declared it, only for a
   * basename listed in `permissions.shareCredentials`, and only for a regular file with one name and no link on the way.
   * Valid until this plugin stops.
   */
  shareCredential(source: SharedCredentialSource): Promise<SharedCredential>;
}

declare const sharedTreeBrand: unique symbol;

/**
 * One folder of its own state a plugin shares, with the plugin that receives it (§7.7, kernel batch #10). Opaque and
 * unforgeable, like a Vault {@link ChildEnvironment}: no field, kept in a kernel table, so a copy, a spread or a JSON
 * round trip (it serialises as `{ shared: <folder name> }` only, never a path) is nothing the kernel will open.
 */
export interface SharedTree {
  readonly [sharedTreeBrand]: true;
}

/** What {@link RootsPort.share} shares: one name of one of the minter's own opaque named trees. */
export type SharedTreeSource = { readonly state: StateFileDef; readonly name: string };

/**
 * What {@link RootHandle.copyShared} made at the destination: a copy, or (when a link was asked for) one link. A link
 * lets the harness child write into the shared folder, so every ferret sharing it sees the change: "read-only" holds
 * for a copy only, and a link made outlives the tree's revocation (both declared GAPs).
 */
export type SharedTreeCopied = 'copied' | 'linked';

declare const sharedCredentialBrand: unique symbol;

/**
 * One sign-in file of the `credentials` root's owner, handed to ONE named receiver to link into its own agent home. Opaque
 * and unforgeable like a {@link SharedTree}: no field, kept in a kernel table; it serialises as `{ credential: <file name> }`
 * only, never the login's folder or a path.
 */
export interface SharedCredential {
  readonly [sharedCredentialBrand]: true;
}

/** What {@link RootsPort.shareCredential} shares. */
export type SharedCredentialSource = {
  /** One plain segment under the `credentials` root: the login's own folder. */
  readonly folder: string;
  /** A basename listed in the minter's `permissions.shareCredentials`. */
  readonly file: string;
  /** The plugin id that alone may materialize it (`'codex'`). */
  readonly receiver: string;
};

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
  /**
   * `start` only: the child gets its own session and process group (setsid), its stdio is ignored and it is
   * unreferenced, so it outlives this daemon (Browsers' platform link opener). Only for a program the manifest lists in
   * `permissions.detached` (a subset of `permissions.spawn`). Refused, before anything starts, with `run`/`runBytes`,
   * `forFerret`, `extraPipes`, `stdin`, a pinned `cwd`, `timeout`, `signal` or a Vault {@link ChildEnvironment}. The
   * handle's streams are empty and closed, `write` and `kill` throw, and `exited` is `null` at once: the kernel never
   * waits on it. The kernel logs the program's name and pid, never its arguments.
   */
  readonly detached?: true;
}

/**
 * What `run` answers. A child that ended by a SIGNAL (its `timeout` ran out, its abort `signal` fired, or something
 * killed it) has no exit code of its own: `exitCode` is `null` and `signal` names the signal (`'SIGTERM'`). A child that
 * exited by itself answers its code and `signal: null`. So `exitCode === null` means a signal ended the child. It is
 * not a perfect timeout test: a child that catches the signal and exits by itself (say, with 143) still answers its own
 * code, so a timeout is not always told apart from a program's own non-zero verdict.
 */
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

// processes ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A folder of one of THIS plugin's own root handles, named the way every root call names one: the kernel resolves it
 * (links followed, fenced, checked to be an existing folder inside the root) and judges with ITS real path, so a
 * plugin cannot point a {@link ProcessesPort} question at a folder it does not hold.
 */
export interface OwnFolder {
  readonly root: RootHandle;
  readonly path: FencedPath;
}

/** What a process signal came to: sent, the process was already gone, or the kernel would not send it. */
export type ProcessSignalOutcome = 'signalled' | 'gone' | 'refused';

/**
 * This user's live processes, for a plugin that must stop what a child it started left behind (Runtimes: an ended
 * Codex ferret's app-server pair). Only for a manifest with `permissions.processes`; every member of any other
 * plugin's port is refused naming it. Today's Codex stopper's rules, held by the kernel so a plugin cannot widen them:
 *
 * - **Pids and yes/no only.** No member returns a command line, a program name or an environment: the kernel reads
 *   `environ` and `cmdline` itself and answers with pids and booleans, so another process's secrets never cross.
 * - **No guessing oracle.** `usersOf` asks only for a variable the manifest lists in `permissions.processes.environment`,
 *   and its value is never free text: it is the real path of a folder of the plugin's OWN root.
 * - **This user's processes only** (the daemon's uid), and never pid 0 or 1, the daemon itself or its ancestors.
 * - **SIGTERM only**, and only to a process whose command line, read again right before the signal, still starts
 *   with the real path of `under` plus `/`. A pid reused between that check and the signal is the one residual
 *   (declared: no pidfd binding).
 * - A question the host cannot answer is `undefined` or `false`, which a caller reads as "leave it running".
 */
export interface ProcessesPort {
  /**
   * Whether a live process of this user runs from beneath `under`: its command line starts with the folder's real
   * path (or the path as the root names it) plus `/`. `false` for a process that is gone, another user's, unreadable,
   * or one the kernel never signals. The command line itself is never returned.
   */
  runsFrom(pid: number, under: OwnFolder): Promise<boolean>;
  /**
   * The pids of this user's live processes whose environment holds EXACTLY `variable=<the folder's path>`, or
   * `undefined` when the host cannot say (which a caller reads as "somebody might"). Refused (throws) for a variable
   * the manifest does not list, or a folder that is not this plugin's own.
   */
  usersOf(variable: string, value: OwnFolder): Promise<readonly number[] | undefined>;
  /**
   * SIGTERM one process, only if it {@link runsFrom} `under` at the moment of the signal. `refused` for a pid the
   * kernel never signals or one that no longer runs from there (a reused pid); `gone` when it had already exited.
   */
  terminate(pid: number, under: OwnFolder): Promise<ProcessSignalOutcome>;
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
  /**
   * A bare executable NAME (`npx`, `claude`) resolved to the path a shell would run, under the kernel's control: only
   * for a manifest with `permissions.which`. The caller's `directories` (absolute; a harness's configured search
   * folders) are searched first, then the daemon's inherited `PATH`; an empty, relative or odd entry is never searched,
   * at most 64 folders are, and the first regular file (links followed) this process may execute wins. A name that is
   * a path, or not one plain command name, is not looked up. NOTHING is executed and no shell is involved; the answer is
   * that path or `undefined`, never the `PATH` itself.
   */
  which(name: string, options?: { readonly directories?: readonly string[] }): Promise<string | undefined>;
  /**
   * Today's harness-paths rule for ONE command: the operator's override variable (`FY_CLOUDFLARED`), else
   * {@link which}. Only for a manifest with `permissions.which` AND `override` listed, exactly, in
   * `permissions.whichOverrides` (`^FY_[A-Z0-9_]{1,60}$`); any other variable is refused naming the plugin, and no
   * other variable is ever read. A set override must be ABSOLUTE, a regular file (links followed) this process may
   * execute, and its basename must be `name` itself: otherwise it is `override_unusable` and the PATH is NOT searched
   * (the operator named a binary; running a different one would leave them believing the opposite). An unset or blank
   * override searches as `which` does. NOTHING is executed.
   */
  locate(
    name: string,
    options: { readonly override: string; readonly directories?: readonly string[] },
  ): Promise<CommandLocation>;
  /**
   * Where ONE command resolves on the `PATH` a Vault {@link ChildEnvironment} handle WILL set, without spending the
   * handle (today's launch guard searched a launch's own PATH). Only for a manifest with `permissions.which`, and only
   * for a handle minted for this plugin or for a plugin that offers a hook this plugin takes (the edge a launch is
   * handed on). The same name grammar, 64-folder bound and regular-file/`X_OK` rule as {@link which}; the daemon's
   * own `PATH` is NOT searched. The answer is a path, `absent`, or `unprovable` — a handle this plugin may not read, a
   * forged or spent one, one that sets no PATH, or one whose PATH was built from a `${secret:…}` reference — so a
   * caller that must prove a negative fails closed. Never the PATH itself, never another variable.
   */
  whichFor(name: string, env: ChildEnvironment): Promise<HandleCommandLookup>;
}

/** {@link PathsPort.locate}'s answer. `override_unusable` names the variable and the path it holds: NO fallback. */
export type CommandLocation =
  | { readonly kind: 'found'; readonly path: string; readonly via: 'override' | 'path' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'override_unusable'; readonly variable: string; readonly path: string };

/**
 * {@link PathsPort.whichFor}'s answer. `unprovable` says only that the handle's PATH could not be searched, never why
 * (a foreign handle and a secret-derived PATH answer alike).
 */
export type HandleCommandLookup =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unprovable' };

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
