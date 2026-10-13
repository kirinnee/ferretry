import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerStatuslineCommands } from '../../../src/lib/statusline/commands.ts';
import type { StatuslineController, StatuslineOptions } from '../../../src/lib/statusline/controller.ts';

function recording(): { readonly controller: StatuslineController; readonly calls: StatuslineOptions[] } {
  const calls: StatuslineOptions[] = [];
  const controller = {
    run: async (options: StatuslineOptions) => {
      calls.push(options);
    },
  } as unknown as StatuslineController;
  return { controller, calls };
}

describe('registerStatuslineCommands', () => {
  it('should hand the person\'s own command to the controller when --then names one', async () => {
    // Arrange
    const program = new Command().exitOverride();
    const { controller, calls } = recording();
    registerStatuslineCommands(program, controller);

    // Act
    await program.parseAsync(['statusline', '--then', 'echo mine'], { from: 'user' });

    // Assert
    should(calls).eql([{ own: 'echo mine' }]);
  });

  it('should run with no chained command when --then is absent', async () => {
    // Arrange
    const program = new Command().exitOverride();
    const { controller, calls } = recording();
    registerStatuslineCommands(program, controller);

    // Act
    await program.parseAsync(['statusline'], { from: 'user' });

    // Assert
    should(calls).eql([{}]);
  });
});
