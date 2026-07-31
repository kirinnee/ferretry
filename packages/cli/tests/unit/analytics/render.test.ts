import { describe, it } from 'bun:test';
import { AnalyticsResponseSchema } from '@ferretry/protocol';
import should from 'should';
import { EQUIVALENT_API_COST_CAVEAT, renderAnalytics } from '../../../src/lib/analytics/render';
import { INDEX, aggregate, aggregateResponse, known, partial, rawResponse, rawSession, unknown } from './fixtures';

const lines = (text: string): string[] => text.split('\n');
const row = (text: string, index: number): string => lines(text)[index] ?? '';

describe('analytics response fixtures', () => {
  it('should be shapes the protocol actually accepts', () => {
    // Act
    const aggregated = AnalyticsResponseSchema.safeParse(aggregateResponse([aggregate()]));
    const raw = AnalyticsResponseSchema.safeParse(rawResponse([rawSession()]));

    // Assert — rendering a shape the wire would reject proves nothing.
    should(aggregated.success).be.true();
    should(raw.success).be.true();
  });
});

describe('analytics header and footer', () => {
  it('should lead with the scope and the query', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()]));

    // Assert
    should(row(actual, 0)).equal('All sessions: 40 indexed, 24 matched');
    should(row(actual, 1)).equal('Query: sum(tokens) by agent');
  });

  it('should say so plainly when no query was given', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()], { query: '' }));

    // Assert — kteam printed a bare "Query:" with nothing after it.
    should(row(actual, 1)).equal('Query: (none)');
  });

  it('should report how complete the token index is', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()]));

    // Assert
    should(actual).containEql('Token index: 32/40 sessions known; 10/10 transcript sources indexed.');
  });

  it('should mention pending sources and source errors when there are any', () => {
    // Arrange
    const index = { ...INDEX, indexedTranscriptSources: 6, pendingTranscriptSources: 4, sourceErrors: 2 };

    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()], { index }));

    // Assert
    should(actual).containEql('6/10 transcript sources indexed (4 pending), 2 errors.');
  });

  it('should announce a running backfill so a short number is not read as final', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()], { index: { ...INDEX, refreshing: true } }));

    // Assert
    should(actual).containEql('Token backfill is running in the daemon.');
  });

  it('should not announce a backfill that is not running', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()]));

    // Assert
    should(actual).not.containEql('Token backfill');
  });

  it('should always carry the equivalent-cost caveat', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()]));

    // Assert
    should(actual).endWith(EQUIVALENT_API_COST_CAVEAT);
  });

  it('should explain the coverage annotation', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()]));

    // Assert
    should(actual).containEql('[known/total] marks a group the index cannot fully account for');
  });
});

describe('aggregate table', () => {
  it('should say so when nothing matched', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([]));

    // Assert
    should(actual).containEql('No sessions match the query.');
  });

  it('should render the full measure set for a sum', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate()]));

    // Assert
    should(row(actual, 3)).startWith('GROUP');
    should(row(actual, 3)).containEql('EQUIV API COST');
    should(row(actual, 5)).equal(
      'agent=sol  4         1.0m   234.6k  900.0k      100.0k       1.2m   $12.50          48     1h02m     850ms  64.3%    5.00%  12.5%  82.5%',
    );
  });

  it('should render only counts and rates for a count aggregation', () => {
    // Act
    const actual = renderAnalytics(
      aggregateResponse([aggregate()], {
        aggregation: 'count',
        parsed: { aggregation: 'count', groupBy: ['agent'], matchers: [] },
      }),
    );

    // Assert
    should(row(actual, 3)).equal('GROUP      SESSIONS  STALL  FAIL   DONE');
    should(row(actual, 5)).equal('agent=sol  4         5.00%  12.5%  82.5%');
  });

  it('should label an ungrouped result as covering everything', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate({ labels: {} })]));

    // Assert
    should(row(actual, 5)).startWith('all ');
  });

  it('should dash a label the index could not attribute', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate({ labels: { agent: null } })]));

    // Assert
    should(row(actual, 5)).startWith('agent=—');
  });

  it('should join a multi-label group', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate({ labels: { agent: 'sol', day: '2026-07-31' } })]));

    // Assert
    should(row(actual, 5)).startWith('agent=sol, day=2026-07-31');
  });

  it('should sort the most expensive group first', () => {
    // Arrange
    const cheap = aggregate({ labels: { agent: 'cheap' }, equivalentApiCostUsdMicros: known(1_000_000) });
    const dear = aggregate({ labels: { agent: 'dear' }, equivalentApiCostUsdMicros: known(90_000_000) });

    // Act
    const actual = renderAnalytics(aggregateResponse([cheap, dear]));

    // Assert
    should(row(actual, 5)).startWith('agent=dear');
    should(row(actual, 6)).startWith('agent=cheap');
  });

  it('should sink a group whose cost is unknown below every priced group', () => {
    // Arrange
    const priced = aggregate({ labels: { agent: 'priced' }, equivalentApiCostUsdMicros: known(1) });
    const unpriced = aggregate({ labels: { agent: 'unpriced' }, equivalentApiCostUsdMicros: unknown() });

    // Act
    const actual = renderAnalytics(aggregateResponse([unpriced, priced]));

    // Assert
    should(row(actual, 5)).startWith('agent=priced');
    should(row(actual, 6)).startWith('agent=unpriced');
  });

  it('should break a cost tie on sessions, then on group label, so the table is reproducible', () => {
    // Arrange — same cost; kteam left this order to the engine, so the table shuffled between runs.
    const cost = known(5_000_000);
    const zeta = aggregate({ labels: { agent: 'zeta' }, sessions: 2, equivalentApiCostUsdMicros: cost });
    const alpha = aggregate({ labels: { agent: 'alpha' }, sessions: 2, equivalentApiCostUsdMicros: cost });
    const busiest = aggregate({ labels: { agent: 'busiest' }, sessions: 9, equivalentApiCostUsdMicros: cost });

    // Act
    const actual = renderAnalytics(aggregateResponse([zeta, alpha, busiest]));

    // Assert
    should([row(actual, 5), row(actual, 6), row(actual, 7)].map(line => line.split(' ')[0])).deepEqual([
      'agent=busiest',
      'agent=alpha',
      'agent=zeta',
    ]);
  });

  it('should keep two unpriced groups in a stable order too', () => {
    // Arrange
    const first = aggregate({ labels: { agent: 'b' }, sessions: 3, equivalentApiCostUsdMicros: unknown() });
    const second = aggregate({ labels: { agent: 'a' }, sessions: 3, equivalentApiCostUsdMicros: unknown() });

    // Act
    const actual = renderAnalytics(aggregateResponse([first, second]));

    // Assert
    should(row(actual, 5)).startWith('agent=a');
  });

  it('should leave a count aggregation in the order the engine produced', () => {
    // Arrange
    const cheap = aggregate({ labels: { agent: 'cheap' }, equivalentApiCostUsdMicros: known(1) });
    const dear = aggregate({ labels: { agent: 'dear' }, equivalentApiCostUsdMicros: known(99_000_000) });

    // Act — `count` has no cost column, so re-sorting on cost would reorder rows for no visible reason.
    const actual = renderAnalytics(
      aggregateResponse([cheap, dear], {
        aggregation: 'count',
        parsed: { aggregation: 'count', groupBy: ['agent'], matchers: [] },
      }),
    );

    // Assert
    should(row(actual, 5)).startWith('agent=cheap');
  });

  it('should mark a group the index only partly knows', () => {
    // Act
    const actual = renderAnalytics(aggregateResponse([aggregate({ tokens: partial(500, 2, 9) })]));

    // Assert
    should(row(actual, 5)).containEql('500[2/9]');
  });
});

describe('raw table', () => {
  it('should say so when nothing matched', () => {
    // Act
    const actual = renderAnalytics(rawResponse([]));

    // Assert
    should(actual).containEql('No sessions match the query.');
  });

  it('should render one row per session with agent and harness', () => {
    // Act
    const actual = renderAnalytics(rawResponse([rawSession()]));

    // Assert — kteam read `result.wrapper`, a field the protocol does not have, so the column was blank.
    should(row(actual, 3)).equal(
      'ID        STATUS     AGENT             MODEL          HARNESS  LABEL  TOKENS  EQUIV API COST  TURNS  DURATION',
    );
    should(row(actual, 5)).equal(
      'ms8kkfyd  completed  claude-auto-loge  claude-opus-5  claude   cli2   512.0k  $4.500          21     1m35s',
    );
  });

  it('should dash every field the index does not know', () => {
    // Arrange
    const bare = rawSession({
      status: null,
      agent: null,
      model: null,
      harness: null,
      label: null,
      tokens: null,
      equivalentApiCostUsdMicros: null,
      turns: null,
      durationMs: null,
    });

    // Act
    const actual = renderAnalytics(rawResponse([bare]));

    // Assert
    should(row(actual, 5)).equal('ms8kkfyd  —       —      —      —        —      —       —               —      —');
  });

  it('should tell the reader when the row set was cut short', () => {
    // Act
    const actual = renderAnalytics(rawResponse([rawSession()], { truncated: true, limit: 1 }));

    // Assert
    should(actual).containEql('Showing 1 of 24 rows; add a filter.');
  });

  it('should stay quiet about truncation when nothing was cut', () => {
    // Act
    const actual = renderAnalytics(rawResponse([rawSession()]));

    // Assert
    should(actual).not.containEql('add a filter');
  });
});
