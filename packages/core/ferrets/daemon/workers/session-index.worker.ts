/**
 * The session index writer: the one thread that writes the session index file
 * (today's `src/adapters/storage/index-writer-program.ts` is its program and says why it exists).
 *
 * That program is placed to the kernel and is not in it, so it is handed in: the thread's entry module calls
 * {@link serveSessionIndexWorker} with its own `self` and the program. What this keeps is the one thing it always
 * decided — the index is opened with `strict` bindings.
 */
import { Database } from 'bun:sqlite';

/** Today's `serveIndexWriter(scope, open)`: serves index writes on `scope`, opening the file through `open`. */
export type IndexWriterProgram<Scope> = (scope: Scope, open: (file: string) => Database) => void;

export function serveSessionIndexWorker<Scope>(scope: Scope, serveIndexWriter: IndexWriterProgram<Scope>): void {
  serveIndexWriter(scope, file => new Database(file, { strict: true }));
}
