import type { FoundationPaths } from './paths.ts';
import type { SessionId } from './session-id.ts';
import type { StateHomeInput } from './state-home.ts';
import type { EventPointer, IndexedSession, JournalFingerprint, RebuildPlan } from './storage-types.ts';
import type { IndexWrite } from './index-writes.ts';

export interface EnvironmentPort {
  stateHomeInput(): StateHomeInput;
  /**
   * The origin of the relay directory this daemon asks which carrier is advertised, or nothing.
   *
   * An ORIGIN, never a carrier: it identifies a service, and the relay address plus the operator's
   * kill switch both live behind it at runtime. `undefined` is a real answer — a build with no
   * directory asks nobody anything and stays direct-only, saying so.
   */
  relayDirectoryOrigin(): string | undefined;
}

export interface ClockPort {
  now(): string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
  /**
   * True only for an ordinary file — never a symlink, socket, device or FIFO.
   *
   * `!directory` is NOT the same question. A decision that admits a named file by name, as the state
   * home's marker-absent recovery does, would otherwise admit a SYMLINK wearing that name, and the
   * bytes it resolves to belong to whoever planted it. So the classification is carried from the
   * directory read itself, where the kind is already known, rather than re-derived by a caller that
   * would have to open the path to ask — and opening is exactly what must not happen, because a
   * FIFO left at that name would block the daemon's bootstrap instead of failing it.
   *
   * Optional so a narrower stand-in need not classify what it does not model. Production always
   * answers it, and every caller that depends on the distinction demands `=== true`, so an absent
   * bit refuses rather than passes.
   */
  readonly regularFile?: boolean;
}

export interface FileInformation extends JournalFingerprint {
  readonly mode: number;
}

export interface DurableAppend {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly fingerprint: JournalFingerprint;
}

/**
 * What an append to an already-existing file found.
 *
 * A result union rather than thrown errors: `lib` stays types-only, and the caller is forced to
 * decide what an absent or swapped journal means instead of inheriting a recreated one by default.
 */
export type DurableAppendOutcome =
  | { readonly kind: 'appended'; readonly append: DurableAppend }
  | { readonly kind: 'absent' }
  | { readonly kind: 'replaced' };

/** Text, and the identity (device, inode, size, change times) of the file it came from. */
export interface IdentifiedText {
  readonly text: string;
  readonly identity: string;
}

export interface FileSystemPort {
  ensureDirectory(path: string, mode: number): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
  listDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  readText(path: string): Promise<string | undefined>;
  /**
   * A file's text together with the identity of the very file it was read from — what {@link identity}
   * reports for that file until it is replaced or changed. Optional: a filesystem without it is read in
   * full every time, which is always correct and only slower.
   */
  readTextIdentified?(path: string): Promise<IdentifiedText | undefined>;
  /**
   * The identity of what `path` names now, by ONE `stat` and no containment walk; `undefined` when it
   * names nothing. Only ever compared with an identity {@link readTextIdentified} returned, which is what
   * makes skipping the walk safe: an identity the walk once proved still names that same proved file.
   */
  identity?(path: string): Promise<string | undefined>;
  readChunks(path: string, chunkSize: number, offset?: number): AsyncIterable<Uint8Array>;
  readSlice(path: string, offset: number, length: number): Promise<Uint8Array | undefined>;
  information(path: string): Promise<FileInformation | undefined>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  /** Creates an empty file, refusing an existing path. Durable: the file and its directory are fsynced. */
  createFileExclusive(path: string, mode: number): Promise<JournalFingerprint>;
  appendLineDurable(path: string, line: string): Promise<DurableAppend>;
  /** Appends only to the exact file `expect` names. Never creates one, never follows a replacement. */
  appendLineToExisting(path: string, line: string, expect: JournalFingerprint): Promise<DurableAppendOutcome>;
  removeFile(path: string): Promise<void>;
  sweepTemporaryFiles(): Promise<void>;
}

export interface FileSystemFactory {
  create(paths: FoundationPaths): FileSystemPort;
}

export interface HomeLockLease {
  release(): Promise<void>;
}

export interface HomeLockFactory {
  acquire(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<HomeLockLease>;
}

export interface SessionIndex {
  replaceAll(plan: RebuildPlan): void;
  replaceSession(session: IndexedSession, events: readonly EventPointer[]): void;
  refreshSession(session: IndexedSession): void;
  appendEvent(session: IndexedSession, event: EventPointer): void;
  appendEvents(session: IndexedSession, events: readonly EventPointer[]): void;
  findSession(id: SessionId): IndexedSession | undefined;
  listSessions(): readonly IndexedSession[];
  eventPointers(id: SessionId, afterSequence: number, limit: number): readonly EventPointer[];
  /** The newest pointers across this daemon's complete session index, bounded before bytes are read. */
  fleetEventPointers(limit: number): readonly EventPointer[];
  countEvents(id: SessionId): number;
  removeSession(id: SessionId): void;
  /** Persists every write still queued, then releases the index. */
  close(): Promise<void>;
}

/**
 * Where the session index's writes are made durable, behind the reads that are answered from memory.
 *
 * `persist` applies one batch, in order, as one transaction: all of it lands or none of it does. It may
 * be asked to apply a batch it already applied — a thread presumed stuck can have committed before it
 * was replaced — so every write must be idempotent on the disk side.
 */
export interface IndexPersister {
  persist(writes: readonly IndexWrite[]): Promise<void>;
  /** Checkpoints and closes the file. Nothing is persisted after it. */
  close(): Promise<void>;
}

export interface SessionIndexFactory {
  open(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<SessionIndex>;
}

export interface SerialExecutor {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}
