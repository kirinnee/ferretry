import { err, type Instant, ok, type Result } from '@ferretry/std';
import {
  type Clock,
  type JsonlRecords,
  MAX_STATE_TAIL_BYTES,
  type SqliteHandle,
  type StateDamage,
  type StateFileDef,
  type StatePort,
  type StateRead,
  type StateVersion,
} from '../../contract/index.ts';
import { StoreDamagedError, UndeclaredStateFileError } from './errors.ts';
import { encodeDocument, stateLabel } from './format.ts';
import type { HostFs } from './host-fs.ts';
import { assertRecordSize } from './jsonl-scan.ts';
import { readBytesFile, readJsonDocument, readJsonlLines, readJsonlRecords } from './readers.ts';
import { KeyedSerialExecutor } from './serial-executor.ts';
import { nodeSqliteFiles, openSqlite, type SqliteFiles } from './sqlite-store.ts';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

/** A name that fills the `*` of a collection path: one path segment, no dots-only, no separators. */
const COLLECTION_NAME = /^[A-Za-z0-9_][A-Za-z0-9._%~-]{0,200}$/u;

export interface StateDamageEvent {
  readonly damage: StateDamage;
  /** `narrower`: the file read as its narrower value; the subsystem stays up. The plugin audits it. */
  readonly policy: 'subsystem' | 'narrower';
  readonly at?: Instant;
}

export interface StatePortOptions {
  /** The home, absolute. The port is rooted at `<home>/state/<pluginId>/`. */
  readonly home: string;
  readonly pluginId: string;
  /** Every file the plugin declared; the port refuses any other. */
  readonly files: readonly StateFileDef[];
  readonly fs: HostFs;
  readonly clock?: Pick<Clock, 'now'>;
  /** What boot found already (`openPluginState`), so `damaged()` is right before the first read. */
  readonly initialDamage?: readonly StateDamage[];
  readonly initialNarrowed?: readonly StateDamage[];
  /** The host's live serving-state projection; called synchronously on damage and repair. */
  readonly changed?: (damage: readonly StateDamage[]) => void;
  readonly sqliteFiles?: SqliteFiles;
  /** Told each time a file is found damaged (logging, audit). */
  readonly report?: (event: StateDamageEvent) => void;
}

/** The contract's {@link StatePort} plus what only the host needs. */
export interface HostStatePort extends StatePort {
  /** Files that are damaged but read as their narrower value (`onDamaged: { narrower }`): never the subsystem. */
  narrowed(): readonly StateDamage[];
  /** Where a DECLARED sqlite file lives, for a worker to open itself; anything else throws. */
  sqliteGrant(def: StateFileDef, name?: string): { readonly path: string; readonly label: string };
}

interface Located {
  readonly path: string;
  readonly relative: string;
  readonly label: string;
}

/** `state/<pluginId>/` — one plugin's data, and nothing else. */
export const pluginStateRoot = (home: string, pluginId: string): string => `${home}/state/${pluginId}`;

function validatePath(def: StateFileDef): void {
  const segments = def.path.split('/');
  const wildcards = def.path.split('*').length - 1;
  if (
    def.path === '' ||
    def.path.startsWith('/') ||
    segments.some(segment => segment === '' || segment === '.' || segment === '..') ||
    wildcards > 1
  )
    throw new UndeclaredStateFileError(`state ${def.name}: "${def.path}" is not a path inside the plugin's folder`);
}

export function createStatePort(options: StatePortOptions): HostStatePort {
  const { home, pluginId, fs } = options;
  const root = pluginStateRoot(home, pluginId);
  const sqliteFiles = options.sqliteFiles ?? nodeSqliteFiles;
  const serial = new KeyedSerialExecutor();
  const declared = new Map<string, StateFileDef>();
  const paths = new Map<string, string>();
  for (const def of options.files) {
    validatePath(def);
    if (declared.has(def.name)) throw new UndeclaredStateFileError(`state ${def.name}: declared twice by ${pluginId}`);
    const claimed = paths.get(def.path);
    if (claimed !== undefined)
      throw new UndeclaredStateFileError(`state ${def.name}: ${def.path} is already claimed by ${claimed}`);
    declared.set(def.name, def);
    paths.set(def.path, def.name);
  }
  const damaged = new Map<string, StateDamage>((options.initialDamage ?? []).map(damage => [damage.file, damage]));
  const narrowed = new Map<string, StateDamage>((options.initialNarrowed ?? []).map(damage => [damage.file, damage]));

  /**
   * A plain name, or, for an opaque NAMED TREE (a def whose path ends `/*`, today's Conversation files under
   * `state/conversation/<ferret>/`), path-safe segments such as `F12/turns/turn-001.md`: each segment a plain
   * name, none `.` or `..`, and the tree's folder claimed by no other declared file.
   */
  const nameAllowed = (def: StateFileDef, name: string): boolean => {
    const plain = (segment: string): boolean => COLLECTION_NAME.test(segment) && segment !== '.' && segment !== '..';
    if (!name.includes('/')) return plain(name);
    if (def.store !== 'opaque' || !def.path.endsWith('/*')) return false;
    const folder = def.path.slice(0, -1);
    if ([...declared.values()].some(other => other.name !== def.name && other.path.startsWith(folder))) return false;
    return name.split('/').every(plain);
  };

  const locate = (def: StateFileDef, name: string | undefined): Located => {
    const known = declared.get(def.name);
    if (known === undefined || known.path !== def.path || known.store !== def.store || known.format !== def.format)
      throw new UndeclaredStateFileError(`${pluginId} did not declare the state file "${def.name}"`);
    const collection = def.path.includes('*');
    if (collection !== (name !== undefined))
      throw new UndeclaredStateFileError(
        collection
          ? `state ${def.name} is a collection: it needs a name`
          : `state ${def.name} is one file: it takes no name`,
      );
    if (name !== undefined && !nameAllowed(def, name))
      throw new UndeclaredStateFileError(`state ${def.name}: "${name}" is not a valid name`);
    const relative = name === undefined ? def.path : def.path.replace('*', name);
    return { path: `${root}/${relative}`, relative, label: stateLabel(pluginId, relative) };
  };

  const note = (def: StateFileDef, damage: StateDamage): void => {
    const policy = def.onDamaged === 'subsystem' ? 'subsystem' : 'narrower';
    if (policy === 'subsystem') damaged.set(damage.file, damage);
    else narrowed.set(damage.file, damage);
    if (policy === 'subsystem') options.changed?.([...damaged.values()]);
    options.report?.({ damage, policy, ...(options.clock === undefined ? {} : { at: options.clock.now() }) });
  };
  const healthy = (label: string): void => {
    const repaired = damaged.delete(label);
    narrowed.delete(label);
    if (repaired) options.changed?.([...damaged.values()]);
  };

  /** Line-by-line reading (`records` / `tail`): only an io fault or a missing required file is a damage. */
  const lenient = async <Shape>(
    def: StateFileDef<string, Shape>,
    name: string | undefined,
    maxBytes: number | undefined,
  ): Promise<JsonlRecords<Shape>> => {
    const at = locate(def, name);
    if (def.store !== 'jsonl') throw new TypeError(`state ${def.name}: only a jsonl file is read line by line`);
    const read = await readJsonlLines(fs, def, at.path, at.label, maxBytes);
    if (!read.ok) {
      note(def, read.error);
      if (def.onDamaged === 'subsystem') throw new StoreDamagedError(read.error);
      return { records: [], unreadable: 0 };
    }
    return read.value;
  };

  /** A file once found damaged is never written over: it is looked at again, and cleared only if it was repaired. */
  const guardWrite = async (def: StateFileDef, at: Located): Promise<void> => {
    if (!damaged.has(at.label) && !narrowed.has(at.label)) return;
    const again =
      def.store === 'jsonl'
        ? await readJsonlRecords(fs, def, at.path, at.label)
        : def.store === 'json'
          ? await readJsonDocument(fs, def, at.path, at.label)
          : ok(undefined);
    if (!again.ok) throw new StoreDamagedError(again.error);
    healthy(at.label);
  };

  const fileMode = (def: StateFileDef): number =>
    def.store === 'secret' ? PRIVATE_FILE_MODE : (def.mode ?? PRIVATE_FILE_MODE);

  const readRaw = async <Shape>(def: StateFileDef<string, Shape>, at: Located): Promise<StateRead<Shape>> => {
    if (def.store === 'json') return await readJsonDocument(fs, def, at.path, at.label);
    if (def.store === 'secret' || def.store === 'opaque')
      return (await readBytesFile(fs, def, at.path, at.label)) as StateRead<Shape>;
    throw new TypeError(`state ${def.name}: a ${def.store} file is not read with read()`);
  };

  const locateTree = (def: StateFileDef, name: string): Located => {
    const at = locate(def, name);
    if (def.store !== 'opaque' || !def.path.endsWith('/*'))
      throw new TypeError('state operation needs an opaque named tree');
    return at;
  };

  /** Check every parent with lstat; a planted link never becomes a route into another folder. */
  const treeParents = async (path: string, create: boolean): Promise<boolean> => {
    const parts = path
      .slice(home.length + 1)
      .split('/')
      .slice(0, -1);
    let parent = home;
    for (const part of ['', ...parts]) {
      if (part !== '') parent += `/${part}`;
      const info = await fs.info(parent);
      if (info === undefined) {
        if (!create) return false;
        await fs.ensureDirectory(parent, PRIVATE_DIRECTORY_MODE);
      } else if (!info.directory) throw new TypeError('state parent is not a directory');
    }
    return true;
  };

  const port: HostStatePort = {
    async stat(def, name) {
      const at = locateTree(def, name);
      if (!(await treeParents(at.path, false))) return undefined;
      const info = await fs.info(at.path);
      if (info === undefined) return undefined;
      const kind =
        info.symlink === true ? 'symlink' : info.directory ? 'directory' : info.regularFile ? 'file' : undefined;
      if (kind === undefined) throw new TypeError('state entry is not a file, directory or symlink');
      return { kind, modifiedMs: info.modifiedAtMs };
    },
    async createPrivateDirectory(def, name) {
      const at = locateTree(def, name);
      await treeParents(at.path, true);
      await fs.createPrivateDirectory(at.path);
    },
    async removeEmptyDirectory(def, name) {
      const at = locateTree(def, name);
      if (!(await treeParents(at.path, false))) return;
      await fs.removeEmptyDirectory(at.path);
    },
    sqliteGrant(def: StateFileDef, name?: string) {
      const at = locate(def, name);
      if (def.store !== 'sqlite' && def.store !== 'sqlite-cache')
        throw new TypeError(`state ${def.name}: only a sqlite file is opened on a worker`);
      return { path: at.path, label: at.label };
    },
    async read<Shape>(def: StateFileDef<string, Shape>, name?: string): Promise<StateRead<Shape>> {
      const at = locate(def, name);
      const result = await readRaw(def, at);
      if (result.ok) {
        healthy(at.label);
        return result;
      }
      note(def, result.error);
      // A narrower reading is reviewed to refuse whatever the file grants; the subsystem is not damaged.
      return def.onDamaged === 'subsystem' ? result : ok(undefined);
    },

    async write<Shape>(def: StateFileDef<string, Shape>, value: Shape, name?: string): Promise<void> {
      const at = locate(def, name);
      if (def.store === 'jsonl' || def.store === 'sqlite' || def.store === 'sqlite-cache')
        throw new TypeError(`state ${def.name}: a ${def.store} file is not written with write()`);
      await serial.run(at.path, async () => {
        await guardWrite(def, at);
        if (def.store === 'json') await fs.writeAtomic(at.path, `${encodeDocument(def, value, true)}\n`, fileMode(def));
        else {
          if (!(value instanceof Uint8Array) && typeof value !== 'string')
            throw new TypeError(`state ${def.name}: a ${def.store} file holds bytes`);
          await fs.writeAtomic(at.path, value, fileMode(def));
        }
      });
    },

    async update<Shape>(
      def: StateFileDef<string, Shape>,
      fn: (current: Shape | undefined) => Shape | Promise<Shape>,
      name?: string,
    ): Promise<Result<Shape, StateDamage>> {
      const at = locate(def, name);
      if (def.store !== 'json') throw new TypeError(`state ${def.name}: only a json file is updated in place`);
      return await serial.run(at.path, async () => {
        const current = await readJsonDocument(fs, def, at.path, at.label);
        // Damaged is not empty: a read-modify-write never starts from a file it could not read.
        if (!current.ok) {
          note(def, current.error);
          return err(current.error);
        }
        healthy(at.label);
        const next = await fn(current.value);
        // Declined: the transform answered the very value it was given, so nothing is written.
        if (current.value !== undefined && next === current.value) return ok(next);
        await fs.writeAtomic(at.path, `${encodeDocument(def, next, true)}\n`, fileMode(def));
        return ok(next);
      });
    },

    async append<Shape>(def: StateFileDef<string, Shape>, entry: Shape, name?: string): Promise<void> {
      const at = locate(def, name);
      if (def.store !== 'jsonl') throw new TypeError(`state ${def.name}: only a jsonl file is appended to`);
      const line = encodeDocument(def, entry, false);
      assertRecordSize(line);
      await serial.run(at.path, async () => {
        await guardWrite(def, at);
        await fs.appendLine(at.path, line, fileMode(def));
      });
    },

    async *lines<Shape>(def: StateFileDef<string, Shape>, name?: string): AsyncIterable<Shape> {
      // Today's journal read: a bad line is skipped and the rest still read (records() counts what was skipped).
      for (const record of (await lenient(def, name, undefined)).records) yield record;
    },

    async version(def: StateFileDef, name?: string): Promise<StateVersion | undefined> {
      const at = locate(def, name);
      const info = await fs.info(at.path);
      if (info === undefined) return undefined;
      return { size: info.size, etag: `${info.inode}:${info.size}:${info.modifiedAtMs}` };
    },

    async records<Shape>(def: StateFileDef<string, Shape>, name?: string): Promise<JsonlRecords<Shape>> {
      return await lenient(def, name, undefined);
    },

    async tail<Shape>(
      def: StateFileDef<string, Shape>,
      options: { readonly maxBytes: number; readonly name?: string },
    ): Promise<JsonlRecords<Shape>> {
      const { maxBytes } = options;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STATE_TAIL_BYTES)
        throw new TypeError(`state ${def.name}: tail reads 1 to ${MAX_STATE_TAIL_BYTES} bytes`);
      return await lenient(def, options.name, maxBytes);
    },

    async list(def: StateFileDef): Promise<readonly string[]> {
      const known = declared.get(def.name);
      if (known === undefined || known.path !== def.path)
        throw new UndeclaredStateFileError(`${pluginId} did not declare the state file "${def.name}"`);
      return await listCollection(fs, root, def);
    },

    async remove(def: StateFileDef, name?: string): Promise<void> {
      const at = locate(def, name);
      await serial.run(at.path, async () => {
        await fs.remove(at.path);
        if (def.store === 'sqlite' || def.store === 'sqlite-cache') {
          await fs.remove(`${at.path}-wal`);
          await fs.remove(`${at.path}-shm`);
        }
        healthy(at.label);
      });
    },

    pathOf(def: StateFileDef, name?: string): string {
      const at = locate(def, name);
      if (def.store !== 'opaque') throw new TypeError(`state ${def.name}: only an opaque file's path is handed out`);
      return at.path;
    },

    sqlite(def: StateFileDef, name?: string): SqliteHandle {
      const at = locate(def, name);
      if (def.store !== 'sqlite' && def.store !== 'sqlite-cache')
        throw new TypeError(`state ${def.name}: not a sqlite file`);
      try {
        return openSqlite(def, at.path, at.label, sqliteFiles);
      } catch (error) {
        if (error instanceof StoreDamagedError) note(def, error.damage);
        throw error;
      }
    },

    damaged: () => [...damaged.values()],
    narrowed: () => [...narrowed.values()],
  };
  return port;
}

/** The names a collection path holds right now, sorted; never a scratch file of an atomic write. */
export async function listCollection(fs: HostFs, root: string, def: StateFileDef): Promise<readonly string[]> {
  const star = def.path.indexOf('*');
  if (star < 0) throw new TypeError(`state ${def.name} is one file, not a collection`);
  const before = def.path.slice(0, star);
  const after = def.path.slice(star + 1);
  const slash = before.lastIndexOf('/');
  const folder = slash < 0 ? root : `${root}/${before.slice(0, slash)}`;
  const prefix = before.slice(slash + 1);
  const nested = after.includes('/');
  const names: string[] = [];
  for (const entry of await fs.list(folder)) {
    if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue;
    if (!entry.name.startsWith(prefix)) continue;
    if (nested) {
      if (entry.directory) names.push(entry.name.slice(prefix.length));
      continue;
    }
    if (!entry.name.endsWith(after) || entry.name.length <= prefix.length + after.length) continue;
    names.push(entry.name.slice(prefix.length, entry.name.length - after.length));
  }
  return names.filter(name => COLLECTION_NAME.test(name)).toSorted();
}

export { PRIVATE_DIRECTORY_MODE };
