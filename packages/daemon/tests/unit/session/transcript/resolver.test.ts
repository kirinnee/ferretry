import { describe, it } from 'bun:test';
import should from 'should';
import type { TranscriptProvenance } from '@ferretry/protocol';
import {
  SessionTranscriptResolver,
  type CodexRolloutCandidate,
  type CodexRolloutIndex,
  type TranscriptClaims,
  type TranscriptProvenanceStore,
} from '../../../../src/lib/session/transcript/index.ts';

const NOW = '2026-08-01T10:00:00.000Z';

const clock = { now: () => NOW };

const noClaims: TranscriptClaims = { claimed: async () => [] };

const index = (candidates: readonly CodexRolloutCandidate[]): CodexRolloutIndex => ({
  candidates: async () => candidates,
});

const recorder = (): TranscriptProvenanceStore & { readonly written: TranscriptProvenance[] } => {
  const written: TranscriptProvenance[] = [];
  return {
    written,
    record: async (_sessionId, provenance) => {
      written.push(provenance);
    },
  };
};

const undiscovered: TranscriptProvenance = {
  v: 1,
  home: '/home/agent/.codex',
  identity: 'undiscovered',
  baseline: ['rollout-old'],
  correlationToken: '/state/sessions/session-1',
};

describe('SessionTranscriptResolver', () => {
  it('should answer a minted record from the file it already names', async () => {
    // Arrange: no discovery may run for a transcript whose name was decided at launch.
    const store = recorder();
    const subject = new SessionTranscriptResolver(
      {
        candidates: async () => {
          throw new Error('a minted record must not be discovered');
        },
      },
      noClaims,
      store,
      clock,
    );

    // Act
    const file = await subject.file('session-1', {
      v: 1,
      home: '/home/agent/.claude',
      harnessSessionId: 'minted',
      identity: 'minted',
      file: '/home/agent/.claude/projects/-work-repo/minted.jsonl',
      resolvedAt: NOW,
    });

    // Assert
    should(file).equal('/home/agent/.claude/projects/-work-repo/minted.jsonl');
    should(store.written).be.empty();
  });

  it('should discover a correlated codex rollout and persist the completed record', async () => {
    // Arrange
    const store = recorder();
    const subject = new SessionTranscriptResolver(
      index([
        { id: 'rollout-old', file: '/home/agent/.codex/sessions/old.jsonl', correlated: true },
        { id: 'rollout-new', file: '/home/agent/.codex/sessions/new.jsonl', correlated: true },
      ]),
      noClaims,
      store,
      clock,
    );

    // Act
    const file = await subject.file('session-1', undiscovered);

    // Assert: the baselined rollout is excluded, so exactly one candidate is left.
    should(file).equal('/home/agent/.codex/sessions/new.jsonl');
    should(store.written).eql([
      {
        ...undiscovered,
        harnessSessionId: 'rollout-new',
        identity: 'correlated',
        file: '/home/agent/.codex/sessions/new.jsonl',
        resolvedAt: NOW,
      },
    ]);
  });

  it('should exclude rollouts already attributed to other sessions', async () => {
    // Arrange
    const store = recorder();
    const subject = new SessionTranscriptResolver(
      index([{ id: 'rollout-new', file: '/home/agent/.codex/sessions/new.jsonl', correlated: true }]),
      { claimed: async except => (except === 'session-1' ? ['rollout-new'] : []) },
      store,
      clock,
    );

    // Act
    const file = await subject.file('session-1', undiscovered);

    // Assert
    should(file).be.undefined();
    should(store.written).be.empty();
  });

  it('should answer nothing, and write nothing, while no rollout carries the token', async () => {
    // Arrange: codex has not flushed the injected path yet — a later read resolves it.
    const store = recorder();
    const subject = new SessionTranscriptResolver(
      index([{ id: 'rollout-new', file: '/home/agent/.codex/sessions/new.jsonl', correlated: false }]),
      noClaims,
      store,
      clock,
    );

    // Act
    const file = await subject.file('session-1', undiscovered);

    // Assert
    should(file).be.undefined();
    should(store.written).be.empty();
  });

  it('should not walk the harness home for a record with no correlation token', async () => {
    // Arrange: an interactive codex session was handed no opening turn, so nothing was injected.
    const subject = new SessionTranscriptResolver(
      {
        candidates: async () => {
          throw new Error('nothing can be proven without a token, so nothing should be walked');
        },
      },
      noClaims,
      recorder(),
      clock,
    );

    // Act
    const file = await subject.file('session-1', { v: 1, home: '/home/agent/.codex', identity: 'undiscovered' });

    // Assert
    should(file).be.undefined();
  });

  it('should answer nothing for a session that records no provenance at all', async () => {
    // Arrange
    const subject = new SessionTranscriptResolver(index([]), noClaims, recorder(), clock);

    // Act
    const file = await subject.file('session-1', undefined);

    // Assert
    should(file).be.undefined();
  });
});
