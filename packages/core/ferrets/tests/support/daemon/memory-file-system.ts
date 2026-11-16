/**
 * An in-memory `FileSystemPort` (`daemon/lib/ports.ts`) for the session adapters that still take one (the auto-resume
 * ledgers, the health stamp and event files, the terminal pane registrations). Paths are plain strings; a directory
 * exists once something was written under it or it was ensured. Nothing touches the disk.
 */
import { dirname } from 'node:path';
import type {
  DirectoryEntry,
  DurableAppend,
  DurableAppendOutcome,
  FileInformation,
  FileSystemPort,
  IdentifiedText,
} from '../../../daemon/lib/ports.ts';
import type { JournalFingerprint } from '../../../daemon/lib/storage-types.ts';
import { createFoundationPaths, type FoundationPaths } from '../../../daemon/lib/paths.ts';
import { parseAbsoluteHome } from '../../../daemon/lib/state-home.ts';

interface MemoryFile {
  bytes: Uint8Array;
  mode: number;
  inode: number;
  modifiedAtMs: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, MemoryFile>();
  readonly directories = new Map<string, number>();
  /** Every path read with `readChunks`, in order: what separates a shallow pass from a full one. */
  readonly chunkReads: string[] = [];
  /** When set, any path outside this directory is refused: every call naming one throws, as a contained filesystem does. */
  refusedOutside: string | undefined;
  private inodes = 0;
  private ticks = 0;

  /** Milliseconds a write stamps; each write moves it forward so a later write is always newer. */
  constructor(private readonly startMs = Date.parse('2026-01-01T00:00:00.000Z')) {}

  private stamp(): number {
    this.ticks += 1;
    return this.startMs + this.ticks;
  }

  private fingerprint(file: MemoryFile): JournalFingerprint {
    return { device: 'memory', inode: String(file.inode), size: file.bytes.length, modifiedAtMs: file.modifiedAtMs };
  }

  private ensureParents(path: string): void {
    for (let current = dirname(path); !this.directories.has(current); current = dirname(current)) {
      this.directories.set(current, 0o700);
      if (dirname(current) === current) break;
    }
  }

  private contain(path: string): void {
    const root = this.refusedOutside;
    if (root !== undefined && path !== root && !path.startsWith(`${root}/`))
      throw Object.assign(new Error(`EACCES: ${path} is outside ${root}`), { code: 'EACCES' });
  }

  private put(path: string, bytes: Uint8Array, mode = 0o600): MemoryFile {
    this.contain(path);
    this.ensureParents(path);
    const file = { bytes, mode, inode: ++this.inodes, modifiedAtMs: this.stamp() };
    this.files.set(path, file);
    return file;
  }

  /** The text at `path`, for an assertion; `undefined` when nothing is there. */
  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file === undefined ? undefined : decoder.decode(file.bytes);
  }

  /** Plants `text` at `path` as if something else wrote it. */
  plant(path: string, text: string): void {
    this.put(path, encoder.encode(text));
  }

  async ensureDirectory(path: string, mode: number): Promise<void> {
    this.ensureParents(`${path}/x`);
    this.directories.set(path, mode);
  }

  async setMode(path: string, mode: number): Promise<void> {
    const file = this.files.get(path);
    if (file !== undefined) file.mode = mode;
    else if (this.directories.has(path)) this.directories.set(path, mode);
  }

  async listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    const names = new Map<string, boolean>();
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const name of this.files.keys())
      if (name.startsWith(prefix)) {
        const rest = name.slice(prefix.length);
        const [head = '', ...tail] = rest.split('/');
        names.set(head, (names.get(head) ?? false) || tail.length > 0);
      }
    for (const name of this.directories.keys())
      if (name.startsWith(prefix)) names.set(name.slice(prefix.length).split('/')[0] ?? '', true);
    return [...names].map(([name, directory]) => ({ name, directory, regularFile: !directory }));
  }

  async readText(path: string): Promise<string | undefined> {
    this.contain(path);
    return this.text(path);
  }

  async readTextIdentified(path: string): Promise<IdentifiedText | undefined> {
    const file = this.files.get(path);
    if (file === undefined) return undefined;
    return { text: decoder.decode(file.bytes), identity: JSON.stringify(this.fingerprint(file)) };
  }

  async identity(path: string): Promise<string | undefined> {
    const file = this.files.get(path);
    return file === undefined ? undefined : JSON.stringify(this.fingerprint(file));
  }

  async *readChunks(path: string, chunkSize: number, offset = 0): AsyncIterable<Uint8Array> {
    this.chunkReads.push(path);
    const file = this.files.get(path);
    if (file === undefined) return;
    for (let at = offset; at < file.bytes.length; at += chunkSize) yield file.bytes.slice(at, at + chunkSize);
  }

  async readSlice(path: string, offset: number, length: number): Promise<Uint8Array | undefined> {
    return this.files.get(path)?.bytes.slice(offset, offset + length);
  }

  async information(path: string): Promise<FileInformation | undefined> {
    const file = this.files.get(path);
    return file === undefined ? undefined : { ...this.fingerprint(file), mode: file.mode };
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.put(path, encoder.encode(text), this.files.get(path)?.mode ?? 0o600);
  }

  async createFileExclusive(path: string, mode: number): Promise<JournalFingerprint> {
    if (this.files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
    return this.fingerprint(this.put(path, new Uint8Array(), mode));
  }

  private append(file: MemoryFile, line: string): DurableAppend {
    const added = encoder.encode(line.endsWith('\n') ? line : `${line}\n`);
    const byteOffset = file.bytes.length;
    const bytes = new Uint8Array(byteOffset + added.length);
    bytes.set(file.bytes);
    bytes.set(added, byteOffset);
    file.bytes = bytes;
    file.modifiedAtMs = this.stamp();
    return { byteOffset, byteLength: added.length, fingerprint: this.fingerprint(file) };
  }

  async appendLineDurable(path: string, line: string): Promise<DurableAppend> {
    const file = this.files.get(path) ?? this.put(path, new Uint8Array());
    return this.append(file, line);
  }

  async appendLineToExisting(path: string, line: string, expect: JournalFingerprint): Promise<DurableAppendOutcome> {
    const file = this.files.get(path);
    if (file === undefined) return { kind: 'absent' };
    if (String(file.inode) !== expect.inode) return { kind: 'replaced' };
    return { kind: 'appended', append: this.append(file, line) };
  }

  async removeFile(path: string): Promise<void> {
    this.contain(path);
    this.files.delete(path);
  }

  async sweepTemporaryFiles(): Promise<void> {}
}

/** A state home's paths for a test whose files live in a {@link MemoryFileSystem}: nothing here is on disk. */
export const MEMORY_PATHS: FoundationPaths = createFoundationPaths(parseAbsoluteHome('/memory/state-home', 'test'));
