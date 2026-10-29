import { describe, it } from 'bun:test';
import should from 'should';
import type { Proposal } from '../../../src/lib/learning/index.ts';
import {
  applyMinerOutput,
  titleHash,
  type Observation,
  type SessionDigest,
  type Tombstone,
} from '../../../src/lib/learning/index.ts';

const at = '2026-07-30T12:00:00.000Z';
const digest = (overrides: Partial<SessionDigest> = {}): SessionDigest => ({
  sessionId: 'session-1',
  mode: 'interactive',
  cwd: '/repo-a',
  repo: '/repo-a',
  harness: 'claude',
  at,
  hasSignal: true,
  signalReasons: ['interactive session (human at the wheel)'],
  corpus: 'Please always run the project environment before tools.',
  digest: 'Please always run the project environment before tools.',
  humanMessages: 1,
  teammateSteers: 0,
  interrupts: 0,
  toolFailures: 0,
  ...overrides,
});

const proposal = (observationIds: string[]): Proposal => ({
  id: 'proposal-environment',
  category: 'global',
  state: 'pending',
  title: 'Use project environment',
  ruleText: 'Use the project environment.',
  target: { kind: 'global-agent-guidance', path: 'guidance.md', anchor: '## Agent rules' },
  observationIds,
  occurrences: 1,
  crossRepoCount: 1,
  firstSeen: at,
  lastSeen: at,
  identity: 'use-project-environment',
  history: [{ at, event: 'proposed:old', by: 'miner' }],
  source: 'scan',
  count: Math.max(1, observationIds.length),
});

const observation = (id: string): Observation => ({
  id,
  sessionId: 'prior-session',
  mode: 'auto',
  cwd: '/repo-b',
  repo: '/repo-b',
  at: '2026-07-29T12:00:00.000Z',
  kind: 'preference',
  gist: 'Use env',
  quote: 'Use it',
  source: 'human',
  verified: true,
  runId: 'old',
});

describe('learning aggregation', () => {
  it('should only turn verified quotes into observations and proposals', () => {
    // Act
    const actual = applyMinerOutput(
      [],
      [],
      {
        observations: [
          {
            key: 'verified',
            sessionId: 'session-1',
            kind: 'preference',
            gist: 'Use environment',
            quote: 'run the project environment',
          },
          { key: 'fabricated', sessionId: 'session-1', kind: 'preference', gist: 'Fake', quote: 'invented claim' },
          { key: 'unknown', sessionId: 'missing', kind: 'preference', gist: 'Unknown', quote: 'anything' },
        ],
        proposals: [
          {
            identity: 'use-project-environment',
            title: 'Use project environment',
            ruleText: 'Use the project environment.',
            observationKeys: ['verified', 'fabricated'],
          },
        ],
      },
      new Map([['session-1', digest()]]),
      new Map(),
      'run-1',
      at,
    );

    // Assert
    should(actual.observations).have.length(1);
    should(actual.proposals).have.length(1);
    should(actual.proposals[0]?.observationIds).deepEqual([actual.observations[0]?.id]);
    should(actual.stats).deepEqual({
      observationsProposed: 3,
      observationsVerified: 1,
      rejectedQuotes: 2,
      proposalsCreated: 1,
      proposalsStrengthened: 0,
      proposalsSuppressedByTombstone: 0,
    });
  });

  it('should normalize untrusted kinds and derive teammate evidence from a session without human messages', () => {
    // Act
    const actual = applyMinerOutput(
      [],
      [],
      {
        observations: [
          { key: 'one', sessionId: 'session-1', kind: 'unknown', gist: 'x'.repeat(500), quote: 'project environment' },
        ],
      },
      new Map([['session-1', digest({ mode: 'auto', humanMessages: 0 })]]),
      new Map(),
      'run-1',
      at,
    );

    // Assert
    should(actual.observations[0]).match({ kind: 'correction', source: 'teammate' });
    should(actual.observations[0]?.gist).have.length(400);
  });

  it('should aim a rule at the automation guidance only when the miner names it as the target', () => {
    // Arrange
    const observations = [
      {
        key: 'verified',
        sessionId: 'session-1',
        kind: 'preference',
        gist: 'Use environment',
        quote: 'run the project environment',
      },
    ];
    const proposalOf = (extra: object) => ({
      title: 'Use project environment',
      ruleText: 'Use the project environment.',
      observationKeys: ['verified'],
      ...extra,
    });

    // Act
    const run = (extra: object) =>
      applyMinerOutput(
        [],
        [],
        { observations, proposals: [proposalOf(extra)] },
        new Map([['session-1', digest()]]),
        new Map(),
        'run-1',
        at,
      ).proposals[0]?.target;

    // Assert
    should(run({ target: 'automation-guidance', anchor: '## Unattended runs' })).deepEqual({
      kind: 'automation-guidance',
      path: 'automation.md',
      anchor: '## Unattended runs',
    });
    should(run({ target: 'global-agent-guidance' })).deepEqual({
      kind: 'global-agent-guidance',
      path: 'guidance.md',
      anchor: '## Agent rules',
    });
  });

  it('should permanently suppress a proposal matching a tombstone by identity or title', () => {
    // Arrange
    const output = {
      observations: [
        {
          key: 'one',
          sessionId: 'session-1',
          kind: 'preference',
          gist: 'Use environment',
          quote: 'project environment',
        },
      ],
      proposals: [
        { identity: 'rejected-rule', title: 'New title', ruleText: 'Never write this.', observationKeys: ['one'] },
        {
          identity: 'new-identity',
          title: 'Rejected title',
          ruleText: 'Never write this either.',
          observationKeys: ['one'],
        },
      ],
    };
    const tombstones: Tombstone[] = [
      { identity: 'rejected-rule', titleHash: 'different', ruleGist: 'old', rejectedAt: at },
      {
        identity: 'other',
        titleHash: titleHash('Rejected title'),
        ruleGist: 'old',
        rejectedAt: at,
      },
    ];
    // Act
    const actual = applyMinerOutput([], tombstones, output, new Map([['session-1', digest()]]), new Map(), 'run-1', at);

    // Assert
    should(actual.proposals).deepEqual([]);
    should(actual.stats.proposalsSuppressedByTombstone).equal(2);
  });

  it('should strengthen a live proposal once, preserve old evidence, and leave input objects unchanged', () => {
    // Arrange
    const existing = proposal(['old-observation']);
    const known = new Map([['old-observation', observation('old-observation')]]);
    const output = {
      observations: [
        {
          key: 'new',
          sessionId: 'session-1',
          kind: 'preference',
          gist: 'Use environment',
          quote: 'project environment',
        },
      ],
      proposals: [
        {
          identity: 'use-project-environment',
          title: 'Use project environment',
          ruleText: 'replacement should be ignored',
          observationKeys: ['new', 'new'],
        },
      ],
    };

    // Act
    const actual = applyMinerOutput([existing], [], output, new Map([['session-1', digest()]]), known, 'run-1', at);

    // Assert
    should(actual.proposals).have.length(1);
    should(actual.proposals[0]?.observationIds).have.length(2);
    should(actual.proposals[0]).match({ occurrences: 2, crossRepoCount: 2, ruleText: 'Use the project environment.' });
    should(actual.proposals[0]?.history.at(-1)).match({ event: 'strengthened:run-1', by: 'miner' });
    should(existing.observationIds).deepEqual(['old-observation']);
    should(existing.history).have.length(1);
  });

  it('should ignore empty candidates and duplicate evidence instead of creating empty or duplicated rules', () => {
    // Act
    const actual = applyMinerOutput(
      [],
      [],
      {
        observations: [
          {
            key: 'one',
            sessionId: 'session-1',
            kind: 'preference',
            gist: 'Use environment',
            quote: 'project environment',
          },
        ],
        proposals: [
          { title: 'No evidence', ruleText: 'No evidence', observationKeys: [] },
          { title: 'No text', ruleText: '   ', observationKeys: ['one'] },
          { title: 'Real rule', ruleText: 'Follow this.', observationKeys: ['one', 'one'] },
          { title: 'Real rule', ruleText: 'Follow this.', observationKeys: ['one'] },
        ],
      },
      new Map([['session-1', digest()]]),
      new Map(),
      'run-1',
      at,
    );

    // Assert
    should(actual.proposals).have.length(1);
    should(actual.proposals[0]?.observationIds).have.length(1);
    should(actual.stats).match({ proposalsCreated: 1, proposalsStrengthened: 0 });
  });

  describe('lesson scope', () => {
    const evidence = {
      observations: [
        {
          key: 'one',
          sessionId: 'session-1',
          kind: 'preference',
          gist: 'Use environment',
          quote: 'project environment',
        },
      ],
    };

    it('should file a repo lesson against the project its first quote came from', () => {
      // Act
      const actual = applyMinerOutput(
        [],
        [],
        {
          ...evidence,
          proposals: [
            {
              title: 'Use project environment',
              ruleText: 'Use the project environment.',
              scope: 'repo',
              observationKeys: ['one'],
            },
          ],
        },
        new Map([['session-1', digest()]]),
        new Map(),
        'run-1',
        at,
      );

      // Assert
      should(actual.proposals[0]).match({
        category: 'repo',
        target: { kind: 'repo-instructions', path: '/repo-a' },
        source: 'scan',
        project: '/repo-a',
        suggestedCategory: 'repo',
        count: 1,
      });
    });

    it('should file a global lesson at the global instructions and keep the type the miner picked', () => {
      // Act
      const actual = applyMinerOutput(
        [],
        [],
        {
          ...evidence,
          proposals: [
            {
              title: 'Use project environment',
              ruleText: 'Use the project environment.',
              scope: 'global',
              observationKeys: ['one'],
            },
          ],
        },
        new Map([['session-1', digest()]]),
        new Map(),
        'run-1',
        at,
      );

      // Assert
      should(actual.proposals[0]).match({
        category: 'global',
        target: { kind: 'global-instructions', path: 'instructions/lessons.md' },
        suggestedCategory: 'global',
      });
    });

    it('should strengthen an open lesson that says the same thing under another identity, counting the new evidence', () => {
      // Arrange — an applied lesson is still the same lesson: a scan must not file it again.
      const known = new Map([['old-observation', observation('old-observation')]]);
      const existing: Proposal = {
        ...proposal(['old-observation']),
        identity: 'environment-first',
        state: 'applied',
        count: 4,
      };

      // Act
      const actual = applyMinerOutput(
        [existing],
        [],
        {
          ...evidence,
          proposals: [
            { title: 'Environment', ruleText: 'Always use the project environment!', observationKeys: ['one'] },
          ],
        },
        new Map([['session-1', digest()]]),
        known,
        'run-2',
        at,
      );

      // Assert
      should(actual.proposals).have.length(1);
      should(actual.proposals[0]).match({ identity: 'environment-first', count: 5, state: 'applied' });
      should(actual.stats).match({ proposalsCreated: 0, proposalsStrengthened: 1 });
    });

    it('should not merge a repo lesson into the same rule filed for another project', () => {
      // Arrange
      const known = new Map([['old-observation', observation('old-observation')]]);
      const existing: Proposal = {
        ...proposal(['old-observation']),
        identity: 'environment-first',
        category: 'repo',
        project: '/repo-b',
        target: { kind: 'repo-instructions', path: '/repo-b' },
      };

      // Act
      const actual = applyMinerOutput(
        [existing],
        [],
        {
          ...evidence,
          proposals: [
            { title: 'Environment', ruleText: 'Use the project environment.', scope: 'repo', observationKeys: ['one'] },
          ],
        },
        new Map([['session-1', digest()]]),
        known,
        'run-2',
        at,
      );

      // Assert
      should(actual.proposals.map(entry => entry.project)).deepEqual(['/repo-b', '/repo-a']);
      should(actual.stats).match({ proposalsCreated: 1, proposalsStrengthened: 0 });
    });
  });
});
