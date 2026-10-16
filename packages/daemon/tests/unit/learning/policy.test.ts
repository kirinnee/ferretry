import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import {
  matchesTombstone,
  normalizeForMatch,
  observationId,
  parseJsonl,
  recomputeProposal,
  RULE_MERGE_THRESHOLD,
  ruleSimilarity,
  ruleWords,
  sameRule,
  slugify,
  strengthOf,
  titleHash,
  verifyQuote,
  type Observation,
  type Proposal,
} from '../../../src/lib/learning/index.ts';

const proposal: Proposal = {
  id: 'proposal-1',
  category: 'global',
  state: 'pending',
  title: 'Use the project environment',
  ruleText: 'Run commands through the project environment.',
  target: { kind: 'global-agent-guidance', path: 'guidance.md' },
  observationIds: ['one', 'missing', 'two'],
  occurrences: 99,
  crossRepoCount: 99,
  firstSeen: '2026-07-30T10:00:00.000Z',
  lastSeen: '2026-07-30T10:00:00.000Z',
  identity: 'use-project-environment',
  history: [{ at: '2026-07-30T10:00:00.000Z', event: 'proposed', by: 'miner' }],
  source: 'scan',
  count: 3,
};

const observation = (id: string, sessionId: string, repo: string, at: string): Observation => ({
  id,
  sessionId,
  mode: 'auto',
  cwd: '/workspace',
  repo,
  at,
  kind: 'correction',
  gist: 'Use the environment.',
  quote: 'Use direnv exec.',
  source: 'human',
  verified: true,
  runId: 'run-1',
});

describe('learning policy', () => {
  it.each([
    { value: '  Déjà vu: run tools! ', expected: 'de-ja-vu-run-tools' },
    { value: '***', expected: '' },
    { value: 'x'.repeat(80), expected: 'x'.repeat(60) },
  ])('should create stable bounded identities for $value', ({ value, expected }) => {
    // Act
    const actual = slugify(value);

    // Assert
    should(actual).equal(expected);
  });

  it('should verify real quotes while rejecting blank, short, and fabricated text', () => {
    // Arrange
    const corpus = 'Please   run DIRenv exec . before commands.';

    // Act
    const verified = verifyQuote('run direnv\nexec .', corpus);
    const rejected = ['  ', 'ok', 'run a shell directly'].map(quote => verifyQuote(quote, corpus));

    // Assert
    should(verified).be.true();
    should(rejected).deepEqual([false, false, false]);
  });

  it('should use normalized text for matching and content-addressed observation ids', () => {
    // Act
    const normalized = normalizeForMatch(' A\n  MIXED\tCase ');
    const same = observationId('session', 'Use\n direnv', ' Environment ');
    const equivalent = observationId('session', 'use direnv', 'environment');
    const different = observationId('other-session', 'use direnv', 'environment');

    // Assert
    should(normalized).equal('a mixed case');
    should(same).equal(equivalent);
    should(different).not.equal(same);
  });

  it.each([
    { occurrences: 0, expected: 'weak' },
    { occurrences: 1, expected: 'weak' },
    { occurrences: 2, expected: 'normal' },
    { occurrences: 4, expected: 'normal' },
    { occurrences: 5, expected: 'strong' },
  ])('should classify evidence strength at $occurrences occurrences', ({ occurrences, expected }) => {
    // Act
    const actual = strengthOf(occurrences);

    // Assert
    should(actual).equal(expected);
  });

  it('should suppress tombstoned identities and equivalent titles', () => {
    // Arrange
    const tombstones = [
      {
        identity: 'old-rule',
        titleHash: titleHash('Old title'),
        ruleGist: 'old',
        rejectedAt: '2026-07-30T10:00:00.000Z',
      },
      {
        identity: 'different-identity',
        titleHash: titleHash('Use the project environment'),
        ruleGist: 'environment',
        rejectedAt: '2026-07-30T10:00:00.000Z',
      },
    ];

    // Act
    const byIdentity = matchesTombstone({ ...proposal, identity: 'old-rule' }, tombstones);
    const byTitle = matchesTombstone(proposal, tombstones);
    const retained = matchesTombstone({ ...proposal, title: 'Another rule' }, tombstones);

    // Assert
    should(byIdentity).be.true();
    should(byTitle).be.true();
    should(retained).be.false();
  });

  it('should discard unresolved evidence and rebuild all derived proposal fields', () => {
    // Arrange
    const observations = new Map([
      ['one', observation('one', 'session-a', 'repo-a', '2026-07-31T12:00:00.000Z')],
      ['two', observation('two', 'session-a', 'repo-b', '2026-07-29T12:00:00.000Z')],
    ]);

    // Act
    const actual = recomputeProposal(proposal, observations);

    // Assert
    should(actual).deepEqual({
      ...proposal,
      observationIds: ['one', 'two'],
      occurrences: 1,
      crossRepoCount: 2,
      firstSeen: '2026-07-29T12:00:00.000Z',
      lastSeen: '2026-07-31T12:00:00.000Z',
    });
    should(proposal.occurrences).equal(99);
  });

  it('should retain valid JSONL records when blank and corrupt lines are present', () => {
    // Act
    const actual = parseJsonl('{"id":1}\n\nnot json\n {"id":2} \n', z.object({ id: z.number() }));

    // Assert
    should(actual).deepEqual([{ id: 1 }, { id: 2 }]);
  });

  it('should drop a well-formed line that is not the record the schema describes', () => {
    // Act — valid JSON of the wrong shape is as unreadable as a torn line, and must not reach a caller
    // typed as though it were a record.
    const actual = parseJsonl('{"id":1}\n{"id":"two"}\n[3]\n{"id":4}\n', z.object({ id: z.number() }));

    // Assert
    should(actual).deepEqual([{ id: 1 }, { id: 4 }]);
  });
});

describe('rule similarity', () => {
  it('should reduce a rule to its meaningful words, lowercased and without punctuation', () => {
    // Arrange / Act / Assert
    should([...ruleWords('Please ALWAYS use Bun, not Python — for the scripts!')]).deepEqual([
      'use',
      'bun',
      'not',
      'python',
      'scripts',
    ]);
    should([...ruleWords('the a, an!')]).deepEqual([]);
  });

  it('should score shared meaningful words from nothing to everything', () => {
    // Arrange / Act / Assert
    should(ruleSimilarity('Use bun, not Python.', 'use bun not python')).equal(1);
    should(ruleSimilarity('Use bun.', 'Run task test.')).equal(0);
    // Two of four distinct words shared.
    should(ruleSimilarity('use bun', 'use bun run tests')).equal(0.5);
    // A rule of stopwords alone says nothing, so it matches nothing — not even itself.
    should(ruleSimilarity('the', 'the')).equal(0);
    should(ruleSimilarity('use bun', '')).equal(0);
  });

  it('should call two rules the same only at the merge threshold or above', () => {
    // Arrange — three of four distinct words shared is exactly the threshold.
    should(ruleSimilarity('use bun for scripts', 'use bun scripts always quickly')).equal(RULE_MERGE_THRESHOLD);

    // Act / Assert
    should(sameRule('use bun scripts', 'use bun scripts quickly')).be.true();
    should(sameRule('Use bun, not Python.', 'Always use bun, not python!')).be.true();
    should(sameRule('use bun', 'use bun run tests')).be.false();
  });
});
