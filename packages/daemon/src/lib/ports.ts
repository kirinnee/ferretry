import type { FoundationPaths } from './paths.ts';
import type { SessionId } from './session-id.ts';
import type { StateHomeInput } from './state-home.ts';
import type { EventPointer, IndexedSession, JournalFingerprint, RebuildPlan } from './storage-types.ts';

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

export interface FileSystemPort {
  ensureDirectory(path: string, mode: number): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
  listDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  readText(path: string): Promise<string | undefined>;
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
  close(): void;
}

export interface SessionIndexFactory {
  open(paths: FoundationPaths, fileSystem: FileSystemPort): Promise<SessionIndex>;
}

export interface SerialExecutor {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}
