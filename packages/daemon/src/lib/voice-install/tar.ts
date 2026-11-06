/**
 * Unpacking a tar stream SAFELY, as rules over bytes: nothing here touches a disk.
 *
 * The archives Install unpacks are pinned by SHA-256, so a hostile one cannot arrive unless the pin is
 * wrong — this is the second line, and it is built so the first does not have to be perfect. The unpacker
 * only ever CREATES plain files and directories, itself, under one staging directory it is given a handle
 * to; it never calls `tar`, never creates a link and never honours a mode bit beyond "executable or not".
 * An entry that would do anything else is a refusal, not a skip:
 *
 *  - an absolute path, a `..` component, an empty component, a NUL or a backslash;
 *  - a hard link, a symbolic link, a device, a FIFO — any entry type that is not a file or a directory;
 *  - more than `maxEntries` headers (an extended header or a long-name record is a header too), or more than
 *    `maxBytes` decompressed bytes consumed in all — file content, directory payloads, extended-header bodies,
 *    block headers and padding alike (a decompression bomb, or a pile of metadata, is stopped at the cap, not
 *    after it has filled the disk).
 *
 * The reader understands ustar, GNU long names (`L`) and pax extended headers (`x`, `g`), which is what
 * `tar` on Linux and macOS write.
 */

/** Why an archive was refused. */
export type UnsafeArchiveReason =
  | 'absolute-path'
  | 'parent-path'
  | 'bad-path'
  | 'link'
  | 'special-file'
  | 'too-large'
  | 'too-many-entries'
  | 'bad-header'
  | 'truncated';

export class UnsafeArchiveError extends Error {
  constructor(
    readonly reason: UnsafeArchiveReason,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeArchiveError';
  }
}

/** An open file being written under the staging directory. */
interface TarFileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** What the unpacker is allowed to make: directories and files under one directory, named relative to it. */
export interface TarDestination {
  makeDirectory(relativePath: string): Promise<void>;
  openFile(relativePath: string, executable: boolean): Promise<TarFileSink>;
}

interface TarLimits {
  /** The most decompressed bytes of the stream, headers, bodies and padding included, that may be consumed. */
  readonly maxBytes: number;
  /** The most tar headers (entries and extended-header records alike) that may be read. */
  readonly maxEntries: number;
}

export interface TarPolicy extends TarLimits {
  /** Leading path components to drop (an archive's single top directory). */
  readonly strip: number;
  /** When set, only paths it accepts are written; the rest are read past. */
  readonly include?: (relativePath: string) => boolean;
}

export interface TarOutcome {
  readonly files: readonly { readonly path: string; readonly bytes: number }[];
  readonly totalBytes: number;
}

const BLOCK = 512;

const decoder = new TextDecoder();

/** The NUL-terminated text in `[start, start + length)`. */
function text(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(block: Uint8Array, start: number, length: number): number {
  const raw = text(block, start, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new UnsafeArchiveError('bad-header', `a tar header field is not a number: "${raw}"`);
  return Number.parseInt(raw, 8);
}

function isZero(block: Uint8Array): boolean {
  return block.every(byte => byte === 0);
}

/**
 * Checks an entry name and removes `strip` leading components. Returns `undefined` for an entry that is
 * only the stripped prefix itself (the archive's top directory). Throws for anything unsafe.
 */
export function safeRelativePath(name: string, strip: number): string | undefined {
  if (name.includes('\0') || name.includes('\\')) {
    throw new UnsafeArchiveError('bad-path', `unsafe archive entry name "${name}"`);
  }
  if (name.startsWith('/'))
    throw new UnsafeArchiveError('absolute-path', `archive entry "${name}" is an absolute path`);
  const parts = name.split('/').filter((part, index, all) => !(part === '' && index === all.length - 1));
  for (const part of parts) {
    if (part === '..')
      throw new UnsafeArchiveError('parent-path', `archive entry "${name}" climbs out of its directory`);
    if (part === '') throw new UnsafeArchiveError('bad-path', `archive entry "${name}" has an empty path component`);
  }
  const kept = parts.filter(part => part !== '.').slice(strip);
  return kept.length === 0 ? undefined : kept.join('/');
}

/** pax extended header: `<length> <key>=<value>\n` records. Only `path` matters. */
function paxPath(data: Uint8Array): string | undefined {
  let offset = 0;
  let path: string | undefined;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) {
      throw new UnsafeArchiveError('bad-header', 'a pax extended header is malformed');
    }
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf('=');
    if (equals !== -1 && record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/** A pull reader over an async chunk stream, so entries can be read without buffering a whole file. */
class Reader {
  #buffer = new Uint8Array(0);
  #done = false;
  #consumed = 0;
  readonly #iterator: AsyncIterator<Uint8Array>;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly maxBytes: number,
  ) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  /** Counts `length` bytes of the stream as consumed, and refuses once the cap is crossed. */
  #charge(length: number): void {
    this.#consumed += length;
    if (this.#consumed > this.maxBytes) {
      throw new UnsafeArchiveError('too-large', `the archive holds more than ${String(this.maxBytes)} bytes`);
    }
  }

  /** Refuses now if consuming `length` more bytes would cross the cap, so an entry is not half-written first. */
  require(length: number): void {
    if (this.#consumed + length > this.maxBytes) {
      throw new UnsafeArchiveError('too-large', `the archive holds more than ${String(this.maxBytes)} bytes`);
    }
  }

  /** Finalizes the source (so a decompressor behind it is stopped) on every way out; never throws. */
  async close(): Promise<void> {
    this.#done = true;
    try {
      await this.#iterator.return?.();
    } catch {
      // Cleanup only: the outcome (or the refusal) being reported is the one that matters.
    }
  }

  async #fill(): Promise<boolean> {
    if (this.#done) return false;
    const next = await this.#iterator.next();
    if (next.done === true) {
      this.#done = true;
      return false;
    }
    if (next.value.length === 0) return true;
    const joined = new Uint8Array(this.#buffer.length + next.value.length);
    joined.set(this.#buffer);
    joined.set(next.value, this.#buffer.length);
    this.#buffer = joined;
    return true;
  }

  /** Exactly `length` bytes, or `undefined` at a clean end of stream before any byte. */
  async exact(length: number): Promise<Uint8Array | undefined> {
    this.#charge(length);
    while (this.#buffer.length < length) {
      if (!(await this.#fill())) {
        if (this.#buffer.length === 0) return undefined;
        throw new UnsafeArchiveError('truncated', 'the archive ends in the middle of an entry');
      }
    }
    const out = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return out;
  }

  /** Up to `limit` bytes of whatever is next (at least one), or `undefined` at the end. */
  async some(limit: number): Promise<Uint8Array | undefined> {
    while (this.#buffer.length === 0) {
      if (!(await this.#fill())) return undefined;
    }
    const take = Math.min(limit, this.#buffer.length);
    this.#charge(take);
    const out = this.#buffer.subarray(0, take);
    this.#buffer = this.#buffer.subarray(take);
    return out;
  }

  async skip(length: number): Promise<void> {
    let left = length;
    while (left > 0) {
      const part = await this.some(left);
      if (part === undefined) throw new UnsafeArchiveError('truncated', 'the archive ends in the middle of an entry');
      left -= part.length;
    }
  }
}

/**
 * Reads `source` as a tar stream and writes its files and directories into `destination` under `policy`.
 * Resolves with what was written; rejects with `UnsafeArchiveError` on the first rule broken (the caller
 * deletes the staging directory).
 */
export async function unpackTar(
  source: AsyncIterable<Uint8Array>,
  destination: TarDestination,
  policy: TarPolicy,
  signal?: AbortSignal,
): Promise<TarOutcome> {
  const reader = new Reader(source, policy.maxBytes);
  try {
    return await unpack(reader, destination, policy, signal);
  } finally {
    // Every way out — the end of the archive, a refusal, a cancel — finalizes the source, so a decompressor
    // behind it is stopped rather than left running.
    await reader.close();
  }
}

async function unpack(
  reader: Reader,
  destination: TarDestination,
  policy: TarPolicy,
  signal: AbortSignal | undefined,
): Promise<TarOutcome> {
  const files: { path: string; bytes: number }[] = [];
  let entries = 0;
  let longName: string | undefined;
  let nextPath: string | undefined;

  for (;;) {
    signal?.throwIfAborted();
    const header = await reader.exact(BLOCK);
    if (header === undefined || isZero(header)) break;
    // Every header counts — an extended-header or long-name record as much as a file — so a pile of metadata
    // cannot get past the entry cap.
    entries += 1;
    if (entries > policy.maxEntries) {
      throw new UnsafeArchiveError(
        'too-many-entries',
        `the archive has more than ${String(policy.maxEntries)} entries`,
      );
    }
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const size = octal(header, 124, 12);
    const mode = octal(header, 100, 8);
    const kind = String.fromCharCode(header[156] ?? 0x30);
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (kind === 'x' || kind === 'g' || kind === 'L') {
      if (size > 1_000_000) throw new UnsafeArchiveError('bad-header', 'an extended tar header is implausibly large');
      const data = await reader.exact(padded);
      const body = (data ?? new Uint8Array(0)).subarray(0, size);
      if (kind === 'L') longName = text(body, 0, body.length);
      else if (kind === 'x') nextPath = paxPath(body);
      continue;
    }

    const fullName = longName ?? nextPath ?? (prefix === '' ? name : `${prefix}/${name}`);
    longName = undefined;
    nextPath = undefined;

    if (kind === '1' || kind === '2') {
      throw new UnsafeArchiveError('link', `archive entry "${fullName}" is a link; links are not unpacked`);
    }
    if (kind !== '0' && kind !== '\0' && kind !== '5' && kind !== '7') {
      throw new UnsafeArchiveError('special-file', `archive entry "${fullName}" is not a plain file or directory`);
    }

    const relative = safeRelativePath(fullName, policy.strip);
    const wanted = relative !== undefined && (policy.include?.(relative) ?? true);

    if (kind === '5') {
      // A directory has no content, but a hostile one can carry a payload: it is read past, and charged.
      await reader.skip(padded);
      if (wanted) await destination.makeDirectory(relative);
      continue;
    }

    reader.require(padded);
    if (!wanted) {
      await reader.skip(padded);
      continue;
    }
    const sink = await destination.openFile(relative, (mode & 0o100) !== 0);
    let left = size;
    try {
      while (left > 0) {
        signal?.throwIfAborted();
        const part = await reader.some(left);
        if (part === undefined) throw new UnsafeArchiveError('truncated', `"${relative}" is cut short`);
        await sink.write(part);
        left -= part.length;
      }
    } finally {
      await sink.close();
    }
    await reader.skip(padded - size);
    files.push({ path: relative, bytes: size });
  }
  return { files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
