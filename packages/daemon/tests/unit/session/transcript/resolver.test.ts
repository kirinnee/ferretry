import { describe, it } from 'bun:test';
import type { TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import {
  CODEX_DISCOVERY_EAGER_MS,
  CodexDiscoveryPacer,
  type CodexRolloutCandidate,
  type CodexRolloutIndex,
  SessionTranscriptResolver,
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

  it('should not ask for the claims when no rollout outside the baseline carries the token', async () => {
    // Arrange — the claims are every other session's configuration; asking costs a read of each.
    let asked = 0;
    let skipped: ReadonlySet<string> | undefined;
    const subject = new SessionTranscriptResolver(
      {
        candidates: async (_home, _token, skip) => {
          skipped = skip;
          return [
            { id: 'rollout-old', file: '/old.jsonl', correlated: true },
            { id: 'rollout-other', file: '/other.jsonl', correlated: false },
          ];
        },
      },
      {
        claimed: async () => {
          asked += 1;
          return [];
        },
      },
      recorder(),
      clock,
    );

    // Act
    const file = await subject.file('session-1', undiscovered);

    // Assert — the only correlated rollout predates the session, so nothing could have been chosen.
    should(file).be.undefined();
    should(asked).equal(0);
    should([...(skipped ?? [])]).deepEqual(['rollout-old']);
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

  describe('with a discovery pacer', () => {
    /** A clock the test moves by hand, shared by the resolver and its pacer. */
    const manualClock = () => {
      let now = Date.parse(NOW);
      return {
        now: () => new Date(now).toISOString(),
        advance: (ms: number) => {
          now += ms;
        },
      };
    };

    it('should resolve a rollout that is there on the first read, and persist it once', async () => {
      // Arrange: the session that IS found quickly keeps today's behaviour.
      const time = manualClock();
      const store = recorder();
      const subject = new SessionTranscriptResolver(
        index([{ id: 'rollout-new', file: '/home/agent/.codex/sessions/new.jsonl', correlated: true }]),
        noClaims,
        store,
        time,
        new CodexDiscoveryPacer(time),
      );

      // Act
      const file = await subject.file('session-1', undiscovered);

      // Assert
      should(file).equal('/home/agent/.codex/sessions/new.jsonl');
      should(store.written).have.length(1);
    });

    it('should answer a record with no token without looking, paced or not', async () => {
      // Arrange
      const time = manualClock();
      const subject = new SessionTranscriptResolver(
        {
          candidates: async () => {
            throw new Error('nothing can be proven without a token, so nothing should be walked');
          },
        },
        noClaims,
        recorder(),
        time,
        new CodexDiscoveryPacer(time),
      );

      // Act
      const file = await subject.file('session-1', { v: 1, home: '/home/agent/.codex', identity: 'undiscovered' });

      // Assert
      should(file).be.undefined();
    });

    it('should stop walking the home on every read once a session has looked for two minutes', async () => {
      // Arrange: a Codex start that never wrote a rollout, read by the turn watcher every two seconds.
      const time = manualClock();
      let walks = 0;
      let changes = 0;
      const subject = new SessionTranscriptResolver(
        {
          candidates: async () => {
            walks += 1;
            return [];
          },
          changes: () => changes,
        },
        noClaims,
        recorder(),
        time,
        new CodexDiscoveryPacer(time),
      );
      await subject.file('session-1', undiscovered);
      time.advance(CODEX_DISCOVERY_EAGER_MS);
      walks = 0;

      // Act: a minute of reads, then a new rollout appears in the home.
      for (let read = 0; read < 30; read += 1) {
        time.advance(2_000);
        await subject.file('session-1', undiscovered);
      }
      const pacedWalks = walks;
      changes += 1;
      time.advance(2_000);
      await subject.file('session-1', undiscovered);

      // Assert: thirty reads, two walks; the change is looked at on the very next read.
      should(pacedWalks).equal(2);
      should(walks).equal(3);
    });

    it('should hand the pacer what the index has heard of the home, and walk only on an event', async () => {
      // Arrange: an index whose home is watched, read by the turn watcher every two seconds.
      const time = manualClock();
      let walks = 0;
      let heard = 0;
      const homes: string[] = [];
      const subject = new SessionTranscriptResolver(
        {
          candidates: async () => {
            walks += 1;
            return [];
          },
          heard: home => {
            homes.push(home);
            return heard;
          },
        },
        noClaims,
        recorder(),
        time,
        new CodexDiscoveryPacer(time),
      );

      // Act: a quiet minute, then an event.
      for (let read = 0; read < 30; read += 1) {
        await subject.file('session-1', undiscovered);
        time.advance(2_000);
      }
      const quietWalks = walks;
      heard += 1;
      await subject.file('session-1', undiscovered);

      // Assert
      should(quietWalks).equal(1);
      should(walks).equal(2);
      should(new Set(homes)).eql(new Set([undiscovered.home]));
    });
  });
});
