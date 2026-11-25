import { describe, it } from 'bun:test';
import type { AnalyticsRawSession } from '../../../contract/index.ts';
import should from 'should';
import {
  AnalyticsTranscriptSpend,
  TRANSCRIPT_SPEND_HOLD_MS,
} from '../../../daemon/adapters/usage/provider-quota/analytics-spend.ts';

const row = (agent: string, createdAt: string, cost: number | null) =>
  ({ agent, createdAt, equivalentApiCostUsdMicros: cost }) as AnalyticsRawSession;

const since = Date.parse('2026-10-01T00:00:00.000Z');

/** An index that counts how many times the whole store was read, and a clock the case moves. */
function subject(rows: AnalyticsRawSession[]) {
  const clock = { now: 1_000_000 };
  const index = {
    reads: 0,
    rawRows: (): readonly AnalyticsRawSession[] => {
      index.reads += 1;
      return [...rows];
    },
  };
  return { clock, index, spend: new AnalyticsTranscriptSpend(index, () => clock.now) };
}

describe('AnalyticsTranscriptSpend', () => {
  it('should sum what these runtimes cost since the instant, from the cost each row was priced at', async () => {
    // Arrange
    const { spend } = subject([
      row('glm-a', '2026-10-02T00:00:00.000Z', 2_000_000),
      row('glm-a', '2026-10-05T00:00:00.000Z', null),
      row('glm-b', '2026-10-05T00:00:00.000Z', 9),
      row('glm-a', '2026-09-01T00:00:00.000Z', 7),
    ]);

    // Act
    const result = await spend.spend(['glm-a'], since);

    // Assert
    should(result).deepEqual({ usdMicros: 2_000_000, sessions: 2, unpriced: 1 });
  });

  it('should read the whole index once for a watch of many logins, not once per login', async () => {
    // Arrange: a watch asks every login at once, which was one full read (and re-price) of every row per login.
    const { spend, index } = subject([row('glm-a', '2026-10-02T00:00:00.000Z', 1)]);

    // Act
    await Promise.all(
      Array.from({ length: 40 }, async (_, login) => await spend.spend([`glm-${String(login)}`], since)),
    );

    // Assert
    should(index.reads).equal(1);
  });

  it('should read afresh once the hold has passed, so a session ingested a moment ago counts', async () => {
    // Arrange
    const rows = [row('glm-a', '2026-10-02T00:00:00.000Z', 2_000_000)];
    const { spend, index, clock } = subject(rows);
    const first = await spend.spend(['glm-a'], since);
    rows.push(row('glm-a', '2026-10-05T00:00:00.000Z', null));

    // Act
    clock.now += TRANSCRIPT_SPEND_HOLD_MS;
    const second = await spend.spend(['glm-a'], since);

    // Assert
    should(first).deepEqual({ usdMicros: 2_000_000, sessions: 1, unpriced: 0 });
    should(second).deepEqual({ usdMicros: 2_000_000, sessions: 2, unpriced: 1 });
    should(index.reads).equal(2);
  });
});
