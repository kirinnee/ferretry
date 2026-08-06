import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import { AnalyticsResponseSchema, type AnalyticsAggregateResult, type AnalyticsResponse } from '@ferretry/protocol';
import should from 'should';
import type { AnalyticsPricingRate } from '../../../../src/lib/analytics/pricing.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { analyticsRoutes } from '../../../../src/lib/runtime/mounts/analytics.ts';
import type { FinishedAnalyticsSession } from '../../../../src/lib/analytics/session-record.ts';
import { jsonBody, request } from '../../api/support.ts';
import { analyticsSubsystem, CREDENTIALS, finishedSession, human } from './support.ts';

/**
 * The analytics mount, driven through the real router.
 *
 * Only the finished-session source is the test's. The query parser, the model-identity normaliser,
 * the pricing snapshot and the aggregator are all production code, so an answer asserted here is the
 * answer the daemon gives.
 */

function dispatcher(
  sessions: readonly FinishedAnalyticsSession[] = [],
  pricing: readonly AnalyticsPricingRate[] = [],
): ApiDispatcher {
  return new ApiDispatcher(
    new ApiRouter(analyticsRoutes(analyticsSubsystem(sessions, pricing))),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
}

/** One analytics answer, validated against the wire schema before a case looks at it: an answer the
 *  protocol would reject is a failure however plausible its numbers look. */
async function answer(
  sessions: readonly FinishedAnalyticsSession[],
  query?: string,
  pricing: readonly AnalyticsPricingRate[] = [],
): Promise<AnalyticsResponse> {
  const response = await dispatcher(sessions, pricing).dispatch(
    request({ path: '/v1/analytics', headers: human, query: query === undefined ? [] : [['q', query]] }),
  );
  should(response.status).equal(200);
  return AnalyticsResponseSchema.parse(jsonBody(response));
}

/** The rate table the pricing cases run against: one anthropic model, whole USD micros per million. */
const RATES: readonly AnalyticsPricingRate[] = [
  {
    pricingKey: 'anthropic:claude-opus-5',
    modelId: 'claude-opus-5',
    aliases: ['opus-5'],
    provider: 'anthropic',
    ratesUsdMicrosPerMillion: {
      input: 15_000_000,
      cachedRead: 1_500_000,
      cacheWrite5m: 18_750_000,
      cacheWrite1h: 30_000_000,
      output: 75_000_000,
    },
    verifiedAt: '2026-01-01T00:00:00.000Z',
    validFrom: '2026-01-01T00:00:00.000Z',
  },
];

const priced = (aggregate: AnalyticsResponse): readonly AnalyticsAggregateResult[] =>
  aggregate.kind === 'aggregate' ? aggregate.results : [];

describe('the analytics mount', () => {
  describe('the default read', () => {
    it('should answer the default day aggregation when no query is given', async () => {
      // The CLI sends no `q` for a bare `fy analytics`, so the daemon must pick the documented
      // default rather than refuse or return everything raw.
      // Arrange / Act
      const response = await answer([
        finishedSession({ id: 's1', createdAt: '2026-07-30T09:00:00.000Z' }),
        finishedSession({ id: 's2', createdAt: '2026-07-31T09:00:00.000Z' }),
      ]);

      // Assert
      should(response.query).equal('sum by (day)');
      should(response.kind).equal('aggregate');
      should(priced(response).map(row => [row.labels.day, row.sessions])).deepEqual([
        ['2026-07-30', 1],
        ['2026-07-31', 1],
      ]);
    });

    it('should report an empty fleet as zero indexed rather than as a failure', async () => {
      // Arrange / Act
      const response = await answer([]);

      // Assert
      should(response.index.sessions).equal(0);
      should(response.scope).deepEqual({ allSessions: true, indexed: 0, matched: 0 });
      should(priced(response)).be.empty();
    });
  });

  describe('what the index reports about itself', () => {
    it('should pass the ingesting store account through rather than inventing one', async () => {
      // The route reports what the store says it holds. A session whose transcript fold was refused is
      // a PENDING source, not an indexed one, because the next ingestion pass re-attempts it.
      // Arrange / Act
      const response = await answer([finishedSession({ id: 's1' })]);

      // Assert
      should(response.index).deepEqual({
        schemaVersion: 2,
        sessions: 1,
        tokenSessions: 0,
        transcriptSources: 1,
        indexedTranscriptSources: 0,
        pendingTranscriptSources: 1,
        sourceErrors: 0,
        refreshing: false,
      });
    });

    it('should count only the sessions whose token totals are actually known', async () => {
      // Arrange
      const withTokens = finishedSession({
        id: 's1',
        usage: {
          pricingModel: 'claude-opus-5',
          inputTokens: 1_000,
          outputTokens: 500,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      });

      // Act
      const response = await answer([withTokens, finishedSession({ id: 's2' })]);

      // Assert
      should(response.index.sessions).equal(2);
      should(response.index.tokenSessions).equal(1);
    });
  });

  describe('the measurements it derives', () => {
    it('should measure a run from its own start and finish instants', async () => {
      // Arrange / Act
      const response = await answer(
        [
          finishedSession({
            id: 's1',
            startedAt: '2026-07-30T09:00:00.000Z',
            finishedAt: '2026-07-30T09:30:00.000Z',
            turns: 7,
          }),
        ],
        'sum by (id)',
      );

      // Assert
      should(priced(response).map(row => [row.labels.id, row.durationMs.value, row.turns.value])).deepEqual([
        ['s1', 30 * 60_000, 7],
      ]);
    });

    it('should report an unknown token count as unknown rather than as zero', async () => {
      // A zero would aggregate into a total that looks measured. `known: 0` says nobody measured it.
      // Arrange / Act
      const response = await answer([finishedSession({ id: 's1' })], 'sum by (id)');

      // Assert
      should(priced(response).map(row => row.tokens)).deepEqual([{ value: null, known: 0, total: 1 }]);
    });

    it('should label a session with no token evidence as unknown token data', async () => {
      // Arrange / Act
      const response = await answer([finishedSession({ id: 's1' })], 'sum by (token_data)');

      // Assert
      should(priced(response).map(row => row.labels.token_data)).deepEqual(['unknown']);
    });
  });

  describe('pricing', () => {
    it('should price a run against a catalog rate and report the cost in USD micros', async () => {
      // Arrange
      const session = finishedSession({
        id: 's1',
        createdAt: '2026-07-30T09:00:00.000Z',
        usage: {
          pricingModel: 'claude-opus-5',
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      });

      // Act
      const response = await answer([session], 'sum by (id)', RATES);

      // Assert — a million uncached input plus a million output, at the catalog's own rates.
      should(priced(response).map(row => row.equivalentApiCostUsdMicros.value)).deepEqual([90_000_000]);
      should(priced(response).map(row => row.tokens.value)).deepEqual([2_000_000]);
    });

    it('should leave a cost unknown when no catalog is mounted rather than reporting it as free', async () => {
      // This is the daemon's real configuration today: no rate source is mounted, so an honest
      // "nobody knows" must never collapse into a zero a caller would read as free.
      // Arrange
      const session = finishedSession({
        id: 's1',
        usage: {
          pricingModel: 'claude-opus-5',
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
      });

      // Act
      const response = await answer([session], 'sum by (id)', []);

      // Assert
      should(priced(response).map(row => row.equivalentApiCostUsdMicros)).deepEqual([
        { value: null, known: 0, total: 1 },
      ]);
    });
  });

  describe('filtering and raw reads', () => {
    it('should filter to the sessions a matcher names', async () => {
      // Arrange / Act
      const response = await answer(
        [
          finishedSession({ id: 's1', status: 'completed', completed: true }),
          finishedSession({ id: 's2', status: 'failed', completed: false, failed: true }),
        ],
        'sum by (id) {status=failed}',
      );

      // Assert
      should(response.scope).deepEqual({ allSessions: true, indexed: 2, matched: 1 });
      should(priced(response).map(row => row.labels.id)).deepEqual(['s2']);
    });

    it('should answer a query with no aggregation with the raw rows, newest first', async () => {
      // Arrange / Act
      const response = await answer(
        [
          finishedSession({ id: 'older', createdAt: '2026-07-29T09:00:00.000Z' }),
          finishedSession({ id: 'newer', createdAt: '2026-07-31T09:00:00.000Z' }),
        ],
        '{harness=claude}',
      );

      // Assert
      should(response.kind).equal('raw');
      should(response.kind === 'raw' ? response.results.map(row => row.id) : []).deepEqual(['newer', 'older']);
      should(response.kind === 'raw' ? response.truncated : true).be.false();
    });
  });

  describe('server-enforced session scope', () => {
    const sessions = [
      finishedSession({ id: 'mine', status: 'completed', completed: true }),
      finishedSession({ id: 'theirs', status: 'completed', completed: true }),
    ];

    async function sessionAnswer(session: string, query?: string): Promise<AnalyticsResponse> {
      const response = await dispatcher(sessions).dispatch(
        request({
          path: '/v1/analytics',
          headers: human,
          query: [...(query === undefined ? [] : ([['q', query]] as const)), ['session', session]],
        }),
      );
      should(response.status).equal(200);
      return AnalyticsResponseSchema.parse(jsonBody(response));
    }

    it('should narrow a blank side-pane read to exactly its session', async () => {
      const response = await sessionAnswer('mine');

      should(response.query).equal('sum by (model) {id=mine}');
      should(response.scope).deepEqual({ allSessions: true, indexed: 2, matched: 1 });
    });

    it('should replace a visible id aimed at another session', async () => {
      const response = await sessionAnswer('mine', 'sum by (id) {id=theirs}');

      should(response.query).equal('sum by (id) {id=mine}');
      should(priced(response).map(row => row.labels.id)).deepEqual(['mine']);
    });

    it('should keep other caller filters while forcing the exact session', async () => {
      const response = await sessionAnswer('mine', 'sum by (id) {status=failed}');

      should(response.query).equal('sum by (id) {status=failed, id=mine}');
      should(priced(response)).be.empty();
    });
  });

  describe('refusals', () => {
    it('should refuse an empty or repeated session scope', async () => {
      const empty = await dispatcher().dispatch(
        request({ path: '/v1/analytics', headers: human, query: [['session', ' ']] }),
      );
      const repeated = await dispatcher().dispatch(
        request({
          path: '/v1/analytics',
          headers: human,
          query: [
            ['session', 'mine'],
            ['session', 'theirs'],
          ],
        }),
      );

      should(empty.status).equal(400);
      should(jsonBody(empty)).have.property('code', 'invalid_query');
      should(repeated.status).equal(400);
      should(jsonBody(repeated)).have.property('code', 'repeated_parameter');
    });

    it('should refuse a query the parser cannot read, as the caller‘s mistake', async () => {
      // Arrange / Act
      const response = await dispatcher().dispatch(
        request({ path: '/v1/analytics', headers: human, query: [['q', 'sum by (nonsense)']] }),
      );

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'invalid_query');
    });

    it('should refuse a parameter it does not implement rather than answer the whole fleet', async () => {
      // Silently ignoring `?since=` would answer a narrowed question with every session, which reads
      // as "nothing was filtered out" rather than as "this daemon cannot filter that way".
      // Arrange / Act
      const response = await dispatcher().dispatch(
        request({ path: '/v1/analytics', headers: human, query: [['since', '2026-07-01']] }),
      );

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'unknown_parameter');
    });

    it('should report a store it could not read as its own fault, not the caller‘s', async () => {
      // A caller told its query was malformed will rewrite a query that was right all along, so a
      // failed read must never borrow the 400 the query parser owns.
      // Arrange
      const broken = new ApiDispatcher(
        new ApiRouter(
          analyticsRoutes({
            index: () => {
              throw new Error('the analytics index is unreadable');
            },
          }),
        ),
        CREDENTIALS,
        NO_GOVERNED_ROUTES_GUARD,
      );

      // Act
      const response = await broken.dispatch(request({ path: '/v1/analytics', headers: human }));

      // Assert
      should(response.status).equal(500);
    });

    it('should refuse a caller without the admin token', async () => {
      // The answer carries every session's working directory and parentage, which is more than a
      // warden-scoped caller is trusted with.
      // Arrange / Act
      const response = await dispatcher().dispatch(
        request({
          path: '/v1/analytics',
          headers: { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' },
        }),
      );

      // Assert
      should(response.status).equal(403);
    });
  });
});
