import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerScratchCommands } from '../../../src/lib/scratch/commands.ts';
import { ScratchController } from '../../../src/lib/scratch/controller.ts';
import { CapturingOutput, RecordingScratchGateway } from './fixtures.ts';

function run(argv: string[]) {
  const gateway = new RecordingScratchGateway();
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerScratchCommands(program, new ScratchController(gateway, out));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('scratch command surface', () => {
  it('should run a dry plan with its requested limit', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['gc', '--dry-run', '--limit', '4']);
    await parsed;

    // Assert
    should(gateway.limits).eql([4]);
    should(gateway.forces).be.empty();
  });

  it('should run a real sweep and emit JSON', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run(['gc', '--json']);
    await parsed;

    // Assert
    should(gateway.forces).eql([false]);
    should(JSON.parse(out.messages[0] ?? '')).have.property('sessions', 1);
  });

  it('should not offer a flag that overrides daemon-side GC safety', async () => {
    // Arrange + Act + Assert
    await should(run(['gc', '--force']).parsed).be.rejected();
  });
});
