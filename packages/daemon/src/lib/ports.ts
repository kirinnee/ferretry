import type { FoundationPaths } from './paths.ts';
import type { SessionId } from './session-id.ts';
import type { StateHomeInput } from './state-home.ts';
import type { EventPointer, IndexedSession, JournalFingerprint, RebuildPlan } from './storage-types.ts';

export interface EnvironmentPort {
  stateHomeInput(): StateHomeInput;
}

export interface ClockPort {
  now(): string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
}

export interface FileInformation extends JournalFingerprint {
  readonly mode: number;
}

export interface DurableAppend {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly fingerprint: JournalFingerprint;
}

export interface FileSystemPort {
  ensureDirectory(path: string, mode: number): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
  listDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  readText(path: string): Promise<string | undefined>;
  readChunks(path: string, chunkSize: number, offset?: number): AsyncIterable<Uint8Array>;
  readSlice(path: string, offset: number, length: number): Promise<Uint8Array | undefined>;
  information(path: string): Promise<FileInformation | undefined>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  appendLineDurable(path: string, line: string): Promise<DurableAppend>;
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
