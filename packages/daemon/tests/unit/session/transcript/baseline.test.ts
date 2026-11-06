import { describe, it } from 'bun:test';
import type { TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import { withoutResolvedTranscriptBaseline } from '../../../../src/lib/session/transcript/baseline.ts';

const pending: TranscriptProvenance = {
  v: 1,
  home: '/h',
  identity: 'undiscovered',
  baseline: ['old'],
  correlationToken: '/session',
};

describe('withoutResolvedTranscriptBaseline', () => {
  it('should keep all evidence until correlation is complete and stamped', () => {
    // Arrange
    const inputs: TranscriptProvenance[] = [
      pending,
      { ...pending, identity: 'correlated', harnessSessionId: 'mine', file: '/f' },
      { ...pending, identity: 'adopted', harnessSessionId: 'mine', file: '/f', resolvedAt: '2026-08-01T00:00:00Z' },
    ];
    // Act / Assert
    for (const input of inputs) should(withoutResolvedTranscriptBaseline(input)).equal(input);
  });

  it('should remove only the resolved baseline without mutating its input, and be idempotent', () => {
    // Arrange
    const input: TranscriptProvenance = Object.freeze({
      ...pending,
      identity: 'correlated',
      harnessSessionId: 'mine',
      file: '/f',
      resolvedAt: '2026-08-01T00:00:00Z',
    });
    const { baseline: _baseline, ...expected } = input;
    // Act
    const actual = withoutResolvedTranscriptBaseline(input);
    // Assert
    should(actual).eql(expected);
    should(input.baseline).eql(['old']);
    should(withoutResolvedTranscriptBaseline(actual)).equal(actual);
    should(withoutResolvedTranscriptBaseline({ ...input, baseline: [] })).eql(expected);
  });
});
