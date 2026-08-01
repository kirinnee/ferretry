import { describe, it } from 'bun:test';
import should from 'should';
import { MigrationController } from '../../../src/lib/migration/controller.ts';
import { migrationHarness } from './fixtures.ts';

describe('session migration', () => {
  it('should trim and pass the complete migration request through the daemon gate', async () => {
    // Arrange
    const { gateway, io, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('  Fable  ', {
      agent: '  codex-secondary  ',
      model: '  gpt-5.6-sol  ',
      allowContextDowngrade: true,
      requestId: '  logical-move-1  ',
    });

    // Assert
    should(gateway.calls).deepEqual([
      {
        id: 'Fable',
        agent: 'codex-secondary',
        model: 'gpt-5.6-sol',
        allowContextDowngrade: true,
        requestId: 'logical-move-1',
      },
    ]);
    should(io.out[0]).containEql('codex-secondary');
  });

  it('should omit blank optional models and let the client mint an idempotency key', async () => {
    // Arrange
    const { gateway, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('ses-1', { agent: 'codex-secondary', model: '   ' });

    // Assert
    should(gateway.calls).deepEqual([{ id: 'ses-1', agent: 'codex-secondary', allowContextDowngrade: false }]);
  });

  it('should print the schema-parsed session under --json', async () => {
    // Arrange
    const { gateway, io, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act
    await subject.execute('ses-1', { agent: 'codex-secondary', json: true });

    // Assert
    should(JSON.parse(io.out[0] ?? '')).have.properties('config', 'state', 'directory');
  });

  it('should reject blank required values before the destructive call', async () => {
    // Arrange
    const { gateway, presenter } = migrationHarness();
    const subject = new MigrationController(gateway, presenter);

    // Act + Assert
    await should(subject.execute('   ', { agent: 'codex-secondary' })).be.rejectedWith(
      'a session id or callsign is required',
    );
    await should(subject.execute('ses-1', { agent: '   ' })).be.rejectedWith('--agent must name a fleet account');
    await should(subject.execute('ses-1', { agent: 'codex-secondary', requestId: '   ' })).be.rejectedWith(
      '--request-id must not be blank',
    );
    should(gateway.calls).be.empty();
  });
});
