/**
 * The seams the runtimes plugin's adapters read and write the host through.
 *
 * A plugin reaches the clock, the file system, the environment and processes only through the kernel's ports
 * (`banned-globals`). The adapters in this folder take the narrow interfaces below, and the kernel's roots (the `fleet`
 * and `harness-home` roots, `daemon/host-assembly.ts`) or a test supply the implementation. Nothing here falls back to
 * `node:fs`.
 */
import type { RuntimeRename } from '../lib/service/foreign.ts';
import type { DisplacedState, FleetApplyPlan, FleetApplyPreview, UnrestoredPath } from '../lib/provisioning.ts';
import type { FleetDisk } from './fleet-disk.ts';

// ─── host files (read side) ──────────────────────────────────────────────────────────────────────────────────────

/** What a host entry is, as `lstat` (never following a link) or `stat` (following one) says. */
export interface HostEntry {
  readonly kind: 'file' | 'directory' | 'link' | 'other';
  readonly size: number;
}

/**
 * The host's files, by absolute path, read only. A missing path answers `undefined`; any other failure throws, so a
 * caller can tell an absent document from an unreadable one.
 *
 * GAP(kernel): `RootHandle` (`kernel.roots`) resolves a RELATIVE path inside a declared root, answers no link kind and
 * cannot be asked for a person's real home, and `RootName` has no root for the harness homes this reads. Until the
 * kernel declares one, no implementation exists in the plugin.
 */
export interface HostFiles {
  /** The UTF-8 text of the file, or `undefined` when nothing is at the path. */
  readText(path: string): Promise<string | undefined>;
  /** The bytes of the file, or `undefined` when nothing is at the path. */
  readBytes(path: string): Promise<Uint8Array | undefined>;
  /** The entry, following a link; `undefined` when nothing is at the path (or an ancestor is not a directory). */
  stat(path: string): Promise<HostEntry | undefined>;
  /** The entry itself, never followed; `undefined` when nothing is at the path. */
  lstat(path: string): Promise<HostEntry | undefined>;
  /** The names in a directory, or `undefined` when nothing is at the path. */
  list(path: string): Promise<readonly string[] | undefined>;
}

/** Looking a bare command name up on this machine's `PATH` (`kernel.paths.which`, resolved before it is asked). */
interface CommandLocator {
  which(name: string): string | undefined;
}

/**
 * Whole-file text the daemon owns outside `state/` (the clone record, the export-key file): an atomic read and write.
 *
 * Backed by the `fleet` root (`daemon/host-assembly.ts`): the clone record and the export-key file are files of the fleet
 * folder.
 */
interface TextStore {
  /** `null` when the file does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}

// ─── the configuration files (kernel-owned) ──────────────────────────────────────────────────────────────────────

/**
 * One configuration file edit: its path under `config/`, and either the new text (`undefined` with no patch removes it)
 * or a patch of top-level keys the kernel's writer applies to the file it holds (`undefined` removes a key). `expect` is
 * the etag it was composed against, when the caller read one.
 */
interface ConfigFileEdit {
  readonly path: string;
  readonly content?: string | undefined;
  readonly patch?: Readonly<Record<string, unknown>>;
  readonly expect?: string;
}

/**
 * What a load of the configuration directory holds, as the catalogue reads it. `model` is the account model in effect;
 * `files` is opaque here and handed back to {@link ConfigFilesPort} to compose edits against.
 *
 * GAP(kernel): the config-files evaluator, its edit renderer (`fleetFileEdits`, `renamedRuntimeMentions`) and the
 * acknowledgement of a written file are kernel-owned, and plugins have no config WRITE port. This is the shape the
 * catalogue needs of them.
 */
interface ConfigLoad<Model, Files = unknown> {
  readonly evaluation: {
    /** How many fleet files the load found; zero is a machine with no fleet files yet. */
    readonly fleetFiles: number;
    readonly fleetRevision: string;
    readonly effective: { readonly model: Model };
  };
  readonly files: Files;
}

export interface ConfigFilesPort<Model> {
  /** The last load. */
  inEffect(): Promise<ConfigLoad<Model>>;
  /** Loads the directory first. */
  load(): Promise<ConfigLoad<Model>>;
  /** The edits that move the model in `load` to `next`; `moved` is new path → old path for a renamed runtime's file. */
  editsFor(load: ConfigLoad<Model>, next: Model, moved: ReadonlyMap<string, string>): readonly ConfigFileEdit[];
  /** The edits that re-point every non-fleet file naming the runtime `rename.from` at `rename.to`. */
  mentionsRenamed(load: ConfigLoad<Model>, rename: RuntimeRename): readonly ConfigFileEdit[];
}

/**
 * The kernel's config service as a Clone's settings merge uses it: the same service `PUT /v1/config/file` writes through.
 *
 * GAP(kernel): plugins have no config WRITE port; only the kernel's host can write `config/**`.
 */
export interface ConfigFileService {
  file(path: string): Promise<{ readonly exists: boolean; readonly text: string; readonly etag: string }>;
  inEffect(): Promise<{
    readonly evaluation: { readonly effective: Readonly<Record<'warden' | 'learning' | 'voice', unknown>> };
  }>;
  validate(
    path: string,
    text: string,
  ): Promise<readonly { readonly severity: 'error' | 'warning'; readonly message: string; readonly line?: number }[]>;
  write(
    path: string,
    text: string,
    ifMatch: string,
    mayLoosen: boolean,
    as: 'owner',
  ): Promise<{ readonly outcome: 'applied' | 'pending' }>;
}

// ─── the provisioner's disk ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The provisioner's disk is `FleetDisk` (`./fleet-disk.ts`): every call an ASYNCHRONOUS call on the kernel's `fleet`
 * root, with a component source served only from the fleet's assets and the harness homes. There is no descriptor
 * surface, no hard link and no raw path in this plugin; what a hard link did becomes a rename onto a free name, and what a
 * raw-path source did is refused in a sentence.
 */

/** Everything one apply moved aside, so a failure can put it back (`./mutation-journal.ts`). */
export interface MutationJournal {
  beginOperation(): number;
  sealOperation(from: number): Promise<void>;
  /** Runs `read` with the name the capture of `target` moved it to; `undefined` when nothing was there. */
  withBackup<T>(target: string, read: (backup: string) => Promise<T>): Promise<T | undefined>;
  capture(target: string): Promise<boolean>;
  captureDirectory(target: string, mode?: number): Promise<void>;
  rollback(): Promise<{
    readonly unrestored: readonly UnrestoredPath[];
    readonly displaced: readonly DisplacedState[];
  }>;
  discard(): Promise<readonly string[]>;
  displace(target: string, isOwnWork: (moved: string) => Promise<boolean>): Promise<void>;
}

/** The exclusive claim every fleet apply takes, beside the manifest (`./apply-claim.ts`). */
export interface ApplyLock {
  readonly path: string;
  acquire(): Promise<string>;
  /** Releases the claim; answers the path of a claim that could not be cleared. */
  release(token: string): Promise<string | undefined>;
}

/** The shared-history side of an apply; `conversation` owns it. */
type SharedHistoryRequest = NonNullable<FleetApplyPlan['sharedHistoryRequests']>[number];
type SharedHistoryPreview = FleetApplyPreview['sharedHistory'][number];

/** GAP(conversation): the shared-history migration and its file-system adapter live with the lease store. */
export interface SharedHistoryPooling {
  preview(request: SharedHistoryRequest): Promise<SharedHistoryPreview>;
  materialize(request: SharedHistoryRequest): Promise<SharedHistoryPreview>;
  /** Whether the failure is "this host cannot make the migration safely": skipped and named, never fatal. */
  isUnavailable(error: unknown): boolean;
}

// ─── the refusals ────────────────────────────────────────────────────────────────────────────────────────────────

/** The sentence a refused seam gives: what is missing, and that nothing else was tried. */
const missing = (what: string): Error =>
  new Error(
    `${what} is not available to the Runtimes plugin yet: the kernel declares no way to reach it, and Runtimes does not read the host around the kernel`,
  );

/** A {@link HostFiles} that refuses every call. */
export const refusedHostFiles: HostFiles = {
  readText: async () => await Promise.reject(missing("the host's files")),
  readBytes: async () => await Promise.reject(missing("the host's files")),
  stat: async () => await Promise.reject(missing("the host's files")),
  lstat: async () => await Promise.reject(missing("the host's files")),
  list: async () => await Promise.reject(missing("the host's files")),
};

/** What the adapters need of the host, whole. */
export interface AdapterHost {
  readonly files: HostFiles;
  readonly texts: TextStore;
  readonly commands: CommandLocator;
  /** The provisioner's disk: the fleet root and the folders a component may come from. */
  readonly disk: FleetDisk;
  /** Milliseconds since the epoch, from the kernel's clock. */
  readonly now: () => number;
  /** The apply claim for the fleet whose manifest is at the path (one claim per fleet, however many provisioners). */
  readonly claimFor: (manifestPath: string) => ApplyLock;
}
