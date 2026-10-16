import { describe, it } from 'bun:test';
import should from 'should';
import {
  fileSuggestion,
  GLOBAL_LESSONS_FILE,
  lessonTarget,
  observationId,
  type Proposal,
  type SuggestionInput,
  slugify,
  titleHash,
  type Tombstone,
} from '../../../src/lib/learning/index.ts';

/**
 * A ferret's suggestion folded into the inbox: filed when it is new, merged into the same open lesson
 * when it says the same thing, and refused when the owner already rejected it. The evidence is the
 * daemon's, never the ferret's.
 */

const AT = '2026-08-01T10:00:00.000Z';
const LATER = '2026-08-01T11:00:00.000Z';
const RULE = 'Use bun, not Python, for ad hoc scripts.';

const input = (overrides: Partial<SuggestionInput> = {}): SuggestionInput => ({
  rule: RULE,
  scope: 'global',
  sessionId: 'ferret-1',
  mode: 'interactive',
  cwd: '/work/ferretry/packages/cli',
  project: '/work/ferretry',
  evidence: { quote: 'no python please, use bun', source: 'human', at: AT, turn: 4 },
  at: AT,
  ...overrides,
});

/** The board after one filing of `overrides`. */
const filed = (overrides: Partial<SuggestionInput> = {}): Proposal => {
  const proposal = fileSuggestion([], [], input(overrides)).proposal;
  if (proposal === undefined) throw new Error('nothing was filed');
  return proposal;
};

describe('a passive suggestion', () => {
  describe('lessonTarget', () => {
    it('should point a repo lesson at its project and anything else at the global document', () => {
      // Arrange / Act / Assert
      should(lessonTarget('repo', '/work/ferretry')).deepEqual({ kind: 'repo-instructions', path: '/work/ferretry' });
      should(lessonTarget('repo', undefined)).deepEqual({ kind: 'global-instructions', path: GLOBAL_LESSONS_FILE });
      should(lessonTarget('global', '/work/ferretry')).deepEqual({
        kind: 'global-instructions',
        path: GLOBAL_LESSONS_FILE,
      });
    });
  });

  it('should file a new lesson with the daemon evidence beside it', () => {
    // Arrange / Act
    const result = fileSuggestion([], [], input({ teammate: 'Hadi', rule: `  ${RULE} Then lint.  ` }));

    // Assert
    should(result.outcome).equal('filed');
    should(result.proposals).have.length(1);
    const rule = `${RULE} Then lint.`;
    should(result.proposal).match({
      id: `lesson_${slugify(rule)}_20260801100000000`,
      category: 'global',
      state: 'pending',
      // The title is the rule's first sentence.
      title: RULE,
      ruleText: rule,
      target: { kind: 'global-instructions', path: GLOBAL_LESSONS_FILE },
      occurrences: 1,
      crossRepoCount: 1,
      firstSeen: AT,
      lastSeen: AT,
      identity: slugify(rule),
      source: 'passive',
      project: '/work/ferretry',
      suggestedCategory: 'global',
      count: 1,
      history: [{ at: AT, event: 'suggested:ferret-1', by: 'ferret' }],
    });
    should(result.observation).deepEqual({
      id: observationId('ferret-1', 'no python please, use bun', rule),
      sessionId: 'ferret-1',
      teammate: 'Hadi',
      mode: 'interactive',
      cwd: '/work/ferretry/packages/cli',
      repo: '/work/ferretry',
      at: AT,
      kind: 'suggestion',
      gist: rule,
      quote: 'no python please, use bun',
      source: 'human',
      verified: true,
      runId: 'passive',
      turn: 4,
    });
    should(result.proposal?.observationIds).deepEqual([result.observation?.id]);
  });

  it('should file a repo lesson against the project it came from', () => {
    // Arrange / Act
    const proposal = filed({ scope: 'repo' });

    // Assert
    should(proposal.category).equal('repo');
    should(proposal.target).deepEqual({ kind: 'repo-instructions', path: '/work/ferretry' });
  });

  it('should fall back to the rule itself when the owner has said nothing, and clip both', () => {
    // Arrange
    const long = `Prefer ${'x'.repeat(600)}`;

    // Act
    const result = fileSuggestion(
      [],
      [],
      input({ rule: long, evidence: { quote: '   ', source: 'teammate', at: AT } }),
    );

    // Assert
    should(result.observation?.quote).equal(long.slice(0, 300));
    should(result.observation?.gist).have.length(400);
    should(result.observation?.source).equal('teammate');
    // No turn is claimed when the daemon could not tell one.
    should(result.observation).not.have.property('turn');
    should(result.observation).not.have.property('teammate');
    should(result.proposal?.title).have.length(200);
  });

  it('should merge a rule that says the same thing into the open lesson, counting it once more', () => {
    // Arrange
    const first = filed();

    // Act — reworded, from another session, later.
    const result = fileSuggestion(
      [first],
      [],
      input({
        rule: 'use bun not python for ad hoc scripts',
        sessionId: 'ferret-2',
        at: LATER,
        evidence: { quote: 'bun!', source: 'human', at: LATER },
      }),
    );

    // Assert
    should(result.outcome).equal('merged');
    should(result.proposals).have.length(1);
    should(result.proposal?.id).equal(first.id);
    should(result.proposal?.count).equal(2);
    should(result.proposal?.lastSeen).equal(LATER);
    should(result.proposal?.observationIds).have.length(2);
    should(result.proposal?.history.at(-1)).deepEqual({ at: LATER, event: 'suggested:ferret-2', by: 'ferret' });
    should(result.observation?.sessionId).equal('ferret-2');
  });

  it('should keep the newer lastSeen when a merge carries an older instant', () => {
    // Arrange
    const first = filed({ at: LATER });

    // Act
    const result = fileSuggestion([first], [], input({ sessionId: 'ferret-2', at: AT }));

    // Assert
    should(result.proposal?.lastSeen).equal(LATER);
  });

  it('should not count the same observation twice', () => {
    // A ferret repeating itself in one turn cannot inflate a lesson.
    // Arrange
    const first = filed();

    // Act
    const result = fileSuggestion([first], [], input());

    // Assert
    should(result.outcome).equal('merged');
    should(result.proposals).deepEqual([first]);
    should(result.proposal).equal(first);
    should(result).not.have.property('observation');
  });

  it('should file separately for a different home: another scope or another project', () => {
    // Arrange
    const global = filed();
    const repo = filed({ scope: 'repo' });

    // Act
    const asRepo = fileSuggestion([global], [], input({ scope: 'repo' }));
    const otherProject = fileSuggestion([repo], [], input({ scope: 'repo', project: '/work/kteam' }));
    const sameProject = fileSuggestion([repo], [], input({ scope: 'repo', sessionId: 'ferret-2' }));

    // Assert
    should(asRepo.outcome).equal('filed');
    should(otherProject.outcome).equal('filed');
    should(sameProject.outcome).equal('merged');
  });

  it('should merge into an accepted or applied lesson but not into a closed different rule', () => {
    // Arrange
    const accepted = { ...filed(), state: 'accepted' as const };
    const applied = { ...filed(), id: 'applied', state: 'applied' as const };
    const other = { ...filed({ rule: 'Never force-push to main.' }) };

    // Act / Assert
    should(fileSuggestion([accepted], [], input({ sessionId: 'ferret-2' })).outcome).equal('merged');
    should(fileSuggestion([applied], [], input({ sessionId: 'ferret-2' })).outcome).equal('merged');
    should(fileSuggestion([other], [], input()).outcome).equal('filed');
  });

  it('should refuse a rule the owner rejected, by its tombstone', () => {
    // Arrange
    const byIdentity: Tombstone = { identity: slugify(RULE), titleHash: 'x', ruleGist: RULE, rejectedAt: AT };
    const byTitle: Tombstone = { identity: 'other', titleHash: titleHash(RULE), ruleGist: RULE, rejectedAt: AT };
    const board = [filed({ rule: 'Never force-push to main.' })];

    // Act
    const results = [fileSuggestion(board, [byIdentity], input()), fileSuggestion(board, [byTitle], input())];

    // Assert
    for (const result of results) {
      should(result).deepEqual({ outcome: 'previously-rejected', proposals: board });
    }
  });

  it('should refuse a rule that says the same as a rejected lesson', () => {
    // Arrange
    const rejected = { ...filed(), state: 'rejected' as const };

    // Act
    const result = fileSuggestion([rejected], [], input({ rule: 'Use bun not python for ad-hoc scripts!' }));

    // Assert
    should(result.outcome).equal('previously-rejected');
    should(result.proposals).deepEqual([rejected]);
  });
});
