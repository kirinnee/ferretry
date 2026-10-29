/**
 * THE INDEX-WRITER THREAD'S WHOLE PROGRAM: it owns a connection to the session index file and applies
 * each batch it is sent as one transaction.
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
import type { IndexWrite } from '../../lib/index-writes.ts';
import { applyIndexWrites, configureIndexConnection } from './sqlite-index-statements.ts';

export type IndexWriterRequest =
  | { readonly probe: true }
  /** The greeting: the file this thread owns. Sent once, before the first batch. */
  | { readonly kind: 'open'; readonly file: string }
  | { readonly kind: 'persist'; readonly id: number; readonly writes: readonly IndexWrite[] }
  | { readonly kind: 'close'; readonly id: number };

export type IndexWriterResponse =
  | { readonly probe: true }
  | { readonly id: number; readonly ok: true }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** The part of a worker's global scope the program uses. */
export interface IndexWriterScope {
  onmessage: ((event: MessageEvent<IndexWriterRequest>) => void) | null;
  postMessage(message: IndexWriterResponse): void;
}

/** Answers every request `scope` receives, opening the file through `open` when it is greeted. */
export function serveIndexWriter(scope: IndexWriterScope, open: (file: string) => Database): void {
  let database: Database | undefined;
  scope.onmessage = ({ data: request }) => {
    if ('probe' in request) return scope.postMessage({ probe: true });
    if (request.kind === 'open') {
      database = open(request.file);
      configureIndexConnection(database);
      return;
    }
    const { id } = request;
    try {
      if (database === undefined) throw new Error('the index writer was asked to write before it was opened');
      if (request.kind === 'persist') {
        applyIndexWrites(database, request.writes);
      } else {
        try {
          database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally {
          database.close();
          database = undefined;
        }
      }
      scope.postMessage({ id, ok: true });
    } catch (error) {
      // The index holds pointers and fingerprints, never session text, so SQLite's message is safe to quote.
      scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
