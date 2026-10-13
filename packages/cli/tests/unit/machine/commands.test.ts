import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerMachineCommands } from '../../../src/lib/machine/commands.ts';

describe('registerMachineCommands', () => {
  it('should add no command while it is an account-model seed', () => {
    // Arrange
    const program = new Command();

    // Act
    registerMachineCommands(program);

    // Assert
    should(program.commands).be.empty();
  });
});
