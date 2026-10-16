import { describe, it } from 'bun:test';
import type { AnalyticsRawSession } from '@ferretry/protocol';
import should from 'should';
import { transcriptSpend } from '../../../../src/lib/usage/provider-quota/spend.ts';

const SINCE = Date.parse('2026-10-01T00:00:00.000Z');

const row = (
  agent: string | null,
  createdAt: string | null,
  cost: number | null,
): Pick<AnalyticsRawSession, 'agent' | 'createdAt' | 'equivalentApiCostUsdMicros'> => ({
  agent,
  createdAt,
  equivalentApiCostUsdMicros: cost,
});

describe('transcriptSpend', () => {
  it('should sum the priced sessions on these runtimes since the instant, and count the unpriced ones', () => {
    // Arrange
    const rows = [
      row('glm-a', '2026-10-02T00:00:00.000Z', 1_500_000),
      row('glm-b', '2026-10-03T00:00:00.000Z', null),
      row('glm-a', '2026-09-30T23:59:59.000Z', 9_000_000),
      row('claude', '2026-10-04T00:00:00.000Z', 7_000_000),
      row(null, '2026-10-04T00:00:00.000Z', 7_000_000),
      row('glm-a', null, 7_000_000),
    ] as AnalyticsRawSession[];

    // Act
    const actual = transcriptSpend(rows, ['glm-a', 'glm-b'], SINCE);

    // Assert
    should(actual).deepEqual({ usdMicros: 1_500_000, sessions: 2, unpriced: 1 });
  });

  it('should count nothing — not $0 — when no session matched', () => {
    // Act & Assert
    should(transcriptSpend([], ['glm-a'], SINCE)).be.undefined();
  });
});
