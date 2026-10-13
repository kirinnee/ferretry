import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerHistoryCommands } from '../../../src/lib/history/commands.ts';

describe('registerHistoryCommands', () => {
  it('should add no command while it is an account-model seed', () => {
    // Arrange
    const program = new Command();

    // Act
    registerHistoryCommands(program);

    // Assert
    should(program.commands).be.empty();
  });
});
