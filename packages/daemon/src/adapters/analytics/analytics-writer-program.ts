/**
 * THE ANALYTICS-WRITER THREAD'S WHOLE PROGRAM: it applies each batch it is sent to the analytics file as
 * one transaction, on a connection it opens for that batch and closes after it.
 *
 * Its own module, not the worker's entry file, so the same program can be served over a fake scope in a
 * test, or over a connection that is deliberately slow; `bin/analytics-index.worker.ts` only serves it.
 *
 * It holds nothing between batches but the file's name, so losing the thread loses no data (the main
 * thread keeps every batch until it is answered) and an idle thread can simply be ended: the analytics
 * file is written when a session finishes, which is rare, and a thread parked for it would carry about
 * 14 MB of engine between writes. SQLite checkpoints the connection's log after its commits, so the
 * `fsync` of a checkpoint — the call that froze the daemon for seconds on a saturated disk — happens on
 * this thread, and nowhere else.
 */
import type { Database } from 'bun:sqlite';
import type { AnalyticsStoreWrites } from '../../lib/analytics/store-writes.ts';
import { applyAnalyticsWrites, configureAnalyticsConnection } from './sqlite-analytics-statements.ts';

export type AnalyticsWriterRequest =
  | { readonly probe: true }
  /** The greeting: the file this thread writes. Sent once, before the first batch. */
  | { readonly kind: 'open'; readonly file: string }
  | { readonly kind: 'persist'; readonly id: number; readonly writes: AnalyticsStoreWrites }
  | { readonly kind: 'close'; readonly id: number };

export type AnalyticsWriterResponse =
  | { readonly probe: true }
  | { readonly id: number; readonly ok: true }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** The part of a worker's global scope the program uses. */
export interface AnalyticsWriterScope {
  onmessage: ((event: MessageEvent<AnalyticsWriterRequest>) => void) | null;
  postMessage(message: AnalyticsWriterResponse): void;
}

/** Answers every request `scope` receives, opening the file through `open` for each batch. */
export function serveAnalyticsWriter(scope: AnalyticsWriterScope, open: (file: string) => Database): void {
  let file: string | undefined;
  scope.onmessage = ({ data: request }) => {
    if ('probe' in request) return scope.postMessage({ probe: true });
    if (request.kind === 'open') {
      file = request.file;
      return;
    }
    const { id } = request;
    try {
      if (file === undefined) throw new Error('the analytics writer was asked to write before it was opened');
      const database = open(file);
      try {
        if (request.kind === 'persist') {
          configureAnalyticsConnection(database);
          applyAnalyticsWrites(database, request.writes);
        } else {
          database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
      } finally {
        database.close();
      }
      scope.postMessage({ id, ok: true });
    } catch (error) {
      // The store holds session labels and spend, never transcript text, so SQLite's message is safe to quote.
      scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
