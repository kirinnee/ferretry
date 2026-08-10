import { describe, it } from 'bun:test';
import should from 'should';
import { normalizeAnalyticsModelIdentity } from '../../src/lib/analytics-model-identity.ts';

describe('normalizeAnalyticsModelIdentity', () => {
  it('should keep selector variants and provider revisions separate from identity', () => {
    // Arrange
    const raw = ' Claude-Haiku-4-5-20251001 [1m] ';

    // Act
    const actual = normalizeAnalyticsModelIdentity(raw);

    // Assert
    should(actual).deepEqual({
      raw,
      modelId: 'claude-haiku-4-5',
      variant: '1m',
      contextWindow: 1_000_000,
      revision: '20251001',
    });
  });

  it('should read a dated revision suffix in either spelling', () => {
    // Act
    const dashed = normalizeAnalyticsModelIdentity('model-a-2026-07-01');
    const at = normalizeAnalyticsModelIdentity('model-a@20260701');
    const fractional = normalizeAnalyticsModelIdentity('model-a[0.2m]');

    // Assert
    should(dashed?.revision).equal('2026-07-01');
    should(at?.revision).equal('20260701');
    should(fractional?.contextWindow).equal(200_000);
  });

  it('should retain unusable selector variants without emitting an invalid context-window count', () => {
    // Act
    const fractionalToken = normalizeAnalyticsModelIdentity('model-a[0.0000001m]');
    const overflowing = normalizeAnalyticsModelIdentity('model-a[999999999999999999999999m]');

    // Assert
    should(fractionalToken?.variant).equal('0.0000001m');
    should(fractionalToken?.contextWindow).be.null();
    should(overflowing?.variant).equal('999999999999999999999999m');
    should(overflowing?.contextWindow).be.null();
  });

  it('should normalize case and configured aliases to one stable identity', () => {
    // Arrange
    const aliases = [{ modelId: 'claude-opus-5', aliases: ['Claude-Opus-4-8'] }];

    // Act
    const selected = normalizeAnalyticsModelIdentity('CLAUDE-OPUS-5', aliases);
    const transcript = normalizeAnalyticsModelIdentity('claude-opus-4-8-20260701', aliases);

    // Assert
    should(selected?.modelId).equal('claude-opus-5');
    should(transcript?.modelId).equal('claude-opus-5');
    should(transcript?.revision).equal('20260701');
  });

  it('should preserve an unknown normalized spelling when aliases are ambiguous', () => {
    // Arrange
    const aliases = [
      { modelId: 'model-a', aliases: ['shared'] },
      { modelId: 'model-b', aliases: ['shared'] },
    ];

    // Act
    const ambiguous = normalizeAnalyticsModelIdentity('SHARED', aliases);
    const unmatched = normalizeAnalyticsModelIdentity('model-c', aliases);

    // Assert
    should(ambiguous?.modelId).equal('shared');
    should(unmatched?.modelId).equal('model-c');
  });

  it('should return null when no model evidence exists', () => {
    // Act
    const missing = normalizeAnalyticsModelIdentity(null);
    const undefined_ = normalizeAnalyticsModelIdentity(undefined);
    const blank = normalizeAnalyticsModelIdentity('   ');

    // Assert
    should(missing).be.null();
    should(undefined_).be.null();
    should(blank).be.null();
  });
});
