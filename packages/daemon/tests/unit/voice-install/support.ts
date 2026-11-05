import { createHash } from 'node:crypto';
import type { VoiceArchive, VoiceMachineEngine, VoiceModel, VoiceRuntime } from '@ferretry/protocol';
import {
  NoDecompressorError,
  type VoiceArchiveReader,
  type VoiceEngineSettings,
  type VoiceFetch,
  type VoiceFileSink,
  type VoiceInstallFiles,
} from '../../../src/lib/voice-install/index.ts';

// ── tar bytes ────────────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export interface TarEntry {
  readonly name: string;
  readonly type?: string;
  readonly body?: string | Uint8Array;
  readonly mode?: number;
  readonly linkName?: string;
}

function field(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(encoder.encode(text).subarray(0, length));
  return out;
}

function header(name: string, size: number, type: string, mode: number, linkName = ''): Uint8Array {
  const block = new Uint8Array(512);
  block.set(field(name, 100), 0);
  block.set(field(`${mode.toString(8).padStart(7, '0')}\0`, 8), 100);
  block.set(field('0000000\0', 8), 108);
  block.set(field('0000000\0', 8), 116);
  block.set(field(`${size.toString(8).padStart(11, '0')}\0`, 12), 124);
  block.set(field('00000000000\0', 12), 136);
  block.set(field('        ', 8), 148);
  block.set(field(type, 1), 156);
  block.set(field(linkName, 100), 157);
  block.set(field('ustar\0', 6), 257);
  block.set(field('00', 2), 263);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(field(`${sum.toString(8).padStart(6, '0')}\0 `, 8), 148);
  return block;
}

/** A tar stream with the given entries, built byte by byte the way `tar` writes it. */
export function tarBytes(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === 'string' ? encoder.encode(entry.body) : (entry.body ?? new Uint8Array(0));
    const type = entry.type ?? (entry.name.endsWith('/') ? '5' : '0');
    parts.push(header(entry.name, body.length, type, entry.mode ?? 0o644, entry.linkName));
    if (body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      parts.push(padded);
    }
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A source of `bytes` cut into `size`-byte chunks, so a reader that assumes block-aligned chunks fails. */
export async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// ── a disk in memory ─────────────────────────────────────────────────────────────────────────────

class MemorySink implements VoiceFileSink {
  constructor(
    private readonly disk: MemoryFiles,
    private readonly path: string,
  ) {}
  async write(chunk: Uint8Array): Promise<void> {
    if (this.disk.failWritesAfter !== undefined && this.disk.written >= this.disk.failWritesAfter) {
      throw new Error('no space left on device');
    }
    const current = this.disk.files.get(this.path) ?? new Uint8Array(0);
    const next = new Uint8Array(current.length + chunk.length);
    next.set(current);
    next.set(chunk, current.length);
    this.disk.files.set(this.path, next);
    this.disk.written += chunk.length;
  }
  async close(): Promise<void> {
    this.disk.closed.push(this.path);
  }
}

/** The state home's `voice/` directory, held in a Map. Paths are plain strings; a directory is any prefix. */
export class MemoryFiles implements VoiceInstallFiles {
  readonly files = new Map<string, Uint8Array>();
  readonly closed: string[] = [];
  free: number | undefined = 1e12;
  written = 0;
  failWritesAfter: number | undefined;
  readonly executable = new Set<string>();

  async size(path: string): Promise<number | undefined> {
    return this.files.get(path)?.length;
  }
  async *read(path: string): AsyncGenerator<Uint8Array> {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`ENOENT ${path}`);
    yield* chunked(bytes, 64 * 1024);
  }
  async openAppend(path: string, options: { readonly truncate: boolean }): Promise<VoiceFileSink> {
    if (options.truncate || !this.files.has(path)) this.files.set(path, new Uint8Array(0));
    return new MemorySink(this, path);
  }
  async openStaged(path: string, options: { readonly executable: boolean }): Promise<VoiceFileSink> {
    if (this.files.has(path)) throw new Error(`EEXIST ${path}`);
    this.files.set(path, new Uint8Array(0));
    if (options.executable) this.executable.add(path);
    return new MemorySink(this, path);
  }
  async makeDirectory(): Promise<void> {}
  async rename(from: string, to: string): Promise<void> {
    for (const [path, bytes] of [...this.files]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, bytes);
      }
    }
  }
  async remove(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
  }
  async readText(path: string): Promise<string | undefined> {
    const bytes = this.files.get(path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }
  async writeText(path: string, text: string): Promise<void> {
    this.files.set(path, encoder.encode(text));
  }
  async freeBytes(): Promise<number | undefined> {
    return this.free;
  }
  async list(path: string): Promise<readonly string[]> {
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(`${path}/`)) names.add(key.slice(path.length + 1).split('/')[0] ?? '');
    }
    return [...names];
  }
  /** Every path under `prefix`, for assertions. */
  under(prefix: string): string[] {
    return [...this.files.keys()].filter(key => key.startsWith(prefix)).sort();
  }
}

// ── a network that serves bytes, with Range ──────────────────────────────────────────────────────

export interface Served {
  readonly status: number;
  readonly range: string | undefined;
}

export interface FakeNetworkOptions {
  /** Ignore `Range` and always send the whole body with 200. */
  readonly ignoreRange?: boolean;
  /** Cut the connection after this many bytes of the body (the first request only). */
  readonly cutAfter?: number;
  /** Answer 416 to a ranged request. */
  readonly rangeNotSatisfiable?: boolean;
  /** Send the body in this many-byte chunks. */
  readonly chunk?: number;
  /** Called after each chunk is sent, with how many have gone. */
  readonly onChunk?: (sent: number, url: string) => void;
}

/** A `fetch` over a map of url → body. Records what it was asked. */
export class FakeNetwork {
  readonly served: Served[] = [];
  readonly bodies = new Map<string, Uint8Array>();
  options: FakeNetworkOptions = {};
  #cutDone = false;

  readonly fetch: VoiceFetch = async (url, init) => {
    const body = this.bodies.get(url);
    const range = init.headers.range;
    if (body === undefined) {
      this.served.push({ status: 404, range });
      return new Response('not found', { status: 404 });
    }
    const start = range === undefined ? 0 : Number.parseInt(/bytes=(\d+)-/.exec(range)?.[1] ?? '0', 10);
    if (range !== undefined && this.options.rangeNotSatisfiable === true) {
      this.served.push({ status: 416, range });
      return new Response('', { status: 416 });
    }
    const partial = range !== undefined && this.options.ignoreRange !== true;
    const from = partial ? start : 0;
    let slice = body.subarray(from);
    const cut = this.#cutDone ? undefined : this.options.cutAfter;
    if (cut !== undefined) this.#cutDone = true;
    if (cut !== undefined) slice = slice.subarray(0, cut);
    this.served.push({ status: partial ? 206 : 200, range });
    const step = this.options.chunk ?? 7_000;
    const onChunk = this.options.onChunk;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (init.signal.aborted) {
          controller.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        const piece = slice.subarray(0, step);
        slice = slice.subarray(step);
        if (piece.length > 0) {
          controller.enqueue(piece);
          sent += 1;
          onChunk?.(sent, url);
        }
        if (slice.length === 0) controller.close();
      },
    });
    return new Response(stream, {
      status: partial ? 206 : 200,
      headers: partial
        ? { 'content-range': `bytes ${String(from)}-${String(body.length - 1)}/${String(body.length)}` }
        : {},
    });
  };
}

// ── the other ports ──────────────────────────────────────────────────────────────────────────────

/** Treats the downloaded file as the tar stream (the real reader decompresses it first). */
export class PassThroughArchives implements VoiceArchiveReader {
  missing = false;
  constructor(private readonly files: MemoryFiles) {}
  async *tarStream(path: string, _format: unknown, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    if (this.missing) throw new NoDecompressorError('bzip2');
    const bytes = this.files.files.get(path);
    if (bytes === undefined) throw new Error(`ENOENT ${path}`);
    for await (const chunk of chunked(bytes, 5_000)) {
      signal.throwIfAborted();
      yield chunk;
    }
  }
}

export class MemorySettings implements VoiceEngineSettings {
  engine: VoiceMachineEngine = {};
  readonly writes: string[] = [];
  async read(): Promise<VoiceMachineEngine> {
    return this.engine;
  }
  async setModel(role: 'batch' | 'streaming', id: string | null): Promise<void> {
    this.writes.push(`${role}=${id ?? 'null'}`);
    const { [role]: _dropped, ...rest } = this.engine;
    this.engine = id === null ? rest : { ...rest, [role]: id };
  }
}

// ── pinned fixtures ──────────────────────────────────────────────────────────────────────────────

export const ROOT = '/state/voice';

export function archiveOf(
  bytes: Uint8Array,
  url: string,
  extractedBytes: number,
  format: VoiceArchive['format'] = 'tar.bz2',
): VoiceArchive {
  return { url, format, bytes: bytes.length, sha256: sha256(bytes), extractedBytes };
}

/** A tiny model whose archive holds `dir/<files>` and a test wav, pinned to the bytes it really has. */
export function tinyModel(
  id: string,
  options: {
    readonly role?: VoiceModel['role'];
    readonly recommended?: boolean;
    readonly padding?: number;
    /** What the catalog declares the archive unpacks to, when that should differ from what it holds. */
    readonly declaredExtracted?: number;
  } = {},
): { readonly model: VoiceModel; readonly tar: Uint8Array } {
  const tar = tarBytes([
    { name: `${id}/` },
    { name: `${id}/encoder.onnx`, body: 'E'.repeat(options.padding ?? 3_000) },
    { name: `${id}/decoder.onnx`, body: 'D'.repeat(1_000) },
    { name: `${id}/tokens.txt`, body: 'a\nb\n' },
    { name: `${id}/test_wavs/` },
    { name: `${id}/test_wavs/0.wav`, body: 'RIFF' },
  ]);
  const extracted = (options.padding ?? 3_000) + 1_000 + 4 + 4;
  return {
    tar,
    model: {
      id,
      name: id.toUpperCase(),
      role: options.role ?? 'batch',
      summary: 'a test model',
      weight: 'standard',
      sherpaType: 'nemo-transducer',
      files: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', tokens: 'tokens.txt' },
      languages: ['English'],
      archive: archiveOf(tar, `https://example.test/models/${id}.tar.bz2`, options.declaredExtracted ?? extracted),
      peakMemory: { bytes: 1_000_000, basis: 'estimate' },
      recommended: options.recommended ?? false,
    },
  };
}

/** A tiny runtime tarball: `package/` + the addon and one library. */
export function tinyRuntime(): { readonly runtime: VoiceRuntime; readonly tar: Uint8Array } {
  const tar = tarBytes([
    { name: 'package/' },
    { name: 'package/package.json', body: '{}' },
    { name: 'package/sherpa-onnx.node', body: 'ADDON', mode: 0o755 },
    { name: 'package/libsherpa-onnx-c-api.so', body: 'LIB', mode: 0o755 },
  ]);
  return {
    tar,
    runtime: {
      target: 'linux-x64',
      packageName: 'sherpa-onnx-linux-x64',
      version: '9.9.9',
      archive: archiveOf(tar, 'https://example.test/runtime.tgz', 10, 'tgz'),
      addon: 'sherpa-onnx.node',
      libraries: ['libsherpa-onnx-c-api.so'],
      libraryLookup: 'origin',
    },
  };
}
