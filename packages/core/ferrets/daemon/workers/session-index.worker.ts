/**
 * The session index writer: the one thread that writes the session index file
 * (`src/adapters/storage/index-writer-program.ts` is its program and says why it exists).
 */
import { Database } from 'bun:sqlite';
import { type IndexWriterScope, serveIndexWriter } from '../src/adapters/storage/index-writer-program.ts';

declare const self: IndexWriterScope;

serveIndexWriter(self, file => new Database(file, { strict: true }));
