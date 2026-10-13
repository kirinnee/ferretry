import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerProfileCommands } from '../../../src/lib/profile/commands.ts';

describe('registerProfileCommands', () => {
  it('should add no command while it is an account-model seed', () => {
    // Arrange
    const program = new Command();

    // Act
    registerProfileCommands(program);

    // Assert
    should(program.commands).be.empty();
  });
});
