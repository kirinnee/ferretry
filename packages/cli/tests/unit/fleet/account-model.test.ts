import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerAccountModelCommands } from '../../../src/lib/fleet/account-model.ts';
import { fakeWorld, runCommand } from './account-fakes.ts';

describe('registerAccountModelCommands', () => {
  it('should mount every account-model command group with one set of collaborators', () => {
    // Arrange
    const program = new Command().name('fz');

    // Act
    registerAccountModelCommands(program, fakeWorld().deps);

    // Assert
    should(program.commands.map(command => command.name()).toSorted()).deepEqual([
      'component',
      'components',
      'credential',
      'credentials',
      'machine',
      'profile',
      'profiles',
      'runtime',
      'runtimes',
    ]);
    // Setting up is a daemon verb now; there is no top-level `setup` to alias it.
    should(program.commands.map(command => command.name())).not.containEql('setup');
  });

  it('should answer a mounted verb through the shared gateway', async () => {
    // Arrange
    const world = fakeWorld();

    // Act
    await runCommand(registerAccountModelCommands, world, ['machine']);

    // Assert
    should(world.out.text()).match(/^studio\n/);
  });
});
