import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerCredentialCommands } from '../../../src/lib/credential/commands.ts';

describe('registerCredentialCommands', () => {
  it('should add no command while it is an account-model seed', () => {
    // Arrange
    const program = new Command();

    // Act
    registerCredentialCommands(program);

    // Assert
    should(program.commands).be.empty();
  });
});
