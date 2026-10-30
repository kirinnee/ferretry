import { describe, it } from 'bun:test';
import should from 'should';
import { observedRuntimeStatePatch, projectObservedContext } from '../../../../src/lib/session/harness/observation.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

/** The context size a transcript last stated, and how it reaches the session document. */

const T1 = '2026-10-30T08:00:00.000Z';
const T2 = '2026-10-30T08:05:00.000Z';
const T3 = '2026-10-30T08:09:00.000Z';

const usage = (timestamp: string | undefined, contextTokens?: number, contextWindow?: number): TranscriptEvent =>
  ({
    kind: 'usage',
    harness: 'claude',
    role: 'assistant',
    ...(timestamp === undefined ? {} : { timestamp }),
    usage: {
      model: 'm',
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    },
  }) as TranscriptEvent;

const compaction = (timestamp: string, tokensAfter?: number): TranscriptEvent =>
  ({
    kind: 'compaction',
    harness: 'claude',
    role: 'system',
    timestamp,
    ...(tokensAfter === undefined ? {} : { tokensAfter }),
  }) as TranscriptEvent;

describe('projectObservedContext', () => {
  it('should answer the newest usage record that states a size', () => {
    // Arrange
    const events = [usage(T1, 40_000), usage(T2, 118_000), usage(T3)];

    // Act
    const actual = projectObservedContext(events);

    // Assert
    should(actual).deepEqual({ tokens: 118_000, at: T2 });
  });

  it('should carry a window the harness named, and keep it when a later record omits it', () => {
    // Arrange
    const events = [usage(T1, 10_000, 272_000), usage(T2, 20_000)];

    // Act
    const actual = projectObservedContext(events);

    // Assert
    should(actual).deepEqual({ tokens: 20_000, at: T2, window: 272_000 });
  });

  it('should take the size a compaction left behind when it is newer than the last usage', () => {
    // Arrange
    const events = [usage(T1, 900_000), compaction(T2, 30_000)];

    // Act
    const actual = projectObservedContext(events);

    // Assert
    should(actual).deepEqual({ tokens: 30_000, at: T2 });
  });

  it('should let a usage record after a compaction win again', () => {
    // Arrange
    const events = [compaction(T1, 30_000), usage(T2, 35_000)];

    // Act / Assert
    should(projectObservedContext(events)).deepEqual({ tokens: 35_000, at: T2 });
  });

  it('should ignore a compaction that states no size and a record with no usable timestamp', () => {
    // Arrange
    const events = [usage(T1, 50_000), compaction(T2), usage(undefined, 99_000), usage('not a time', 99_000)];

    // Act / Assert
    should(projectObservedContext(events)).deepEqual({ tokens: 50_000, at: T1 });
  });

  it('should answer nothing when no record states a size', () => {
    // Arrange / Act / Assert
    should(projectObservedContext([])).be.undefined();
    should(projectObservedContext([usage(T1)])).be.undefined();
  });
});

describe('observedRuntimeStatePatch with a context', () => {
  it('should write the size, when and window beside the model', () => {
    // Arrange
    const observed = { model: 'm', at: T1, context: { tokens: 118_000, at: T2, window: 1_000_000 } };

    // Act
    const actual = observedRuntimeStatePatch({}, observed);

    // Assert
    should(actual).deepEqual({
      observedModel: 'm',
      observedModelAt: T1,
      contextTokens: 118_000,
      contextAt: T2,
      contextWindow: 1_000_000,
    });
  });

  it('should write nothing when the document already holds the same context', () => {
    // Arrange
    const current = { observedModel: 'm', observedModelAt: T1, contextTokens: 5, contextAt: T2, contextWindow: 9 };

    // Act
    const actual = observedRuntimeStatePatch(current, {
      model: 'm',
      at: T1,
      context: { tokens: 5, at: T2, window: 9 },
    });

    // Assert
    should(actual).deepEqual({});
  });

  it('should write a changed size and keep what the observation no longer says', () => {
    // Arrange
    const current = { observedModel: 'm', observedModelAt: T1, contextTokens: 5, contextAt: T1, contextWindow: 9 };

    // Act
    const actual = observedRuntimeStatePatch(current, { context: { tokens: 6, at: T2 } });

    // Assert
    should(actual).deepEqual({
      observedModel: 'm',
      observedModelAt: T1,
      contextTokens: 6,
      contextAt: T2,
      contextWindow: 9,
    });
  });

  it('should never clear a stored context when the observation holds none', () => {
    // Arrange
    const current = { observedModel: 'm', observedModelAt: T1, contextTokens: 5, contextAt: T1 };

    // Act
    const actual = observedRuntimeStatePatch(current, {});

    // Assert
    should(actual).deepEqual({});
  });
});
