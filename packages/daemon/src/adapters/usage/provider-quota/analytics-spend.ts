import type { AnalyticsIndexRead } from '../../../lib/analytics/ingestion.ts';
import { type TranscriptSpend, type TranscriptSpendPort, transcriptSpend } from '../../../lib/usage/index.ts';

/**
 * The second quota source (docs/provider-quotas.md): what this daemon's own sessions on a login cost,
 * read from the analytics index the ingestion pass keeps — tokens counted from each transcript times
 * the operator's pricing catalogue. Read per call, so a session ingested a moment ago counts.
 */
export class AnalyticsTranscriptSpend implements TranscriptSpendPort {
  constructor(private readonly index: { read(): AnalyticsIndexRead }) {}

  async spend(agents: readonly string[], sinceMs: number): Promise<TranscriptSpend | undefined> {
    return transcriptSpend(this.index.read().rows, agents, sinceMs);
  }
}
