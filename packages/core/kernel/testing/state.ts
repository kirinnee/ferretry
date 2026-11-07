import { Database } from 'bun:sqlite';
import type { Result } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import type { StateFileDef } from '../contract/define.ts';
import {
  type JsonlRecords,
  MAX_STATE_TAIL_BYTES,
  type SqliteHandle,
  type StateDamage,
  type StatePort,
  type StateRead,
} from '../contract/ports.ts';

/** Thrown by the write that `crashAfterNextWrite()` armed: the write landed, then the process "died". */
export class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash after a write');
    this.name = 'SimulatedCrash';
  }
}

/**
 * An in-memory `state/<id>/` (§7.8) with the kernel store's rules: every JSON document carries `"format": n` first,
 * a reader accepts exactly the declared format, a damaged file reads as damaged (never empty). The files outlive a
 * `restart()` of the host, so owed calls can be proved to survive a crash.
 */
export class MemoryStateFolder {
  /** path (with `*` filled) → stored text */
  readonly files = new Map<string, string>();
  /** path → stored bytes of a `secret` or `opaque` file: kept byte for byte, never parsed or stamped. */
  readonly bytes = new Map<string, Uint8Array>();
  readonly databases = new Map<string, Database>();
  readonly directories = new Map<string, { readonly mode: number; readonly modifiedMs: number }>();
  /** Planted links are metadata only; the test store never follows one. */
  readonly symlinks = new Map<string, string>();
  readonly modified = new Map<string, number>();
  private crashArmed = false;
  crashed = false;

  constructor(readonly nowMs: () => number = () => 0) {}

  armCrash(): void {
    this.crashArmed = true;
  }

  /** Sets a file's raw text (a planted damaged or older file). */
  plant(file: StateFileDef, text: string, name?: string): void {
    this.files.set(pathOf(file, name), text);
  }

  raw(file: StateFileDef, name?: string): string | undefined {
    return this.files.get(pathOf(file, name));
  }

  /** Sets a `secret` or `opaque` file's bytes. */
  plantBytes(file: StateFileDef, bytes: Uint8Array, name?: string): void {
    this.bytes.set(pathOf(file, name), new Uint8Array(bytes));
  }

  /** A `secret` or `opaque` file's bytes as stored. */
  rawBytes(file: StateFileDef, name?: string): Uint8Array | undefined {
    const stored = this.bytes.get(pathOf(file, name));
    return stored === undefined ? undefined : new Uint8Array(stored);
  }

  /** Called after each landed write. */
  landed(): void {
    if (!this.crashArmed) return;
    this.crashArmed = false;
    this.crashed = true;
    throw new SimulatedCrash();
  }

  revive(): void {
    this.crashed = false;
  }

  port(declared: readonly StateFileDef[]): StatePort {
    return memoryStatePort(this, declared);
  }
}

function pathOf(file: StateFileDef, name?: string): string {
  if (!file.path.includes('*')) return file.path;
  const plain = (segment: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,200}$/u.test(segment);
  // as the real port: an opaque named tree (path ending `/*`) takes path-safe segments
  const tree = file.store === 'opaque' && file.path.endsWith('/*');
  if (name === undefined || (name.includes('/') && !tree) || !name.split('/').every(plain))
    throw new TypeError(`state ${file.name}: a collection file needs a plain name`);
  return file.path.replace('*', name);
}

function damage(file: StateFileDef, reason: StateDamage['reason'], detail: string): StateDamage {
  return { file: file.path, reason, sentence: `${file.path} cannot be used: ${detail}.` };
}

export function parseDocument<Shape>(file: StateFileDef<string, Shape>, text: string): StateRead<Shape> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(damage(file, 'unparsable', 'it is not JSON'));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('format' in value))
    return err(damage(file, 'no_format', 'it has no format number'));
  const { format, ...rest } = value as { format: unknown };
  if (typeof format !== 'number') return err(damage(file, 'no_format', 'its format is not a number'));
  if (format < file.format) return err(damage(file, 'lower_format', `format ${format} is older than ${file.format}`));
  if (format > file.format) return err(damage(file, 'higher_format', `format ${format} is newer than ${file.format}`));
  if (file.schema === undefined) return ok(rest as Shape);
  // As the real host (host/state/format.ts shapeOf): the bare body first, then the body stamped with its format, so a
  // schema that declares `format: z.literal(n)` itself reads back too.
  const parsed = file.schema.safeParse(rest);
  if (parsed.success) return ok(parsed.data);
  const stamped = file.schema.safeParse({ format, ...rest });
  return stamped.success ? ok(stamped.data) : err(damage(file, 'schema', 'it does not match its schema'));
}

/** Line-by-line reading as the real port: a bad line is counted; a last line with no newline that fails is torn. */
function lenientLines<Shape>(file: StateFileDef<string, Shape>, text: string): JsonlRecords<Shape> {
  const records: Shape[] = [];
  let unreadable = 0;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const parsed = parseDocument(file, line);
    if (parsed.ok) {
      if (parsed.value !== undefined) records.push(parsed.value);
      return;
    }
    const torn = index === lines.length - 1 && parsed.error.reason === 'unparsable';
    if (!torn) unreadable += 1;
  });
  return { records, unreadable };
}

function stamp(file: StateFileDef, value: unknown): string {
  return JSON.stringify({ format: file.format, ...(value as object) });
}

function memoryStatePort(folder: MemoryStateFolder, declared: readonly StateFileDef[]): StatePort {
  const known = new Map(declared.map(file => [file.name, file]));
  const guard = (file: StateFileDef): void => {
    if (folder.crashed) throw new SimulatedCrash();
    const def = known.get(file.name);
    if (def === undefined || def.path !== file.path || def.store !== file.store || def.format !== file.format)
      throw new Error(`state ${file.name} is not declared in the manifest`);
  };
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
    chains.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  };
  const isBytes = (file: StateFileDef): boolean => file.store === 'secret' || file.store === 'opaque';
  const entries = (): string[] => [
    ...folder.files.keys(),
    ...folder.bytes.keys(),
    ...folder.databases.keys(),
    ...folder.directories.keys(),
    ...folder.symlinks.keys(),
  ];
  const directory = (path: string): boolean =>
    folder.directories.has(path) || entries().some(key => key.startsWith(`${path}/`));
  const treePath = (file: StateFileDef, name: string): string => {
    guard(file);
    if (file.store !== 'opaque' || !file.path.endsWith('/*'))
      throw new TypeError('state operation needs an opaque named tree');
    const path = pathOf(file, name);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/');
      if (folder.symlinks.has(parent) || folder.bytes.has(parent) || folder.files.has(parent))
        throw new TypeError('state parent is not a directory');
    }
    return path;
  };
  const read = async <Shape>(file: StateFileDef<string, Shape>, name?: string): Promise<StateRead<Shape>> => {
    guard(file);
    // As the real port (host/state/state-port.ts readRaw → readBytesFile): bytes as they are, no parse, no format.
    if (isBytes(file)) {
      const stored = folder.bytes.get(pathOf(file, name));
      if (stored === undefined)
        return file.required === true ? err(damage(file, 'missing', 'it is missing')) : ok(undefined);
      return ok(new Uint8Array(stored) as Shape);
    }
    if (file.store !== 'json') throw new TypeError(`state ${file.name}: a ${file.store} file is not read with read()`);
    const text = folder.files.get(pathOf(file, name));
    if (text === undefined)
      return file.required === true ? err(damage(file, 'missing', 'it is missing')) : ok(undefined);
    return parseDocument(file, text);
  };
  const write = async <Shape>(file: StateFileDef<string, Shape>, value: Shape, name?: string): Promise<void> => {
    guard(file);
    if (file.store === 'jsonl' || file.store === 'sqlite' || file.store === 'sqlite-cache')
      throw new TypeError(`state ${file.name}: a ${file.store} file is not written with write()`);
    if (isBytes(file)) {
      if (!(value instanceof Uint8Array) && typeof value !== 'string')
        throw new TypeError(`state ${file.name}: a ${file.store} file holds bytes`);
      folder.bytes.set(
        pathOf(file, name),
        typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value),
      );
      folder.modified.set(pathOf(file, name), folder.nowMs());
      folder.landed();
      return;
    }
    if (file.schema !== undefined) file.schema.parse(value);
    folder.files.set(pathOf(file, name), stamp(file, value));
    folder.landed();
  };
  return {
    read,
    write,
    async stat(file, name) {
      const path = treePath(file, name);
      if (folder.symlinks.has(path)) return { kind: 'symlink', modifiedMs: folder.modified.get(path) ?? 0 };
      if (directory(path)) return { kind: 'directory', modifiedMs: folder.directories.get(path)?.modifiedMs ?? 0 };
      if (folder.bytes.has(path) || folder.files.has(path))
        return { kind: 'file', modifiedMs: folder.modified.get(path) ?? 0 };
      return undefined;
    },
    async createPrivateDirectory(file, name) {
      const path = treePath(file, name);
      if (entries().includes(path) || directory(path)) throw new Error('directory entry already exists');
      folder.directories.set(path, { mode: 0o700, modifiedMs: folder.nowMs() });
      folder.landed();
    },
    async removeEmptyDirectory(file, name) {
      const path = treePath(file, name);
      if (folder.symlinks.has(path) || folder.bytes.has(path) || folder.files.has(path))
        throw new Error('not a directory');
      if (entries().some(key => key.startsWith(`${path}/`))) throw new Error('directory is not empty');
      folder.directories.delete(path);
      folder.landed();
    },
    update: async (file, fn, name) => {
      if (file.store !== 'json') throw new TypeError(`state ${file.name}: only a json file is updated in place`);
      return await serial(pathOf(file, name), async () => {
        const current = await read(file, name);
        if (!current.ok) return current;
        const next = await fn(current.value);
        // declined, as the real port: the very value given back means no write
        if (current.value !== undefined && next === current.value) return ok(next) as Result<typeof next, StateDamage>;
        await write(file, next, name);
        return ok(next) as Result<typeof next, StateDamage>;
      });
    },
    async append(file, entry, name) {
      guard(file);
      if (file.store !== 'jsonl') throw new TypeError(`state ${file.name}: only a jsonl file is appended to`);
      const path = pathOf(file, name);
      folder.files.set(path, `${folder.files.get(path) ?? ''}${stamp(file, entry)}\n`);
      folder.landed();
    },
    async *lines(file, name) {
      guard(file);
      if (file.store !== 'jsonl') throw new TypeError(`state ${file.name}: only a jsonl file is read with lines()`);
      // as the real port: a bad line is skipped, the rest still read
      for (const record of lenientLines(file, folder.files.get(pathOf(file, name)) ?? '').records) yield record;
    },
    async version(file, name) {
      guard(file);
      const path = pathOf(file, name);
      const stored = isBytes(file) ? folder.bytes.get(path) : folder.files.get(path);
      if (stored === undefined) return undefined;
      const size = typeof stored === 'string' ? new TextEncoder().encode(stored).byteLength : stored.byteLength;
      // content-addressed: equal etags mean the same bytes (the real port's moves on any rewrite or append)
      return { size, etag: `${size}:${Bun.hash(stored).toString(36)}` };
    },
    async records(file, name) {
      guard(file);
      if (file.store !== 'jsonl') throw new TypeError(`state ${file.name}: only a jsonl file is read line by line`);
      return lenientLines(file, folder.files.get(pathOf(file, name)) ?? '');
    },
    async tail(file, options) {
      guard(file);
      if (file.store !== 'jsonl') throw new TypeError(`state ${file.name}: only a jsonl file is read line by line`);
      const { maxBytes } = options;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STATE_TAIL_BYTES)
        throw new TypeError(`state ${file.name}: tail reads 1 to ${MAX_STATE_TAIL_BYTES} bytes`);
      const bytes = new TextEncoder().encode(folder.files.get(pathOf(file, options.name)) ?? '');
      const from = Math.max(0, bytes.byteLength - maxBytes);
      let window = bytes.subarray(from);
      if (from > 0 && bytes[from - 1] !== 0x0a) {
        const firstBreak = window.indexOf(0x0a);
        window = firstBreak < 0 ? new Uint8Array() : window.subarray(firstBreak + 1);
      }
      return lenientLines(file, new TextDecoder().decode(window));
    },
    async list(file) {
      guard(file);
      const [prefix, suffix] = file.path.split('*') as [string, string | undefined];
      if (file.store === 'opaque' && file.path.endsWith('/*'))
        return [
          ...new Set(
            entries()
              .filter(path => path.startsWith(prefix))
              .map(path => path.slice(prefix.length).split('/')[0] as string),
          ),
        ]
          .filter(Boolean)
          .sort();
      // as the real port lists what is on disk for the file's store: bytes, a database, or text
      const stored: ReadonlyMap<string, unknown> = isBytes(file)
        ? folder.bytes
        : file.store === 'sqlite' || file.store === 'sqlite-cache'
          ? folder.databases
          : folder.files;
      if (suffix === undefined) return stored.has(file.path) ? [file.path] : [];
      return [...stored.keys()]
        .filter(path => path.startsWith(prefix) && path.endsWith(suffix) && path.length > prefix.length + suffix.length)
        .map(path => path.slice(prefix.length, path.length - suffix.length))
        .filter(name => !name.includes('/'))
        .sort();
    },
    async remove(file, name) {
      guard(file);
      const path = pathOf(file, name);
      for (const key of entries()) {
        if (key !== path && !key.startsWith(`${path}/`)) continue;
        folder.files.delete(key);
        folder.bytes.delete(key);
        folder.directories.delete(key);
        folder.symlinks.delete(key);
        folder.modified.delete(key);
      }
      folder.files.delete(pathOf(file, name));
      folder.bytes.delete(pathOf(file, name));
      folder.databases.get(pathOf(file, name))?.close();
      folder.databases.delete(pathOf(file, name));
      folder.landed();
    },
    pathOf(file, name) {
      guard(file);
      if (file.store !== 'opaque') throw new TypeError(`state ${file.name}: only an opaque file's path is handed out`);
      return `/memory-state/${pathOf(file, name)}`;
    },
    sqlite(file, name): SqliteHandle {
      guard(file);
      const path = pathOf(file, name);
      let db = folder.databases.get(path);
      if (db === undefined) {
        db = new Database(':memory:');
        folder.databases.set(path, db);
      }
      const handle = db;
      return {
        query: <Row>(sql: string, params: readonly unknown[] = []) =>
          handle.query(sql).all(...(params as never[])) as Row[],
        run: (sql, params = []) => ({ changes: handle.run(sql, params as never[]).changes }),
        transaction: fn => handle.transaction(fn)(),
        close: () => undefined,
      };
    },
    damaged() {
      const out: StateDamage[] = [];
      for (const file of declared) {
        if (
          file.path.includes('*') ||
          file.store === 'sqlite' ||
          file.store === 'sqlite-cache' ||
          file.store === 'opaque' ||
          file.store === 'secret' ||
          file.store === 'jsonl'
        )
          continue;
        const text = folder.files.get(file.path);
        if (text === undefined) {
          if (file.required === true) out.push(damage(file, 'missing', 'it is missing'));
          continue;
        }
        const parsed = parseDocument(file, text);
        if (!parsed.ok) out.push(parsed.error);
      }
      return out;
    },
  };
}
