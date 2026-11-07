/**
 * The seams the runtimes plugin's adapters read and write the host through.
 *
 * A plugin reaches the clock, the file system, the environment and processes only through the kernel's ports
 * (`banned-globals`). The adapters in this folder were written over `node:fs`, `process.env` and `Bun.which`; they now
 * take the narrow interfaces below instead, and a test (or the kernel's host) supplies the implementation.
 *
 * WHAT IS IMPLEMENTED FROM `KernelPorts`, and what is not. The frozen manifest declares `permissions.roots: []` and
 * `permissions.spawn: ['brew', 'apt-get', 'npm']`, so `kernel.roots.root(...)` throws at build and `kernel.spawn` may not
 * run `which`. What the declaration does allow is the clock. {@link adapterHostFrom} therefore wires `now` from
 * `kernel.clock` and answers every other seam with a REFUSAL that says in one plain sentence what is missing; it never
 * falls back to `node:fs`. Each refusal sits beside a `GAP(<owner>)` comment naming the missing piece.
 */
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { StoredCredentialResolution } from '../lib/account/credentials.ts';
import type { CredentialMaterial } from '../lib/identity.ts';
import type { RuntimeRename } from '../lib/service/foreign.ts';
import type {
  DisplacedState,
  FleetApplyPlan,
  FleetApplyPreview,
  UnrestoredPath,
} from '../lib/provisioning.ts';

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

/** Looking a bare command name up on this machine's `PATH`. GAP(kernel): `kernel.spawn` may not run `which`. */
export interface CommandLocator {
  which(name: string): string | undefined;
}

/**
 * Whole-file text the daemon owns outside `state/` (the clone record, the export-key file): an atomic read and write.
 *
 * GAP(kernel): `kernel.state` serves only declared `state/runtimes/…` files and there is no config WRITE port, so a
 * path under `fleet/` or `config/` has no home. The kernel's atomic file writer is not exported to plugins.
 */
export interface TextStore {
  /** `null` when the file does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
}

// ─── the configuration files (kernel-owned) ──────────────────────────────────────────────────────────────────────

/** One configuration file edit: its path under `config/`, the new text (`undefined` removes it) and the etag it was composed against. */
export interface ConfigFileEdit {
  readonly path: string;
  readonly content: string | undefined;
  readonly expect: string;
}

/**
 * What a load of the configuration directory holds, as the catalogue reads it. `model` is the account model in effect;
 * `files` is opaque here and handed back to {@link ConfigFilesPort} to compose edits against.
 *
 * GAP(kernel): the config-files evaluator, its edit renderer (`fleetFileEdits`, `renamedRuntimeMentions`) and the
 * acknowledgement of a written file are kernel-owned, and plugins have no config WRITE port. This is the shape the
 * catalogue needs of them.
 */
export interface ConfigLoad<Model, Files = unknown> {
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
  acknowledge(path: string, content: string): void;
  acknowledgeRemoval(path: string): void;
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

// ─── the provisioner's disk (descriptors) ────────────────────────────────────────────────────────────────────────

/** Which file an entry is: what kind, and the device and inode that name it whatever path reached it. */
export interface FileIdentity {
  readonly kind: 'file' | 'directory' | 'link' | 'other';
  readonly device: bigint;
  readonly inode: bigint;
  /** How many names (hard links) the file has. */
  readonly links: number;
  readonly size: number;
  /** The permission bits. */
  readonly mode: number;
  readonly owner: number;
  readonly group: number;
  /** When its content last changed, in nanoseconds, where the disk says. */
  readonly modified?: bigint;
  /** When its entry last changed, in nanoseconds, where the disk says. */
  readonly changed?: bigint;
}

/**
 * The file-level calls the provisioner makes by path or by raw descriptor. A descriptor is a number the caller closes.
 *
 * GAP(kernel): `node:fs` descriptors (`openSync` with `O_NOFOLLOW`, `fstatSync`, `readSync`, `writeSync`, `fchmodSync`)
 * and `cp` are not reachable from a plugin; `RootHandle` has no descriptor surface.
 */
export interface ProvisionerDisk {
  /** The canonical form of an existing path; throws `ENOENT`/`ENOTDIR` when it does not exist. */
  realpath(path: string): Promise<string>;
  /** Whether the entry at `path` (following a link) is a directory; throws when nothing is there. */
  statIsDirectory(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** The names in a directory. */
  list(path: string): Promise<readonly string[]>;
  /** The entry at `path` itself, never followed. */
  identity(path: string): Promise<FileIdentity>;
  /** Copies `source` to the new entry `destination`, every link in the source followed. */
  copyTree(source: string, destination: string, options: { readonly recursive: boolean }): Promise<void>;
  /** Opens a file to read, without following a final link and without blocking on a pipe. */
  openForProof(path: string): number;
  /** Whether the open descriptor is a regular file. */
  isRegular(descriptor: number): boolean;
  /** Reads into `buffer` at `offset` from `position`; answers the bytes read (0 at the end). */
  readAt(descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  /** Writes from `bytes` at `offset`; answers the bytes written. */
  write(descriptor: number, bytes: Uint8Array, offset: number, length: number): number;
  fchmod(descriptor: number, mode: number): void;
  close(descriptor: number): void;
}

// ─── the provisioner's kernel-owned helpers ──────────────────────────────────────────────────────────────────────

/** How a file is opened through a checked folder. */
export type FileOpening = 'read' | 'new';

/**
 * A folder that was opened and checked: every entry in it is reached THROUGH it, never by what its path names later.
 * The members the provisioner uses; the kernel's guard owns the rest.
 *
 * GAP(kernel): `state-home-guard` / `descriptor-io` (fence and descriptor machinery).
 */
export interface GuardedFolder {
  /** Its real path when it was checked. */
  readonly path: string;
  readonly identity: FileIdentity;
  /** A path that reaches the ONE entry `leaf` in this folder (a name with no `/`). */
  entry(leaf: string): Promise<string>;
  /** The entry `leaf` itself (`lstat`), never followed; `undefined` when nothing is there. */
  describe(leaf: string): Promise<FileIdentity | undefined>;
  list(): Promise<readonly string[]>;
  /** Makes the folder `leaf` (not recursive; a name already taken fails with `EEXIST`). */
  mkdir(leaf: string, mode: number): Promise<void>;
  symlink(target: string, leaf: string): Promise<void>;
  /** Hard-links `fromLeaf` in `from` as `leaf` here; a name already taken fails with `EEXIST`. */
  link(from: GuardedFolder, fromLeaf: string, leaf: string): Promise<void>;
  /** A raw descriptor on the file `leaf`; the caller closes it. */
  openFile(leaf: string, how: FileOpening, mode?: number): Promise<number>;
  /** Sets its permission bits through the descriptor. */
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

/** The disk the destination side judges folders on. Opaque here: handed to the kernel's helper untouched. */
export type FolderDisk = object;

/** The daemon's own directories, which no copy or link may take a source from. */
export interface SourceFence {
  /** The daemon's own directories — its state home, then its state and config directories. */
  readonly homes: readonly string[];
  /** Inside a home but open all the same: the fleet's asset tree. */
  readonly open: readonly string[];
  readonly hardLinkRoots?: readonly string[];
  /** The home's key files and folders, judged by identity wherever they are met. */
  readonly pinned?: readonly string[];
  readonly homesMayBeUnmade?: boolean;
}

/** The fence as the disk has it now. `homes` is opaque here: handed to the kernel's helpers untouched. */
export interface ResolvedSourceFence {
  readonly homes: unknown;
}

/** Why the guard refused a source. */
export type SourceRefusalRule = 'state-home' | 'hard-link' | 'changed' | 'not-found' | 'loop' | 'too-many';

/** Where the folders of a plan's destinations are opened and checked. */
export interface DestinationFolders {
  /** Whether moving or removing in this folder is refused on this platform. */
  confined(folder: GuardedFolder): Promise<boolean>;
  existing(folder: string): Promise<GuardedFolder | undefined>;
  made(folder: string, mode: number): Promise<GuardedFolder>;
  child(parent: GuardedFolder, leaf: string, label: string, mode?: number): Promise<GuardedFolder>;
  remove(folder: GuardedFolder, leaf: string): Promise<void>;
  removeOwnFile(folder: GuardedFolder, leaf: string): Promise<void>;
  within<T>(folder: string, use: (opened: GuardedFolder | undefined) => Promise<T>): Promise<T>;
}

/** Everything one apply moved aside, so a failure can put it back. */
export interface MutationJournal {
  readonly folders: DestinationFolders;
  beginOperation(): number;
  sealOperation(from: number): Promise<void>;
  withBackup<T>(target: string, read: (folder: GuardedFolder, backup: string) => Promise<T>): Promise<T | undefined>;
  capture(target: string, folder?: GuardedFolder): Promise<boolean>;
  captureDirectory(target: string, mode?: number): Promise<void>;
  rollback(): Promise<{ readonly unrestored: readonly UnrestoredPath[]; readonly displaced: readonly DisplacedState[] }>;
  discard(): Promise<readonly string[]>;
  displace(target: string, isOwnWork: (moved: string) => Promise<boolean>): Promise<void>;
}

/** The exclusive claim every fleet apply takes, beside the manifest. */
export interface ApplyLock {
  readonly path: string;
  acquire(): Promise<string>;
  /** Releases the claim; answers the path of a claim that could not be cleared. */
  release(token: string): Promise<string | undefined>;
}

export interface ApplyLockOptions {
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly isOwnerAlive?: (owner: number) => boolean;
  readonly now?: () => number;
}

/** The shared-history side of an apply; `conversation` owns it. */
export type SharedHistoryRequest = NonNullable<FleetApplyPlan['sharedHistoryRequests']>[number];
export type SharedHistoryPreview = FleetApplyPreview['sharedHistory'][number];

/** GAP(conversation): the shared-history migration and its file-system adapter live with the lease store. */
export interface SharedHistoryPooling {
  preview(request: SharedHistoryRequest): Promise<SharedHistoryPreview>;
  materialize(request: SharedHistoryRequest): Promise<SharedHistoryPreview>;
  /** Whether the failure is "this host cannot make the migration safely": skipped and named, never fatal. */
  isUnavailable(error: unknown): boolean;
}

/**
 * The helpers the provisioner needs and a plugin cannot import: the apply claim, the mutation journal, the destination
 * folders, the source fence and the descriptor calls under them. It is parameterised over them and copies none.
 *
 * GAP(kernel): apply-lock, fenced-source, mutation-journal, directory-syscalls, node-guard-disk, destination-folders and
 * the link/descriptor syscalls are kernel-owned (placement: kernel, "fence/descriptor io") and the kernel exports no port
 * for them yet. {@link refusedProvisionerKernel} is the only implementation until it does.
 */
export interface ProvisionerKernel {
  /** The claim for the fleet whose manifest is at `manifestPath`. */
  applyLockFor(manifestPath: string, options?: ApplyLockOptions): ApplyLock;
  /** The destination side, judged against the resolved fence's homes; `tops` are the runtimes' own folders. */
  destinationFolders(
    homes: ResolvedSourceFence['homes'] | undefined,
    disk: FolderDisk | undefined,
    tops: readonly string[],
  ): DestinationFolders;
  /** A journal whose restores re-check `assertWritable`. */
  mutationJournal(assertWritable: (target: string) => Promise<void>, folders: DestinationFolders): MutationJournal;
  /** Whether an entry name is one a journal or a staged copy minted. */
  isMutationReservedName(name: string): boolean;
  readonly stagePrefix: string;
  /** The bytes of the regular file `leaf` of a checked folder, read without following a link or blocking. */
  readFolderFile(folder: GuardedFolder, leaf: string): Promise<Buffer>;
  /** The refusal for a destination whose folder is reached by path, where a swap could redirect a move. */
  confinedDestination(target: string): Error;
  isConfinedDestination(error: unknown): boolean;
  resolveSourceFence(fence: SourceFence): Promise<ResolvedSourceFence>;
  /** Throws when the guard refuses `source`; answers its real path. */
  assertSourceUnfenced(fence: ResolvedSourceFence, source: string): Promise<string>;
  /** Copies `source` into the new entry `leaf` of `folder`, refusing the whole copy when any hop is inside a home. */
  copyFencedSourceInto(fence: ResolvedSourceFence, source: string, folder: GuardedFolder, leaf: string): Promise<void>;
  /**
   * The text of one component document, read through the guard: `undefined` when it is absent, not a file, over
   * `maxBytes` or unreadable; throws when the guard holds it inside a home.
   */
  readFencedSource(fence: ResolvedSourceFence, source: string, maxBytes: number): Promise<string | undefined>;
  /** The home `path` is inside by name, if any. */
  fencedBy(fence: SourceFence, path: string): string | undefined;
  /** The refusal for a source inside a home (`state-home`, with the home) or refused by another rule. */
  sourceRefusal(source: string, rule: SourceRefusalRule, home?: string): Error;
}

/** Both halves of the provisioner's host. */
export interface ProvisionerHost {
  readonly disk: ProvisionerDisk;
  readonly kernel: ProvisionerKernel;
}

// ─── logins (credential reads) ───────────────────────────────────────────────────────────────────────────────────

/**
 * Reading one account-model credential's raw material from its one store. The platform store satisfies it.
 *
 * GAP(logins): the credential classifier lives with Logins; this is the one method the scan calls.
 */
export interface StoredCredentialMaterialReader {
  storedMaterial(resolution: StoredCredentialResolution): Promise<CredentialMaterial>;
}

// ─── the refusals ────────────────────────────────────────────────────────────────────────────────────────────────

/** The sentence a refused seam gives: what is missing, and that nothing else was tried. */
const missing = (what: string): Error =>
  new Error(
    `${what} is not available to the Runtimes plugin yet: the kernel declares no way to reach it, and Runtimes does not read the host around the kernel`,
  );

const refuse = (what: string) => (): never => {
  throw missing(what);
};

/** A {@link HostFiles} that refuses every call. GAP(kernel): no root is declared for the host's harness homes. */
export const refusedHostFiles: HostFiles = {
  readText: async () => await Promise.reject(missing("the host's files")),
  readBytes: async () => await Promise.reject(missing("the host's files")),
  stat: async () => await Promise.reject(missing("the host's files")),
  lstat: async () => await Promise.reject(missing("the host's files")),
  list: async () => await Promise.reject(missing("the host's files")),
};

/** A {@link TextStore} that refuses every call. GAP(kernel): no state file is declared for the fleet's records. */
export const refusedTextStore: TextStore = {
  read: async () => await Promise.reject(missing("the fleet's record files")),
  write: async () => await Promise.reject(missing("the fleet's record files")),
};

/** A {@link CommandLocator} that refuses. GAP(kernel): `kernel.spawn` may not run `which`. */
export const refusedCommandLocator: CommandLocator = { which: refuse("the search of this machine's PATH") };

const refusedFiles = refuse("the provisioner's file calls");

/** A {@link ProvisionerDisk} that refuses every call. */
export const refusedProvisionerDisk: ProvisionerDisk = {
  realpath: async () => await Promise.reject(missing("the provisioner's file calls")),
  statIsDirectory: async () => await Promise.reject(missing("the provisioner's file calls")),
  readText: async () => await Promise.reject(missing("the provisioner's file calls")),
  readBytes: async () => await Promise.reject(missing("the provisioner's file calls")),
  list: async () => await Promise.reject(missing("the provisioner's file calls")),
  identity: async () => await Promise.reject(missing("the provisioner's file calls")),
  copyTree: async () => await Promise.reject(missing("the provisioner's file calls")),
  openForProof: refusedFiles,
  isRegular: refusedFiles,
  readAt: refusedFiles,
  write: refusedFiles,
  fchmod: refusedFiles,
  close: refusedFiles,
};

const refusedHelpers = refuse("the checked-folder, journal and apply-claim helpers");

/** A {@link ProvisionerKernel} that refuses every call: applying a fleet plan needs the kernel's descriptor helpers. */
export const refusedProvisionerKernel: ProvisionerKernel = {
  applyLockFor: refusedHelpers,
  destinationFolders: refusedHelpers,
  mutationJournal: refusedHelpers,
  isMutationReservedName: refusedHelpers,
  stagePrefix: '.fy-fleet-staged-',
  readFolderFile: async () => await Promise.reject(missing('the checked-folder helpers')),
  confinedDestination: refusedHelpers,
  isConfinedDestination: () => false,
  resolveSourceFence: async () => await Promise.reject(missing('the source fence')),
  assertSourceUnfenced: async () => await Promise.reject(missing('the source fence')),
  readFencedSource: async () => await Promise.reject(missing('the source fence')),
  copyFencedSourceInto: async () => await Promise.reject(missing('the source fence')),
  fencedBy: refusedHelpers,
  sourceRefusal: refusedHelpers,
};

/** What the adapters need of the host, whole. */
export interface AdapterHost {
  readonly files: HostFiles;
  readonly texts: TextStore;
  readonly commands: CommandLocator;
  readonly provisioner: ProvisionerHost;
  /** Milliseconds since the epoch, from the kernel's clock. */
  readonly now: () => number;
}

/**
 * The host as `KernelPorts` can give it today: the clock, and a refusal for everything the frozen manifest does not
 * let the plugin reach. `overrides` swaps a seam for a real implementation (a test's temp-dir one, or the kernel's own
 * once it exports the helpers).
 */
export function adapterHostFrom(
  kernel: Pick<KernelPorts, 'clock'>,
  overrides: Partial<Omit<AdapterHost, 'now'>> = {},
): AdapterHost {
  return {
    files: overrides.files ?? refusedHostFiles,
    texts: overrides.texts ?? refusedTextStore,
    commands: overrides.commands ?? refusedCommandLocator,
    provisioner: overrides.provisioner ?? { disk: refusedProvisionerDisk, kernel: refusedProvisionerKernel },
    now: () => kernel.clock.nowMs(),
  };
}
