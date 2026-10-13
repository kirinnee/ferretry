import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerSetupCommands } from '../../../src/lib/setup/commands.ts';

describe('registerSetupCommands', () => {
  it('should add no command while it is an account-model seed', () => {
    // Arrange
    const program = new Command();

    // Act
    registerSetupCommands(program);

    // Assert
    should(program.commands).be.empty();
  });
});
