import { describe, it } from 'bun:test';
import should from 'should';
import { MAX_OWNER_ASK_LENGTH, MAX_OWNER_ASKS, ownerAsks } from '../../../src/lib/agenda/owner-asks.ts';

describe('owner asks', () => {
  it('should read only the owner-labelled item under a mixed Next steps list', () => {
    // Arrange
    const reply = '**Done:** PR opened.\n\nNext steps:\n- You: run `hms` to apply the new skill\n- Me: babysit CI';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['run `hms` to apply the new skill']);
  });

  it('should read an owner label on the same line as Next steps', () => {
    // Arrange
    const reply = 'Next steps: You: approve the deploy in the dashboard.';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['approve the deploy in the dashboard.']);
  });

  it('should read an inline list marker after Next steps', () => {
    // Arrange
    const reply = 'Next steps: - You: approve X';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['approve X']);
  });

  it('should treat a bold or plain "Next steps: none" as nothing', () => {
    // Arrange
    const bold = '**Next steps:** none';
    const plain = 'Next steps: none.';

    // Act
    const actual = [ownerAsks(bold), ownerAsks(plain)];

    // Assert
    should(actual).deepEqual([[], []]);
  });

  it('should ignore a Next steps list that is all the ferret', () => {
    // Arrange
    const reply = 'Next steps:\n- Me: wait for CI\n- Me: report back';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should count every item under an owner heading', () => {
    // Arrange
    const reply = '## Waiting on you\n1. Merge the relay PR\n2. Decide whether to keep the cron';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['Merge the relay PR', 'Decide whether to keep the cron']);
  });

  it('should count only the rows a Who column gives to the owner', () => {
    // Arrange
    const reply =
      '| Who | Next step |\n| --- | --- |\n| You | Log in to Cloudflare and paste the token |\n| Me | Wire the relay |';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['Log in to Cloudflare and paste the token']);
  });

  it('should count every row of a table under an owner heading, cells joined', () => {
    // Arrange
    const reply =
      '### What I need from you\n\n| Step | Where |\n| --- | --- |\n| Paste the token | Cloudflare |\n| Approve | GitHub |';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['Paste the token — Cloudflare', 'Approve — GitHub']);
  });

  it('should count only rows whose first cell is an owner label under a mixed heading', () => {
    // Arrange
    const reply = 'Next steps:\n\n| Step | Detail |\n| --- | --- |\n| You | Merge it |\n| Me | Watch CI |';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['Merge it']);
  });

  it('should read bold owner labels under a bold heading', () => {
    // Arrange
    const reply = '**Next steps**\n- **You:** sign in with `gh auth login`\n- **You:** confirm the merge';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['sign in with `gh auth login`', 'confirm the merge']);
  });

  it('should read nested items under a bare owner label until the indentation returns', () => {
    // Arrange
    const reply = 'Next steps:\n- You:\n  - restart the daemon\n  - check the badge\n- Me: watch CI';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['restart the daemon', 'check the badge']);
  });

  it('should read items under a bare bold owner label line', () => {
    // Arrange
    const reply = 'Next steps:\n**You:**\n- restart the daemon\n- check the badge\n**Me:**\n- watch CI';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['restart the daemon', 'check the badge']);
  });

  it('should stop at the recap that follows the list', () => {
    // Arrange
    const reply = '**Next steps**\n- You: review https://github.com/o/r/pull/9\n\nQ: Is it done?\nA: Yes.';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['review https://github.com/o/r/pull/9']);
  });

  it('should ignore everything inside a code fence', () => {
    // Arrange
    const reply = 'Here is the format:\n\n```md\nNext steps: You: x\n- You: y\n```\n\n~~~\nWaiting on you\n- z\n~~~';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should drop an item that already references an agenda item, in either spelling', () => {
    // Arrange
    const reply =
      '- You: answer !A3 on the agenda\n- You: see ?A4\n- You: read the agenda item\n- You: read the agenda item';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should drop an owner label that says nothing is needed', () => {
    // Arrange
    const reply = "Next steps: You: nothing — I'll continue";

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should never read plain prose as an ask', () => {
    // Arrange
    const reply = "You could also try restarting later if you want.\nYou'll see the badge go green.";

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should read a "(you)" heading as an owner heading', () => {
    // Arrange
    const reply = 'Next steps (you):\n- Run hms';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['Run hms']);
  });

  it('should ignore a mixed heading whose inline text is the ferret', () => {
    // Arrange
    const reply = 'What happens next: I merge after CI.';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should treat an owner heading that says nothing as nothing', () => {
    // Arrange
    const reply = 'Waiting on you: nothing';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should read an owner label anywhere, even outside a section', () => {
    // Arrange
    const reply = 'All pushed.\nYou need to restart the daemon.\n\n- (You) approve the PR\n- Owner: pick a name';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['restart the daemon.', 'approve the PR', 'pick a name']);
  });

  it('should skip agent-labelled items even under an owner heading', () => {
    // Arrange
    const reply = "## Waiting on you\n- Merge the PR\n- Me: watch CI\n- I'll rebase";

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['Merge the PR']);
  });

  it('should return at most the maximum number of asks', () => {
    // Arrange
    const reply = `## Waiting on you\n${Array.from({ length: MAX_OWNER_ASKS + 4 }, (_, n) => `- item ${n}`).join('\n')}`;

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).have.length(MAX_OWNER_ASKS);
    should(actual[0]).equal('item 0');
  });

  it('should cut a long ask and end it with an ellipsis', () => {
    // Arrange
    const reply = `- You: ${'x'.repeat(300)}`;

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).have.length(1);
    should(actual[0]).have.length(MAX_OWNER_ASK_LENGTH);
    should(actual[0]?.endsWith('…')).be.true();
  });

  it('should return a repeated ask once', () => {
    // Arrange
    const reply = '- You: merge it\n- **You:** merge it\n- You: merge it';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['merge it']);
  });

  it('should read Windows line endings the same way', () => {
    // Arrange
    const reply =
      '**Done:** PR opened.\r\n\r\nNext steps:\r\n- You: run `hms`\r\n- Me: babysit CI\r\n\r\nQ: Done?\r\nA: Yes.';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['run `hms`']);
  });

  it('should return nothing for an empty reply', () => {
    // Arrange / Act / Assert
    should(ownerAsks('')).deepEqual([]);
  });

  it('should strip emphasis around a whole item, and an unbalanced marker at either end', () => {
    // Arrange
    const reply = '## Waiting on you\n- **Approve the deploy**\n- **Merge the relay PR\n- Rotate the key**';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['Approve the deploy', 'Merge the relay PR', 'Rotate the key']);
  });

  it('should ignore a table outside any section that names no owner column', () => {
    // Arrange
    const reply = '| Step | Status |\n| --- | --- |\n| Build | green |\n| Deploy | pending |';

    // Act + Assert
    should(ownerAsks(reply)).deepEqual([]);
  });

  it('should read the list under a bare You: label written inline after Next steps', () => {
    // Arrange
    const reply = 'Next steps: You:\n- restart the daemon\n- check the badge';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['restart the daemon', 'check the badge']);
  });

  it('should close an owner section at any other heading', () => {
    // Arrange
    const reply = '## Waiting on you\n- Approve the deploy\n## Details\n- The cache was rebuilt';

    // Act
    const actual = ownerAsks(reply);

    // Assert
    should(actual).deepEqual(['Approve the deploy']);
  });
});
