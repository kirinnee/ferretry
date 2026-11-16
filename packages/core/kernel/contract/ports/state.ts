import type { Result } from '@ferretry/std';
import type { StateFileDef } from '../define.ts';

/** Why a declared file could not be used (§9.3). A damaged subsystem answers `store_damaged`, never as empty. */
export interface StateDamage {
  readonly file: string;
  readonly reason: 'unparsable' | 'no_format' | 'lower_format' | 'higher_format' | 'schema' | 'missing' | 'io';
  readonly sentence: string;
}

export type StateRead<Shape> = Result<Shape | undefined, StateDamage>;

/** A SQLite handle on a declared `sqlite` / `sqlite-cache` file. */
export interface SqliteHandle {
  query<Row>(sql: string, params?: readonly unknown[]): readonly Row[];
  run(sql: string, params?: readonly unknown[]): { readonly changes: number };
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** {@link StatePort.version}: `etag` is opaque; equal etags mean the same file, unchanged. */
export interface StateVersion {
  readonly size: number;
  readonly etag: string;
  /**
   * Whether equal etags can be taken to mean the same BYTES, not merely "nothing the filesystem stamped has moved". It
   * is true only when the etag carries the file's device and nanosecond status-change time (which no caller can set
   * back) and that time is neither a whole millisecond (a coarse clock) nor within a few ticks of now (a later write in
   * the same tick would leave it as it is). A reader that skips a re-read on an equal etag must require it; absent or
   * false, the file is simply read again.
   */
  readonly settled?: boolean;
}

/** A JSONL file read line by line: every record that checked, and how many lines did not (never their text). */
export interface JsonlRecords<Shape> {
  readonly records: readonly Shape[];
  /** Lines that were not JSON, not UTF-8, too large, or failed the format check. A torn last line is not counted. */
  readonly unreadable: number;
}

/** The most `tail` reads from the end of a file. */
export const MAX_STATE_TAIL_BYTES = 64 * 1024 * 1024;

/**
 * `state/<id>/` and nothing else: atomic JSON/JSONL, SQLite transactions, each declared file's format check. `name`
 * fills the `*` of a collection path. Writes stamp `format` first.
 */
export interface StatePort {
  read<Shape>(file: StateFileDef<string, Shape>, name?: string): Promise<StateRead<Shape>>;
  /**
   * Replaces a file whole, atomically. A `jsonl` file takes an ARRAY of records (one line each, as `append` writes them)
   * and is swapped in on the same chain as its appends, so a log can be compacted without a reader seeing half of it.
   */
  write<Shape>(file: StateFileDef<string, Shape>, value: Shape, name?: string): Promise<void>;
  /**
   * Read-modify-write on one serialization chain per file. `fn` may be async (it runs inside the chain). Returning
   * `current` itself (the same reference) DECLINES: nothing is written and `current` is answered (today's session
   * storage: a CAS loser or an already-applied transform has no write).
   */
  update<Shape>(
    file: StateFileDef<string, Shape>,
    fn: (current: Shape | undefined) => Shape | Promise<Shape>,
    name?: string,
  ): Promise<Result<Shape, StateDamage>>;
  append<Shape>(file: StateFileDef<string, Shape>, entry: Shape, name?: string): Promise<void>;
  /**
   * Each record in order. A line that does not parse or check is SKIPPED and reading goes on (today's journal read);
   * `records()` says how many were skipped. Only an io fault or a missing `required` file is damage.
   * The file is read a piece at a time, as the reader asks, and a record is handed out as soon as its line is complete:
   * a journal of any size costs one piece, never the whole file. A fault part way ends the read after the records
   * already handed out. Stopping early stops the read.
   */
  lines<Shape>(file: StateFileDef<string, Shape>, name?: string): AsyncIterable<Shape>;
  /**
   * A cheap identity of one file from a single `lstat` (no read): its size and an etag that moves on any rewrite or
   * append, so a reader can tell "unchanged since I last looked" without re-reading a journal. `undefined` when absent.
   */
  version(file: StateFileDef, name?: string): Promise<StateVersion | undefined>;
  /**
   * Every line checked on its own (a log, a journal): a bad line is skipped and counted rather than damaging the file,
   * so one torn or hand-edited line never hides the rest. A missing file is no records.
   */
  records<Shape>(file: StateFileDef<string, Shape>, name?: string): Promise<JsonlRecords<Shape>>;
  /**
   * The same, over only the last `maxBytes` of the file (at most {@link MAX_STATE_TAIL_BYTES}): a line cut by the
   * window's start is dropped, not counted. Reads no more than that from disk.
   */
  tail<Shape>(
    file: StateFileDef<string, Shape>,
    options: { readonly maxBytes: number; readonly name?: string },
  ): Promise<JsonlRecords<Shape>>;
  list(file: StateFileDef): Promise<readonly string[]>;
  /** Own opaque named trees only. Metadata of the entry itself via lstat; a symlink is never followed. */
  stat(
    file: StateFileDef,
    name: string,
  ): Promise<{ readonly kind: 'file' | 'directory' | 'symlink'; readonly modifiedMs: number } | undefined>;
  /**
   * Own opaque named trees only. What is directly inside one directory of the tree (never followed into a link, and a
   * link there is a `symlink` entry): `[]` when the directory is absent or is itself not a plain directory. A walk of
   * the whole tree is the caller's loop, so it can bound it.
   */
  entries(
    file: StateFileDef,
    name: string,
  ): Promise<readonly { readonly name: string; readonly kind: 'file' | 'directory' | 'symlink' }[]>;
  /** Own opaque named trees only. Plain rmdir: never recursive, refuses links and nonempty directories. */
  removeEmptyDirectory(file: StateFileDef, name: string): Promise<void>;
  /** Own opaque named trees only. Exclusive mkdir, mode 0700; any existing entry is refused. */
  createPrivateDirectory(file: StateFileDef, name: string): Promise<void>;
  remove(file: StateFileDef, name?: string): Promise<void>;
  sqlite(file: StateFileDef, name?: string): SqliteHandle;
  /**
   * The absolute path of one of THIS plugin's own declared `opaque` state files (today's `tmux.sock` under
   * `state/terminals/`), for a child that makes or opens the file itself. An opaque def whose path ends `/*` is a
   * NAMED TREE: its name may be path-safe segments (`F12/turns/turn-001.md`, today's Conversation files), written
   * with `write` and handed on by this path. Any other store, or an undeclared file,
   * throws: a path is never handed out for a file the port reads and writes, nor for another plugin's.
   */
  pathOf(file: StateFileDef, name?: string): string;
  /** Whether this subsystem is damaged, and which files. */
  damaged(): readonly StateDamage[];
}
