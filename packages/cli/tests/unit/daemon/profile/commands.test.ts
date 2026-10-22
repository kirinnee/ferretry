import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerProfileCommands } from '../../../../src/lib/daemon/profile/commands.ts';
import type { ProfileCommandOptions, ProfileController } from '../../../../src/lib/daemon/profile/controller.ts';

function fakeController(runs: ProfileCommandOptions[]): ProfileController {
  return { run: async (options: ProfileCommandOptions) => void runs.push(options) } as unknown as ProfileController;
}

describe('registerProfileCommands', () => {
  it('should mount profile under the daemon group and pass its flags to the controller', async () => {
    // Arrange
    const runs: ProfileCommandOptions[] = [];
    const subject = new Command().exitOverride();
    subject.command('daemon');
    registerProfileCommands(subject, () => fakeController(runs));

    // Act
    await subject.parseAsync(
      ['daemon', 'profile', '--seconds', '10', '--json', '--out', 'r.json', '--trace-syscalls'],
      {
        from: 'user',
      },
    );

    // Assert
    should(runs).deepEqual([{ seconds: '10', json: true, out: 'r.json', traceSyscalls: true }]);
  });

  it('should run with no flags set', async () => {
    // Arrange
    const runs: ProfileCommandOptions[] = [];
    const subject = new Command().exitOverride();
    subject.command('daemon');
    registerProfileCommands(subject, () => fakeController(runs));

    // Act
    await subject.parseAsync(['daemon', 'profile'], { from: 'user' });

    // Assert
    should(runs).deepEqual([{}]);
  });

  it('should refuse to register before the daemon group exists', () => {
    // Arrange
    const subject = new Command();

    // Act + Assert
    should(() => registerProfileCommands(subject, () => fakeController([]))).throw(
      'the daemon command group must be registered before its profile verb',
    );
  });
});
