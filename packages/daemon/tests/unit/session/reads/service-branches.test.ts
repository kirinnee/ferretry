import { describe, it } from 'bun:test';
import should from 'should';
import { OperatorReadError, OperatorReadService } from '../../../../src/lib/session/reads/index.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

const INSTANT = '2026-02-01T09:08:07.000Z';

const READY: TranscriptEvent = {
  kind: 'message',
  harness: 'claude',
  role: 'assistant',
  text: 'ready',
  timestamp: INSTANT,
} as TranscriptEvent;

const service = (): OperatorReadService =>
  new OperatorReadService(
    { replay: async () => [] },
    { capture: async () => undefined },
    { tail: async () => ({ kind: 'read', events: [READY] }) },
    { read: async () => ({ kind: 'unreadable' }) },
    {
      tag: async () => new Uint8Array(32),
      matches: async () => false,
    },
    { read: async () => ({ kind: 'absent' }) },
  );

describe('OperatorReadService.logs turn validation', () => {
  it('should refuse a turn that is not a non-negative integer', async () => {
    // Arrange
    const reads = service();

    // Act
    const refusals = await Promise.all(
      [-1, 1.5, Number.NaN].map(async turn => await reads.logs('s1', undefined, turn).catch((error: unknown) => error)),
    );

    // Assert
    for (const refusal of refusals)
      should(refusal)
        .be.instanceof(OperatorReadError)
        .and.have.properties({ failure: 'invalid_query', message: 'turn must be a non-negative integer' });
  });
});
