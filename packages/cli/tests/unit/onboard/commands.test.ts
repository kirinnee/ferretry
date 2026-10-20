import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerOnboardCommands } from '../../../src/lib/onboard/commands.ts';
import type { OnboardController, SetupOptions } from '../../../src/lib/onboard/controller.ts';

const mounted = () => {
  const calls: SetupOptions[] = [];
  const program = new Command().name('fy').exitOverride();
  registerOnboardCommands(
    program,
    () => ({ setup: async (flags: SetupOptions) => void calls.push(flags) }) as unknown as OnboardController,
  );
  return { program, calls };
};

describe('registerOnboardCommands', () => {
  it('should mount `setup` and pass its flags through', async () => {
    // Arrange
    const { program, calls } = mounted();

    // Act
    await program.parseAsync(['node', 'fy', 'setup', '--yes', '--json', '--check']);

    // Assert
    should(calls).eql([{ yes: true, json: true, check: true }]);
  });

  it('should document the exit status and why the code never leaves the terminal', () => {
    // Arrange
    const { program } = mounted();
    const setup = program.commands.find(command => command.name() === 'setup');
    let help = '';
    setup?.configureOutput({
      writeOut: text => {
        help += text;
      },
    });

    // Act
    setup?.outputHelp();

    // Assert
    should(help).containEql('Exit status: 0 ready, 1 not running, 2 waiting for you');
    should(help).containEql('`fy pair`');
    should(help).containEql('`fy daemon update`');
  });
});
