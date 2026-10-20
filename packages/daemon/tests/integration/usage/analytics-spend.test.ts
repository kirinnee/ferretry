import { describe, it } from 'bun:test';
import type { AnalyticsRawSession } from '@ferretry/protocol';
import should from 'should';
import { AnalyticsTranscriptSpend } from '../../../src/adapters/usage/provider-quota/analytics-spend.ts';
import type { AnalyticsIndexRead } from '../../../src/lib/analytics/ingestion.ts';

const row = (agent: string, createdAt: string, cost: number | null) =>
  ({ agent, createdAt, equivalentApiCostUsdMicros: cost }) as AnalyticsRawSession;

describe('AnalyticsTranscriptSpend', () => {
  it('should read the index afresh on each call and sum what these runtimes cost since the instant', async () => {
    // Arrange
    const rows: AnalyticsRawSession[] = [row('glm-a', '2026-10-02T00:00:00.000Z', 2_000_000)];
    let reads = 0;
    const index = {
      read: (): AnalyticsIndexRead => {
        reads += 1;
        return { rows: [...rows], status: {} as AnalyticsIndexRead['status'], now: '2026-10-20T00:00:00.000Z' };
      },
    };
    const spend = new AnalyticsTranscriptSpend(index);
    const since = Date.parse('2026-10-01T00:00:00.000Z');

    // Act
    const first = await spend.spend(['glm-a'], since);
    rows.push(row('glm-a', '2026-10-05T00:00:00.000Z', null));
    const second = await spend.spend(['glm-a'], since);

    // Assert
    should(first).deepEqual({ usdMicros: 2_000_000, sessions: 1, unpriced: 0 });
    should(second).deepEqual({ usdMicros: 2_000_000, sessions: 2, unpriced: 1 });
    should(reads).equal(2);
  });
});
