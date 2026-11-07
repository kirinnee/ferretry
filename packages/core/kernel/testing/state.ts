import { Database } from 'bun:sqlite';
import type { Result } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import type { StateFileDef } from '../contract/define.ts';
import type { SqliteHandle, StateDamage, StatePort, StateRead } from '../contract/ports.ts';

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
  readonly databases = new Map<string, Database>();
  private crashArmed = false;
  crashed = false;

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
  if (name === undefined || name.includes('/') || name === '..' || name === '.')
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
  const parsed = file.schema.safeParse(rest);
  return parsed.success ? ok(parsed.data) : err(damage(file, 'schema', 'it does not match its schema'));
}

function stamp(file: StateFileDef, value: unknown): string {
  return JSON.stringify({ format: file.format, ...(value as object) });
}

function memoryStatePort(folder: MemoryStateFolder, declared: readonly StateFileDef[]): StatePort {
  const known = new Set(declared.map(file => file.name));
  const guard = (file: StateFileDef): void => {
    if (folder.crashed) throw new SimulatedCrash();
    if (!known.has(file.name)) throw new Error(`state ${file.name} is not declared in the manifest`);
  };
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
    chains.set(key, run.catch(() => undefined));
    return run;
  };
  const read = async <Shape>(file: StateFileDef<string, Shape>, name?: string): Promise<StateRead<Shape>> => {
    guard(file);
    const text = folder.files.get(pathOf(file, name));
    if (text === undefined) return file.required === true ? err(damage(file, 'missing', 'it is missing')) : ok(undefined);
    return parseDocument(file, text);
  };
  const write = async <Shape>(file: StateFileDef<string, Shape>, value: Shape, name?: string): Promise<void> => {
    guard(file);
    if (file.schema !== undefined) file.schema.parse(value);
    folder.files.set(pathOf(file, name), stamp(file, value));
    folder.landed();
  };
  return {
    read,
    write,
    update: (file, fn, name) =>
      serial(pathOf(file, name), async () => {
        const current = await read(file, name);
        if (!current.ok) return current;
        const next = fn(current.value);
        await write(file, next, name);
        return ok(next) as Result<typeof next, StateDamage>;
      }),
    async append(file, entry, name) {
      guard(file);
      const path = pathOf(file, name);
      folder.files.set(path, `${folder.files.get(path) ?? ''}${stamp(file, entry)}\n`);
      folder.landed();
    },
    async *lines(file, name) {
      guard(file);
      const text = folder.files.get(pathOf(file, name)) ?? '';
      for (const line of text.split('\n')) {
        if (line === '') continue;
        const parsed = parseDocument(file, line);
        if (!parsed.ok) throw new Error(parsed.error.sentence);
        if (parsed.value !== undefined) yield parsed.value;
      }
    },
    async list(file) {
      guard(file);
      const [prefix, suffix] = file.path.split('*') as [string, string | undefined];
      if (suffix === undefined) return folder.files.has(file.path) ? [file.path] : [];
      return [...folder.files.keys()]
        .filter(path => path.startsWith(prefix) && path.endsWith(suffix) && path.length > prefix.length + suffix.length)
        .map(path => path.slice(prefix.length, path.length - suffix.length))
        .filter(name => !name.includes('/'))
        .sort();
    },
    async remove(file, name) {
      guard(file);
      folder.files.delete(pathOf(file, name));
      folder.landed();
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
        query: <Row>(sql: string, params: readonly unknown[] = []) => handle.query(sql).all(...(params as never[])) as Row[],
        run: (sql, params = []) => ({ changes: handle.run(sql, params as never[]).changes }),
        transaction: fn => handle.transaction(fn)(),
        close: () => undefined,
      };
    },
    damaged() {
      const out: StateDamage[] = [];
      for (const file of declared) {
        if (file.path.includes('*') || file.store === 'sqlite' || file.store === 'sqlite-cache' || file.store === 'opaque' || file.store === 'secret' || file.store === 'jsonl')
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
