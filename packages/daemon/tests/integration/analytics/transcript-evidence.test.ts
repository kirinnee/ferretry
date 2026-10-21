import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { readAnalyticsTranscriptEvidence } from '../../../src/adapters/analytics/index.ts';
import { NodeTranscriptSource } from '../../../src/adapters/transcript/file-source.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import type { TranscriptSource } from '../../../src/lib/transcript/types.ts';

const FIXTURE = join(import.meta.dir, '../../fixtures/transcript/claude.jsonl');

describe('readAnalyticsTranscriptEvidence', () => {
  it('should read a transcript whole, with the issues it raised and the bytes it left pending', async () => {
    // Act
    const evidence = await readAnalyticsTranscriptEvidence(
      new NodeTranscriptSource(new ClaudeTranscriptParser()),
      FIXTURE,
      'evidence-session',
      'claude',
    );

    // Assert
    should(evidence.kind).equal('read');
    if (evidence.kind !== 'read') return;
    should(evidence.events.length).be.above(0);
    should(evidence.pendingBytes).equal(0);
  });

  it('should call a read that raised unreadable, never empty', async () => {
    // Arrange
    const raising = { read: async () => Promise.reject(new Error('EIO')) } as unknown as TranscriptSource;

    // Act / Assert
    should(await readAnalyticsTranscriptEvidence(raising, FIXTURE, 'evidence-session', 'claude')).deepEqual({
      kind: 'unreadable',
    });
  });

  it('should leave a file it cannot stat to the read, which reports it missing', async () => {
    // Act
    const evidence = await readAnalyticsTranscriptEvidence(
      new NodeTranscriptSource(new ClaudeTranscriptParser()),
      join(import.meta.dir, 'no-such-transcript.jsonl'),
      'evidence-session',
      'claude',
    );

    // Assert — not refused as oversized: absence is the read's to state.
    should(evidence.kind).equal('read');
    if (evidence.kind !== 'read') return;
    should(evidence.events).deepEqual([]);
    should(evidence.issues.length).be.above(0);
  });
});
