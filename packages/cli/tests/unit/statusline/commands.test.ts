import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerStatuslineCommands } from '../../../src/lib/statusline/commands.ts';

describe('registerStatuslineCommands', () => {
  it('should add no command while it is an account-model seed', () => {
    // Arrange
    const program = new Command();

    // Act
    registerStatuslineCommands(program);

    // Assert
    should(program.commands).be.empty();
  });
});
