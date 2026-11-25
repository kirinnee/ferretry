import type { AnalyticsRawSession } from '../../../../contract/index.ts';
import { type TranscriptSpend, type TranscriptSpendPort, transcriptSpend } from '../../../lib/usage/index.ts';

/**
 * How long the stored rows are held between reads. A watch reads every login in one go, and each login asks for its
 * own spend: without a hold that is one read of the whole index PER LOGIN, on the daemon's one thread. The quota
 * service already refuses to read a login twice within a minute, so a few seconds of hold is never visible.
 */
export const TRANSCRIPT_SPEND_HOLD_MS = 5_000;

/**
 * The second quota source (docs/provider-quotas.md): what this daemon's own sessions on a login cost,
 * read from the analytics index the ingestion pass keeps — the cost each row was priced at when it was
 * ingested, summed per login. The rows are read once per {@link TRANSCRIPT_SPEND_HOLD_MS}, never once per login, and
 * are NOT re-priced at today's rates: this sum never looks at that figure.
 */
export class AnalyticsTranscriptSpend implements TranscriptSpendPort {
  #held: { readonly rows: readonly AnalyticsRawSession[]; readonly atMs: number } | undefined;

  constructor(
    private readonly index: { rawRows(): readonly AnalyticsRawSession[] },
    private readonly nowMs: () => number,
  ) {}

  async spend(agents: readonly string[], sinceMs: number): Promise<TranscriptSpend | undefined> {
    return transcriptSpend(this.rows(), agents, sinceMs);
  }

  private rows(): readonly AnalyticsRawSession[] {
    const now = this.nowMs();
    if (this.#held !== undefined && now - this.#held.atMs >= 0 && now - this.#held.atMs < TRANSCRIPT_SPEND_HOLD_MS)
      return this.#held.rows;
    const rows = this.index.rawRows();
    this.#held = { rows, atMs: now };
    return rows;
  }
}
