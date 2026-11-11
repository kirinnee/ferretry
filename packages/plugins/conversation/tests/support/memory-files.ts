import { BytesTranscriptSource, type TranscriptReadLimits } from '../../daemon/reader/adapters/file-source.ts';
import type { TranscriptParser } from '../../daemon/reader/lib/transcript/types.ts';
import { HarnessBytesRuntime, type TranscriptBytesHandle } from '../../daemon/reader/adapters/harness-bytes-runtime.ts';
import type {
  BoundedTranscriptRead,
  TranscriptFileInfo,
  TranscriptFileRuntime,
} from '../../daemon/reader/adapters/file-source.ts';

/**
 * An in-memory file tree, and the transcript runtime that reads it through `HarnessTranscriptBytes`-shaped handles.
 *
 * It stands in for the disk so the v4 transcript-source tests (written against real files, with `node:fs`) run
 * unchanged in spirit and with no filesystem: the functions below keep the names and the semantics the tests used
 * (`writeFile` on an existing file REWRITES it in place and keeps its identity, `rename` and `link` keep identity,
 * `truncate` extends a file sparsely), and the runtime is the production {@link HarnessBytesRuntime} underneath.
 */

interface Segment {
  readonly at: number;
  readonly bytes: Uint8Array;
}

class Entry {
  size = 0;
  mtime = 0;
  segments: Segment[] = [];
  constructor(readonly token: string) {}
}

type Node =
  | { readonly kind: 'file'; readonly entry: Entry }
  | { readonly kind: 'dir' }
  | { readonly kind: 'link'; readonly target: string };

const code = (value: string): Error => Object.assign(new Error(value), { code: value });

const bytesOf = (data: string | Uint8Array): Uint8Array =>
  typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data);

export class MemoryFiles {
  readonly #nodes = new Map<string, Node>();
  #tokens = 0;
  #temporaries = 0;
  #ticks = 0;

  reset(): void {
    this.#nodes.clear();
  }

  /** Follows links; `undefined` when nothing is there, `ELOOP` when links never end. */
  resolve(path: string): { readonly path: string; readonly node: Node } | undefined {
    let current = path;
    for (let hops = 0; hops < 16; hops += 1) {
      const node = this.#nodes.get(current);
      if (node === undefined) return undefined;
      if (node.kind !== 'link') return { path: current, node };
      current = node.target;
    }
    throw code('ELOOP');
  }

  async mkdtemp(prefix: string): Promise<string> {
    this.#temporaries += 1;
    const path = `${prefix}${String(this.#temporaries)}`;
    this.#nodes.set(path, { kind: 'dir' });
    return path;
  }

  async mkdir(path: string): Promise<void> {
    this.#nodes.set(path, { kind: 'dir' });
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const bytes = bytesOf(data);
    const found = this.resolve(path);
    const entry = found?.node.kind === 'file' ? found.node.entry : this.#create(path);
    entry.segments = bytes.byteLength === 0 ? [] : [{ at: 0, bytes }];
    entry.size = bytes.byteLength;
    entry.mtime = this.#tick();
  }

  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    const found = this.resolve(path);
    const entry = found?.node.kind === 'file' ? found.node.entry : this.#create(path);
    const bytes = bytesOf(data);
    if (bytes.byteLength > 0) entry.segments.push({ at: entry.size, bytes });
    entry.size += bytes.byteLength;
    entry.mtime = this.#tick();
  }

  async truncate(path: string, size: number): Promise<void> {
    const found = this.resolve(path);
    if (found?.node.kind !== 'file') throw code('ENOENT');
    const entry = found.node.entry;
    entry.segments = entry.segments
      .filter(segment => segment.at < size)
      .map(segment => ({ at: segment.at, bytes: segment.bytes.subarray(0, size - segment.at) }));
    entry.size = size;
    entry.mtime = this.#tick();
  }

  async rename(from: string, to: string): Promise<void> {
    const node = this.#nodes.get(from);
    if (node === undefined) throw code('ENOENT');
    this.#nodes.delete(from);
    this.#nodes.set(to, node);
  }

  async rm(path: string, options: { readonly recursive?: boolean; readonly force?: boolean } = {}): Promise<void> {
    if (!this.#nodes.delete(path) && options.force !== true) throw code('ENOENT');
    if (options.recursive === true) {
      for (const each of [...this.#nodes.keys()]) if (each.startsWith(`${path}/`)) this.#nodes.delete(each);
    }
  }

  async symlink(target: string, path: string): Promise<void> {
    this.#nodes.set(path, { kind: 'link', target });
  }

  async link(existing: string, path: string): Promise<void> {
    const found = this.resolve(existing);
    if (found === undefined) throw code('ENOENT');
    this.#nodes.set(path, found.node);
  }

  /** The handle of the file at `path` now: it reads that file, and is REPLACED once `path` names another. */
  handle(path: string): TranscriptBytesHandle | undefined {
    const found = this.resolve(path);
    if (found?.node.kind !== 'file') return undefined;
    const entry = found.node.entry;
    const still = (): boolean => {
      const now = this.resolve(path);
      return now?.node.kind === 'file' && now.node.entry === entry;
    };
    return {
      format: 'claude',
      file: entry.token,
      size: entry.size,
      mtimeMs: entry.mtime,
      read: async (offset, length) => {
        if (!still()) throw Object.assign(new Error('replaced'), { name: 'HarnessTranscriptReplaced' });
        return window(entry, offset, length);
      },
      stat: async () => (still() ? { size: entry.size, mtimeMs: entry.mtime } : undefined),
      close: async () => undefined,
    };
  }

  #create(path: string): Entry {
    this.#tokens += 1;
    const entry = new Entry(`mem-${String(this.#tokens)}`);
    this.#nodes.set(path, { kind: 'file', entry });
    return entry;
  }

  #tick(): number {
    this.#ticks += 1;
    return this.#ticks;
  }
}

function window(entry: Entry, offset: number, length: number): Uint8Array {
  const end = Math.min(entry.size, offset + length);
  if (end <= offset) return new Uint8Array();
  const out = new Uint8Array(end - offset);
  for (const segment of entry.segments) {
    const from = Math.max(offset, segment.at);
    const to = Math.min(end, segment.at + segment.bytes.byteLength);
    if (to > from) out.set(segment.bytes.subarray(from - segment.at, to - segment.at), from - offset);
  }
  return out;
}

/** The process-wide tree the v4-shaped tests write to; they reset it after each test. */
const files = new MemoryFiles();
export const { mkdtemp, mkdir, writeFile, appendFile, truncate, rename, rm, symlink, link } = {
  mkdtemp: (prefix: string) => files.mkdtemp(prefix),
  mkdir: (path: string) => files.mkdir(path),
  writeFile: (path: string, data: string | Uint8Array) => files.writeFile(path, data),
  appendFile: (path: string, data: string | Uint8Array) => files.appendFile(path, data),
  truncate: (path: string, size: number) => files.truncate(path, size),
  rename: (from: string, to: string) => files.rename(from, to),
  rm: (path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }) => files.rm(path, options),
  symlink: (target: string, path: string) => files.symlink(target, path),
  link: (existing: string, path: string) => files.link(existing, path),
};

/**
 * The production {@link HarnessBytesRuntime}, addressed by PATH over a {@link MemoryFiles}: each call resolves the
 * path, hands the file's handle to the runtime, and reads through it. The v4 tests pass paths; production passes tokens.
 */
export class MemoryFileRuntime implements TranscriptFileRuntime {
  readonly inner = new HarnessBytesRuntime();
  constructor(private readonly tree: MemoryFiles = files) {}

  /** The token the runtime reads `path` under, or `ENOENT`. */
  async token(path: string): Promise<string> {
    const handle = this.tree.handle(path);
    if (handle === undefined) throw code('ENOENT');
    return await this.inner.adopt(handle);
  }

  async info(path: string): Promise<TranscriptFileInfo | undefined> {
    const found = this.tree.resolve(path);
    if (found === undefined) return undefined;
    if (found.node.kind !== 'file') return { identity: `dir:${path}`, size: 0, modifiedMs: 0, isFile: false };
    return await this.inner.info(await this.token(path));
  }

  async countNewlines(path: string, byteLength: number): Promise<number> {
    return await this.inner.countNewlines(await this.token(path), byteLength);
  }

  async readTrailingLine(path: string, byteLength: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    return await this.inner.readTrailingLine(await this.token(path), byteLength, byteLimit);
  }

  async readRange(path: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    return await this.inner.readRange(await this.token(path), byteOffset, byteLength);
  }

  async readFrom(path: string, byteOffset: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    return await this.inner.readFrom(await this.token(path), byteOffset, byteLimit);
  }
}

/** A transcript source over `runtime`, with a fixed observation instant and no-op loop pacing (so a test never waits). */
export function newSource(
  parser: TranscriptParser,
  runtime: TranscriptFileRuntime = new MemoryFileRuntime(),
  clock: { readonly now?: () => string } = {},
  limits: TranscriptReadLimits = {},
): BytesTranscriptSource {
  return new BytesTranscriptSource(
    parser,
    runtime,
    {
      now: clock.now ?? ((): string => '2026-01-02T03:04:05.000Z'),
      pacing: { now: (): number => performance.now(), yieldToLoop: async (): Promise<void> => undefined },
      sleep: async (milliseconds: number): Promise<void> => {
        await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
      },
    },
    limits,
  );
}
