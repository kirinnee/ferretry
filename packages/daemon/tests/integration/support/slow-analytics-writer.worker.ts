/**
 * The real analytics-writer program over a connection whose commits are slow (`slow-sqlite.ts`): the
 * analytics store's writer on a saturated disk. `SLOW_COMMIT_MS` arrives in the worker's environment.
 */
import {
  type AnalyticsWriterScope,
  serveAnalyticsWriter,
} from '../../../src/adapters/analytics/analytics-writer-program.ts';
import { SlowCommitDatabase } from './slow-sqlite.ts';

declare const self: AnalyticsWriterScope;

const commitMs = Number(process.env.SLOW_COMMIT_MS ?? '1000');
serveAnalyticsWriter(self, file => new SlowCommitDatabase(file, commitMs));
