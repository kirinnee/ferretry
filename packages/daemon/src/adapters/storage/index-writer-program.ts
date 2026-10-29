/**
 * THE INDEX-WRITER THREAD'S WHOLE PROGRAM: it owns the connection to the session index file, loads the
 * file at boot, and applies each batch it is sent as one transaction.
 *
 * Its own module, not the worker's entry file, so the same program can be served over a fake scope in a
 * test, or over a connection that is deliberately slow; `bin/session-index.worker.ts` only serves it.
 * It imports nothing at run time but the index's SQL, and holds nothing between batches but the
 * connection: losing the thread loses no data, because the main thread keeps every batch until it is
 * answered.
 *
 * SQLite checkpoints this connection's log after its commits, so the `fsync` of a checkpoint — the call
 * that froze the daemon for seconds on a saturated disk — happens on this thread, and nowhere else.
 */
import type { Database } from 'bun:sqlite';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IndexWrite } from '../../lib/index-writes.ts';
import { type IndexLoad, loadIndexFile } from './sqlite-index-schema.ts';
import { applyIndexWrites, configureIndexConnection } from './sqlite-index-statements.ts';

export type IndexWriterRequest =
  | { readonly probe: true }
  /** The greeting: the file this thread owns. Sent once to each thread, before its first request. */
  | { readonly kind: 'open'; readonly file: string }
  /** The boot's open: check, create or migrate the file, and send it back whole. */
  | { readonly kind: 'load'; readonly id: number }
  | { readonly kind: 'persist'; readonly id: number; readonly writes: readonly IndexWrite[] }
  | { readonly kind: 'close'; readonly id: number };

export type IndexWriterResponse =
  | { readonly probe: true }
  | { readonly id: number; readonly ok: true; readonly load?: IndexLoad }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** The part of a worker's global scope the program uses. */
export interface IndexWriterScope {
  onmessage: ((event: MessageEvent<IndexWriterRequest>) => void) | null;
  postMessage(message: IndexWriterResponse): void;
}

/**
 * Refuses a symbolic link at the file, its sidecars or its directory before SQLite follows one.
 *
 * The boot's open is preflighted by the daemon's confined filesystem port, on the main thread; a thread
 * that replaces a failed one reopens the file later with no port to ask, so it holds this narrower line
 * itself: SQLite would otherwise write wherever a link planted there since boot pointed.
 */
function refuseLinks(file: string): void {
  // The sidecars as `sqliteDatabaseFiles` names them, spelled here because that module drags in zod.
  for (const path of [dirname(file), file, `${file}-wal`, `${file}-shm`]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      throw new Error(`the session index refuses to follow a symbolic link: ${path}`);
    }
  }
}

/** Answers every request `scope` receives, opening the file it is greeted with through `open`. */
export function serveIndexWriter(scope: IndexWriterScope, open: (file: string) => Database): void {
  let file: string | undefined;
  let database: Database | undefined;
  const connection = (): Database => {
    if (database !== undefined) return database;
    if (file === undefined) throw new Error('the index writer was asked to write before it was greeted');
    refuseLinks(file);
    database = open(file);
    configureIndexConnection(database);
    return database;
  };
  const release = (): void => {
    database?.close();
    database = undefined;
  };
  scope.onmessage = ({ data: request }) => {
    if ('probe' in request) return scope.postMessage({ probe: true });
    if (request.kind === 'open') {
      file = request.file;
      return;
    }
    const { id } = request;
    try {
      if (request.kind === 'load') {
        // A fresh connection, so a file the caller deleted and recreated is the one that is read.
        release();
        const load = loadIndexFile(connection());
        // An obsolete file is let go of, so the caller can delete it.
        if (load.kind === 'drop') release();
        return scope.postMessage({ id, ok: true, load });
      }
      if (request.kind === 'persist') {
        applyIndexWrites(connection(), request.writes);
      } else if (database !== undefined) {
        try {
          database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally {
          release();
        }
      }
      scope.postMessage({ id, ok: true });
    } catch (error) {
      // The index holds pointers and fingerprints, never session text, so SQLite's message is safe to quote.
      scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
