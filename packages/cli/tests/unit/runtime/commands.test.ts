import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerRuntimeCommands } from '../../../src/lib/runtime/commands.ts';

describe('registerRuntimeCommands', () => {
  it('should add no command while it is an account-model seed', () => {
    // Arrange
    const program = new Command();

    // Act
    registerRuntimeCommands(program);

    // Assert
    should(program.commands).be.empty();
  });
});
