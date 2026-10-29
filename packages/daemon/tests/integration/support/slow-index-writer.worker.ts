/**
 * The real index-writer program over a connection whose commits are slow (`slow-sqlite.ts`): the
 * session index writer on a saturated disk. `SLOW_COMMIT_MS` arrives in the worker's environment.
 */
import { type IndexWriterScope, serveIndexWriter } from '../../../src/adapters/storage/index-writer-program.ts';
import { SlowCommitDatabase } from './slow-sqlite.ts';

declare const self: IndexWriterScope;

const commitMs = Number(process.env.SLOW_COMMIT_MS ?? '1000');
serveIndexWriter(self, file => new SlowCommitDatabase(file, commitMs));
