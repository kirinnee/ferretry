import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerMigrationCommands } from '../../../src/lib/migration/commands.ts';
import { MigrationController } from '../../../src/lib/migration/controller.ts';
import { migrationHarness } from './fixtures.ts';

function run(argv: string[]) {
  const { gateway, io, presenter } = migrationHarness();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerMigrationCommands(program, new MigrationController(gateway, presenter));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, io };
}

describe('migration command surface', () => {
  it('should map every daemon-supported migration option', async () => {
    // Arrange + Act
    const { parsed, gateway, io } = run([
      'migrate',
      'Fable',
      '--agent',
      'codex-secondary',
      '--model',
      'gpt-5.6-sol',
      '--allow-context-downgrade',
      '--request-id',
      'move-1',
      '--json',
    ]);
    await parsed;

    // Assert
    should(gateway.calls[0]).deepEqual({
      id: 'Fable',
      agent: 'codex-secondary',
      model: 'gpt-5.6-sol',
      allowContextDowngrade: true,
      requestId: 'move-1',
    });
    should(JSON.parse(io.out[0] ?? '')).have.property('config');
  });

  it('should require the target account', async () => {
    // Arrange + Act + Assert
    await should(run(['migrate', 'Fable']).parsed).be.rejected();
  });

  it('should not offer kteam force-inflight against a daemon route with no force path', async () => {
    // Arrange + Act + Assert
    await should(run(['migrate', 'Fable', '--agent', 'codex-secondary', '--force-inflight']).parsed).be.rejected();
  });
});
