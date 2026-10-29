/**
 * The analytics store writer: the one thread that writes the analytics index file
 * (`src/adapters/analytics/analytics-writer-program.ts` is its program and says why it exists).
 */
import { Database } from 'bun:sqlite';
import { type AnalyticsWriterScope, serveAnalyticsWriter } from '../src/adapters/analytics/analytics-writer-program.ts';

declare const self: AnalyticsWriterScope;

serveAnalyticsWriter(self, file => new Database(file, { strict: true }));
