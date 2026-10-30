import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerRestartCommands } from '../../../src/lib/restart/commands.ts';
import { RestartController } from '../../../src/lib/restart/controller.ts';
import { restartHarness } from './fixtures.ts';

function run(argv: string[]) {
  const { gateway, io, presenter } = restartHarness();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRestartCommands(program, new RestartController(gateway, presenter, 'ses-9', undefined, () => 'req-1'));
  return { parsed: program.parseAsync(['node', 'fy', 'restart', ...argv]), gateway, io };
}

describe('restart command surface', () => {
  it('should map --outdated, --all, --cancel, ids and the idempotency key', async () => {
    // Arrange + Act
    const outdated = run(['--outdated', '--request-id', 'r1']);
    await outdated.parsed;
    const all = run(['--all']);
    await all.parsed;
    const named = run(['Wren', 'Fern']);
    await named.parsed;
    const cancel = run(['--cancel']);
    await cancel.parsed;

    // Assert
    should(outdated.gateway.requests).deepEqual([{ request: { scope: 'outdated', caller: 'ses-9' }, requestId: 'r1' }]);
    should(all.gateway.requests[0]?.request).deepEqual({ scope: 'all', caller: 'ses-9' });
    should(named.gateway.requests[0]?.request).deepEqual({ scope: 'ids', ids: ['Wren', 'Fern'], caller: 'ses-9' });
    should(cancel.gateway.cancels).equal(1);
  });

  it('should list what is out of date with no arguments', async () => {
    // Arrange + Act
    const { parsed, io } = run([]);
    await parsed;

    // Assert
    should(io.out[0]).equal('Out of date: 1');
  });
});
