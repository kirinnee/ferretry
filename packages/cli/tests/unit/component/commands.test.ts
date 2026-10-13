import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerComponentCommands } from '../../../src/lib/component/commands.ts';

describe('registerComponentCommands', () => {
  it('should add no command while it is an account-model seed', () => {
    // Arrange
    const program = new Command();

    // Act
    registerComponentCommands(program);

    // Assert
    should(program.commands).be.empty();
  });
});
