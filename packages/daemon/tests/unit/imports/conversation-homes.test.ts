/**
 * Where the computer's own conversations are read from, and the switch that lists them: the home each
 * CLI uses by default or by environment variable, and "Keep in sync" read fresh from the account model.
 */
import { describe, it } from 'bun:test';
import { parseAccountModel } from '@ferretry/fleet';
import should from 'should';
import { AccountModelConversationListPolicy, computerConversationRoots } from '../../../src/lib/imports/index.ts';

describe('the computer’s conversation homes', () => {
  it('should be ~/.claude and ~/.codex when no variable names another, on macOS and Linux alike', () => {
    for (const userHome of ['/Users/kirin', '/home/kirin']) {
      // Arrange
      const input = { claudeConfigDir: undefined, codexHome: undefined, userHome };

      // Act
      const actual = computerConversationRoots(input);

      // Assert
      should(actual).deepEqual([
        { harness: 'claude', home: `${userHome}/.claude`, source: 'computer' },
        { harness: 'codex', home: `${userHome}/.codex`, source: 'computer' },
      ]);
    }
  });

  it('should follow CLAUDE_CONFIG_DIR and CODEX_HOME when they name an absolute folder', () => {
    // Arrange
    const input = { claudeConfigDir: '/data/claude/', codexHome: '/data/codex', userHome: '/home/kirin' };

    // Act
    const actual = computerConversationRoots(input);

    // Assert
    should(actual.map(root => root.home)).deepEqual(['/data/claude', '/data/codex']);
  });

  it('should treat an empty variable as unset, and never guess at a relative one', () => {
    // Arrange
    const empty = { claudeConfigDir: '  ', codexHome: '', userHome: '/home/kirin' };
    const relative = { claudeConfigDir: 'claude-home', codexHome: '.codex-here', userHome: '/home/kirin' };

    // Act
    const unset = computerConversationRoots(empty);
    const guessed = computerConversationRoots(relative);

    // Assert
    should(unset.map(root => root.home)).deepEqual(['/home/kirin/.claude', '/home/kirin/.codex']);
    // Claude falls back to its default home; Codex has none to fall back on, so reads nothing.
    should(guessed).deepEqual([{ harness: 'claude', home: '/home/kirin/.claude', source: 'computer' }]);
  });
});

describe('the “Keep in sync” switch', () => {
  it('should list the computer when the machine has no configuration at all', async () => {
    // Arrange
    const subject = new AccountModelConversationListPolicy(async () => undefined);

    // Act
    const actual = await subject.listsComputer();

    // Assert
    should(actual).equal(true);
  });

  it('should read the machine setting fresh each time, so flipping it applies to the next listing', async () => {
    // Arrange
    let listComputer = true;
    const subject = new AccountModelConversationListPolicy(async () =>
      parseAccountModel({ version: 2, machine: { conversations: { listComputer } } }),
    );

    // Act
    const on = await subject.listsComputer();
    listComputer = false;
    const off = await subject.listsComputer();

    // Assert
    should([on, off]).deepEqual([true, false]);
  });

  it('should be on in a document that never mentioned conversations', async () => {
    // Arrange
    const subject = new AccountModelConversationListPolicy(async () => parseAccountModel({ version: 2 }));

    // Act
    const actual = await subject.listsComputer();

    // Assert
    should(actual).equal(true);
  });
});
