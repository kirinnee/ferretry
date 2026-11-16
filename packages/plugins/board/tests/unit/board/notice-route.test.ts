import { describe, it } from 'bun:test';
import should from 'should';
import { alertFallback, MAX_LINEAGE_DEPTH, noticeRecipient } from '../../../daemon/lib/board/index.ts';
import { liveSession, rosterOf } from './support.ts';

/** Which session a board alert is for: the walk up the leads, and what happens when the walk cannot go on. */

const ended = (id: string, lead?: string) =>
  liveSession(id, { status: 'stopped', ...(lead === undefined ? {} : { lead }) });

describe('the walk up the leads', () => {
  it('should end a loop of leads instead of walking it forever, and fall to the owner’s line', () => {
    // Arrange
    const roster = rosterOf([ended('a', 'b'), ended('b', 'a'), liveSession('owner')]);

    // Act
    const found = noticeRecipient(roster, { owner: 'owner', assignee: 'a' });

    // Assert
    should(found?.ferret).equal('owner');
    should(noticeRecipient(rosterOf([ended('a', 'b'), ended('b', 'a')]), { owner: 'a', assignee: 'b' })).be.null();
  });

  it('should reach a live lead inside a loop', () => {
    // Arrange
    const roster = rosterOf([ended('a', 'b'), liveSession('b', { lead: 'a' })]);

    // Act
    const found = noticeRecipient(roster, { owner: 'owner', assignee: 'a' });

    // Assert
    should(found?.ferret).equal('b');
  });

  it('should look no further up than the depth cap', () => {
    // Arrange: s0 is the assignee and every session leads to the next; only the one at `depth` is alive.
    const chain = (depth: number) =>
      rosterOf([
        ...Array.from({ length: MAX_LINEAGE_DEPTH + 10 }, (_, index) =>
          index === depth ? liveSession(`s${index}`, { lead: `s${index + 1}` }) : ended(`s${index}`, `s${index + 1}`),
        ),
        liveSession('owner'),
      ]);
    const card = { owner: 'owner', assignee: 's0' };

    // Assert: the last session inside the cap answers; the first one past it is never reached.
    should(noticeRecipient(chain(MAX_LINEAGE_DEPTH - 1), card)?.ferret).equal(`s${MAX_LINEAGE_DEPTH - 1}`);
    should(noticeRecipient(chain(MAX_LINEAGE_DEPTH), card)?.ferret).equal('owner');
  });

  it('should stop at a session in the chain that cannot be read, and fall to the owner’s line', () => {
    // Arrange: `mid` is held but its documents could not be read, so nobody above it is known.
    const roster = rosterOf([ended('child', 'mid'), liveSession('top'), liveSession('owner')], ['mid']);
    // Act
    const found = noticeRecipient(roster, { owner: 'owner', assignee: 'child' });

    // Assert
    should(found?.ferret).equal('owner');
    should(noticeRecipient(roster, { owner: 'child', assignee: 'child' })).be.null();
  });

  it('should send nothing when the assignee itself cannot be read', () => {
    // Arrange
    const roster = rosterOf([liveSession('owner')], ['child']);

    // Assert
    should(noticeRecipient(roster, { owner: 'owner', assignee: 'child' })).be.null();
  });
});

describe('who a PR alert falls back to when nobody is alive', () => {
  it('should send a red CI to the card’s working ferret, its assignee else its owner', () => {
    should(alertFallback({ owner: 'owner', assignee: 'child' }, 'ci-failing')).equal('child');
    should(alertFallback({ owner: 'owner', assignee: null }, 'ci-failing')).equal('owner');
  });

  it('should send a PR closed unmerged to the card’s owner, whoever is assigned', () => {
    should(alertFallback({ owner: 'owner', assignee: 'child' }, 'closed-unmerged')).equal('owner');
    should(alertFallback({ owner: 'owner', assignee: null }, 'closed-unmerged')).equal('owner');
  });
});
