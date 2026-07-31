import { describe, it } from 'bun:test';
import should from 'should';
import { normalizeAnalyticsModelIdentity } from '../../../src/lib/analytics/model-identity.ts';

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
    const actual = normalizeAnalyticsModelIdentity('SHARED', aliases);

    // Assert
    should(actual?.modelId).equal('shared');
  });

  it('should return null when no model evidence exists', () => {
    // Act
    const missing = normalizeAnalyticsModelIdentity(null);
    const blank = normalizeAnalyticsModelIdentity('   ');

    // Assert
    should(missing).be.null();
    should(blank).be.null();
  });
});
