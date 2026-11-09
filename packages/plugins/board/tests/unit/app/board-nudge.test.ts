import { describe, it } from 'bun:test';
import should from 'should';
import { linkNudgePullRequests } from '../../../app/lib/board-nudge.ts';

const NUDGE = '&F209 PR #1087 CI is red. Fix it, or note on the card why it can stay red.';
const PR_URL = 'https://github.com/atomi/ferretry/pull/1087';
const CARDS = [{ id: 'F209', prs: [{ number: 1087, url: PR_URL }] }];

describe('linkNudgePullRequests', () => {
  it('should link the pull request the named card links', () => {
    // Act
    const linked = linkNudgePullRequests(NUDGE, CARDS);

    // Assert
    should(linked).equal(`&F209 [PR #1087](${PR_URL}) CI is red. Fix it, or note on the card why it can stay red.`);
  });

  it('should match the card without regard to case', () => {
    // Act
    const linked = linkNudgePullRequests('&f209 PR #1087 CI is red.', CARDS);

    // Assert
    should(linked).equal(`&f209 [PR #1087](${PR_URL}) CI is red.`);
  });

  it('should leave a pull request the card does not link as plain words', () => {
    // Act / Assert
    should(linkNudgePullRequests('&F209 PR #5 CI is red.', CARDS)).equal('&F209 PR #5 CI is red.');
  });

  it('should leave the line as it is when the card is not among the cards given', () => {
    // Act / Assert
    should(linkNudgePullRequests('&F1 PR #1087 CI is red.', CARDS)).equal('&F1 PR #1087 CI is red.');
  });

  it('should leave the line as it is when the card links no pull requests', () => {
    // Act / Assert
    should(linkNudgePullRequests(NUDGE, [{ id: 'F209' }])).equal(NUDGE);
  });

  it('should leave the line as it is when no card is named or no cards are known', () => {
    // Act / Assert
    should(linkNudgePullRequests('PR #1087 CI is red.', CARDS)).equal('PR #1087 CI is red.');
    should(linkNudgePullRequests(NUDGE, undefined)).equal(NUDGE);
  });
});
