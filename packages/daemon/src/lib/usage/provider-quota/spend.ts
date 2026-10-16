import type { AnalyticsRawSession } from '@ferretry/protocol';
import type { TranscriptSpend } from './service.ts';

/**
 * What the indexed sessions on these runtimes cost since an instant: their equivalent cost summed,
 * and how many had no price. `undefined` when no session matched — "nothing counted", which is not
 * "it cost nothing".
 *
 * Pure. The rows are the analytics index's, which prices a session when it is ingested.
 */
export function transcriptSpend(
  rows: readonly AnalyticsRawSession[],
  agents: readonly string[],
  sinceMs: number,
): TranscriptSpend | undefined {
  const wanted = new Set(agents);
  let usdMicros = 0;
  let sessions = 0;
  let unpriced = 0;
  for (const row of rows) {
    if (row.agent === null || !wanted.has(row.agent)) continue;
    const created = row.createdAt === null ? Number.NaN : Date.parse(row.createdAt);
    if (!(created >= sinceMs)) continue;
    sessions += 1;
    if (row.equivalentApiCostUsdMicros === null) unpriced += 1;
    else usdMicros += row.equivalentApiCostUsdMicros;
  }
  return sessions === 0 ? undefined : { usdMicros, sessions, unpriced };
}
