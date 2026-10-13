import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerHistoryCommands } from '../../../src/lib/history/commands.ts';
import type { HistoryClaimRequest } from '../../../src/lib/history/controller.ts';

const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';

function program(): { readonly program: Command; readonly requests: HistoryClaimRequest[] } {
  const requests: HistoryClaimRequest[] = [];
  const root = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerHistoryCommands(root, { claim: async request => void requests.push(request) });
  for (const command of root.commands) {
    command.exitOverride().configureOutput({ writeErr: () => undefined });
    for (const sub of command.commands) sub.exitOverride().configureOutput({ writeErr: () => undefined });
  }
  return { program: root, requests };
}

describe('registerHistoryCommands', () => {
  it('should claim a named conversation for a pid', async () => {
    // Arrange
    const { program: root, requests } = program();

    // Act
    await root.parseAsync(['history', 'claim', CONVERSATION, '--harness', 'codex', '--pid', '42'], { from: 'user' });

    // Assert
    should(requests).eql([{ harness: 'codex', pid: 42, conversation: CONVERSATION }]);
  });

  it('should hand over the harness arguments when asked to read the conversation from them', async () => {
    // Arrange
    const { program: root, requests } = program();

    // Act
    await root.parseAsync(
      ['history', 'claim', '--harness', 'claude', '--pid', '42', '--from-arguments', '--', '--resume', CONVERSATION],
      { from: 'user' },
    );

    // Assert
    should(requests).eql([{ harness: 'claude', pid: 42, arguments: ['--resume', CONVERSATION] }]);
  });

  it('should pass no conversation when none is given', async () => {
    // Arrange
    const { program: root, requests } = program();

    // Act
    await root.parseAsync(['history', 'claim', '--harness', 'claude', '--pid', '42'], { from: 'user' });

    // Assert
    should(requests).eql([{ harness: 'claude', pid: 42 }]);
  });

  it('should refuse a pid that is not a positive whole number', async () => {
    // Arrange
    const { program: root, requests } = program();

    // Act
    const parsing = root.parseAsync(['history', 'claim', '--harness', 'claude', '--pid', '-3'], { from: 'user' });

    // Assert
    await should(parsing).be.rejectedWith(/positive whole number/u);
    should(requests).be.empty();
  });
});
