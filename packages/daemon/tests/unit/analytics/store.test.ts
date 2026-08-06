import { describe, it } from 'bun:test';
import should from 'should';
import type { AnalyticsPricingRate } from '../../../src/lib/analytics/pricing.ts';
import {
  ANALYTICS_INDEX_SCHEMA_VERSION,
  analyticsIngestSignature,
  analyticsPricingCatalogFingerprint,
  decideAnalyticsIndexSchema,
  type AnalyticsIndexShape,
  type AnalyticsSignedEvidence,
} from '../../../src/lib/analytics/store.ts';

/**
 * The store's own decisions: whether an index found on disk may be served, and what makes a session's
 * evidence stale.
 *
 * Both are the reason the store can be trusted at all. The first is what stops one daemon's spend being
 * reported as another's; the second is what lets a pass skip a transcript it has already proved without
 * skipping one that has changed.
 */

const HOME = '/home/someone/.ferretry';

const shape = (overrides: Partial<AnalyticsIndexShape> = {}): AnalyticsIndexShape => ({
  foundVersion: ANALYTICS_INDEX_SCHEMA_VERSION,
  hasTables: true,
  hasExpectedShape: true,
  storedHome: HOME,
  ...overrides,
});

const RATE: AnalyticsPricingRate = {
  pricingKey: 'operator:claude-opus-5:2026-08',
  modelId: 'claude-opus-5',
  aliases: ['opus-5'],
  provider: 'anthropic',
  currency: 'USD',
  rates: {
    input: 15_000_000,
    output: 75_000_000,
    cachedInput: 1_500_000,
    cacheWrite: null,
    cacheWrite5m: 18_750_000,
    cacheWrite1h: 30_000_000,
    reasoning: null,
    image: null,
    tool: null,
  },
  source: { kind: 'manual' },
  verifiedAt: '2026-08-01T00:00:00.000Z',
  validFrom: '2026-08-01T00:00:00.000Z',
  validThrough: null,
  lastSyncedAt: null,
};

const SECOND_RATE: AnalyticsPricingRate = {
  ...RATE,
  pricingKey: 'operator:gpt:2026-08',
  modelId: 'gpt-5',
  aliases: [],
};

const EVIDENCE: AnalyticsSignedEvidence = {
  id: 's1',
  createdAt: '2026-08-01T00:00:00.000Z',
  finishedAt: '2026-08-01T01:00:00.000Z',
  status: 'completed',
  agent: 'claude',
  selectedModel: 'claude-opus-5[1m]',
  contextWindow: 1_000_000,
  harness: 'claude',
  mode: 'auto',
  label: 'batch',
  cwd: '/work',
  parent: null,
  startedAt: '2026-08-01T00:00:01.000Z',
  turns: 4,
  contextEndPercent: 30,
  migrated: false,
};

describe('decideAnalyticsIndexSchema', () => {
  it('should create when the file holds no tables at all', () => {
    // Arrange / Act / Assert
    should(decideAnalyticsIndexSchema(shape({ hasTables: false, storedHome: null }), HOME)).equal('create');
  });

  it('should use an index of this version, this shape and this home', () => {
    // Arrange / Act / Assert
    should(decideAnalyticsIndexSchema(shape(), HOME)).equal('use');
  });

  it('should discard an index written by another derivation', () => {
    // A row priced by rules this daemon no longer applies is not a stale number, it is an unstateable
    // one — so the whole table goes rather than being read as far as it parses.
    // Arrange / Act / Assert
    should(decideAnalyticsIndexSchema(shape({ foundVersion: ANALYTICS_INDEX_SCHEMA_VERSION - 1 }), HOME)).equal(
      'drop-and-rebuild',
    );
    should(decideAnalyticsIndexSchema(shape({ hasExpectedShape: false }), HOME)).equal('drop-and-rebuild');
  });

  it('should discard an index that names another state home, or names none', () => {
    // ONE DAEMON'S ANALYTICS MUST NEVER BE READ AS ANOTHER'S. A copied or restored file opens perfectly
    // well, and every row in it would be reported as this daemon's fleet.
    // Arrange / Act / Assert
    should(decideAnalyticsIndexSchema(shape({ storedHome: '/home/someone-else/.ferretry' }), HOME)).equal(
      'drop-and-rebuild',
    );
    should(decideAnalyticsIndexSchema(shape({ storedHome: null }), HOME)).equal('drop-and-rebuild');
  });
});

describe('analyticsPricingCatalogFingerprint', () => {
  it('should not depend on the order the operator listed the rates in', () => {
    // A reordered catalog is the same catalog; making it look different would re-ingest the whole fleet.
    // Arrange / Act / Assert
    should(analyticsPricingCatalogFingerprint([RATE, SECOND_RATE])).equal(
      analyticsPricingCatalogFingerprint([SECOND_RATE, RATE]),
    );
  });

  it('should change when a rate, a validity window or an alias changes', () => {
    // Arrange
    const base = analyticsPricingCatalogFingerprint([RATE]);

    // Act / Assert
    should(analyticsPricingCatalogFingerprint([{ ...RATE, rates: { ...RATE.rates, output: 1 } }])).not.equal(base);
    should(analyticsPricingCatalogFingerprint([{ ...RATE, validThrough: '2026-09-01T00:00:00.000Z' }])).not.equal(base);
    should(analyticsPricingCatalogFingerprint([{ ...RATE, aliases: ['opus-5', 'opus'] }])).not.equal(base);
    should(analyticsPricingCatalogFingerprint([])).not.equal(base);
  });
});

describe('analyticsIngestSignature', () => {
  it('should be stable for the same evidence and catalog', () => {
    // Arrange
    const fingerprint = analyticsPricingCatalogFingerprint([RATE]);

    // Act / Assert
    should(analyticsIngestSignature(EVIDENCE, fingerprint)).equal(analyticsIngestSignature(EVIDENCE, fingerprint));
  });

  it('should change when the catalog changes, so a re-priced session is re-ingested', () => {
    // Arrange / Act / Assert
    should(analyticsIngestSignature(EVIDENCE, analyticsPricingCatalogFingerprint([RATE]))).not.equal(
      analyticsIngestSignature(EVIDENCE, analyticsPricingCatalogFingerprint([])),
    );
  });

  it('should change when any signed session fact changes', () => {
    // Every field here decides a stored column, so a change in one is a row that must be rewritten.
    // Arrange
    const fingerprint = analyticsPricingCatalogFingerprint([RATE]);
    const base = analyticsIngestSignature(EVIDENCE, fingerprint);
    const variants: readonly Partial<AnalyticsSignedEvidence>[] = [
      { id: 's2' },
      { createdAt: '2026-08-02T00:00:00.000Z' },
      { finishedAt: '2026-08-01T02:00:00.000Z' },
      { status: 'failed' },
      { agent: 'codex' },
      { selectedModel: 'claude-opus-5' },
      { contextWindow: 200_000 },
      { harness: 'codex' },
      { mode: 'interactive' },
      { label: 'other' },
      { cwd: '/elsewhere' },
      { parent: 's0' },
      { startedAt: '2026-08-01T00:00:02.000Z' },
      { turns: 5 },
      { contextEndPercent: 31 },
      { migrated: true },
    ];

    // Act / Assert
    for (const variant of variants) {
      should(analyticsIngestSignature({ ...EVIDENCE, ...variant }, fingerprint)).not.equal(base);
    }
  });

  it('should not confuse an absent field with an empty one, or a value with its neighbour', () => {
    // A signature that joined values on a space would read a cleared label and an empty one as the same
    // evidence, and would let a value slide from one field into the next without changing the hash. Both
    // would leave a stale row in place for a session whose facts had actually changed.
    // Arrange
    const fingerprint = analyticsPricingCatalogFingerprint([]);

    // Act / Assert
    should(analyticsIngestSignature({ ...EVIDENCE, label: null }, fingerprint)).not.equal(
      analyticsIngestSignature({ ...EVIDENCE, label: '' }, fingerprint),
    );
    should(analyticsIngestSignature({ ...EVIDENCE, label: 'a', cwd: 'b' }, fingerprint)).not.equal(
      analyticsIngestSignature({ ...EVIDENCE, label: 'ab', cwd: '' }, fingerprint),
    );
  });
});
