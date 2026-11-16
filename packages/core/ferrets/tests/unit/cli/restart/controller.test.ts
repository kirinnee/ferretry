import { describe, it } from 'bun:test';
import should from 'should';
import { RestartController } from '../../../../cli/lib/restart/controller.ts';
import { SessionCommandError } from '../../../../cli/lib/session/errors.ts';
import { RecordingRestartGateway, restartHarness } from './fixtures.ts';

const controller = (caller?: string, gateway = new RecordingRestartGateway()) => {
  const harness = restartHarness(gateway);
  return {
    ...harness,
    controller: new RestartController(harness.gateway, harness.presenter, caller),
  };
};

describe('RestartController', () => {
  it('should restart the outdated ferrets and say which went now and which wait', async () => {
    // Arrange
    const { controller: sut, gateway, io } = controller();

    // Act
    await sut.execute([], { outdated: true });

    // Assert
    should(gateway.requests).deepEqual([{ request: { scope: 'outdated' } }]);
    should(io.out).deepEqual([
      'Restarted now: 1',
      '  Wren (ses-1)',
      'Queued for their next idle moment: 3',
      '  Fern (ses-2): it is working; it restarts at its next idle moment',
      '  ses-3: a test run is open',
      '  ses-4: it is the session that asked; it restarts when its own turn ends',
      'Left alone: 1',
      '  ses-5: not outdated',
    ]);
  });

  it('should send every running ferret, with the caller', async () => {
    // Arrange
    const { controller: sut, gateway } = controller('ses-9');

    // Act
    await sut.execute([], { all: true });

    // Assert
    should(gateway.requests).deepEqual([{ request: { scope: 'all', caller: 'ses-9' } }]);
  });

  it('should restart the ferrets named', async () => {
    // Arrange
    const { controller: sut, gateway } = controller();

    // Act
    await sut.execute([' Wren ', 'Fern'], {});

    // Assert
    should(gateway.requests[0]?.request).deepEqual({ scope: 'ids', ids: ['Wren', 'Fern'] });
  });

  it('should print the result as JSON', async () => {
    // Arrange
    const { controller: sut, io } = controller();

    // Act
    await sut.execute([], { outdated: true, json: true });

    // Assert
    should(JSON.parse(io.out[0] ?? '')).have.property('queued');
  });

  it('should say when there is nothing to restart', async () => {
    // Arrange
    const empty = new RecordingRestartGateway({ restarted: [], queued: [], skipped: [], failed: [] });
    const { controller: sut, io } = controller(undefined, empty);

    // Act
    await sut.execute([], { outdated: true });

    // Assert
    should(io.out).deepEqual(['Nothing to restart.']);
  });

  it('should fail with exit 1 after printing when a restart failed', async () => {
    // Arrange
    const failing = new RecordingRestartGateway({
      restarted: [],
      queued: [],
      skipped: [],
      failed: [{ id: 'ses-1', reason: 'cannot resume' }],
    });
    const { controller: sut, io } = controller(undefined, failing);

    // Act
    const error = await sut.execute([], { all: true }).catch((caught: unknown) => caught);

    // Assert
    should(io.out).containEql('  ses-1: cannot resume');
    should(error).be.instanceOf(SessionCommandError);
    should((error as SessionCommandError).exitCode).equal(1);
  });

  it('should show what is out of date and waiting when nothing is named', async () => {
    // Arrange
    const { controller: sut, gateway, io } = controller();

    // Act
    await sut.execute([], {});

    // Assert
    should(gateway.requests).deepEqual([]);
    should(io.out).deepEqual([
      'Out of date: 1',
      '  Fern (ses-2): notify, pack',
      'Waiting to restart: 1',
      '  ses-3: it has work a restart would lose; it restarts once that is done',
      'Run `fy restart --outdated` to restart them.',
    ]);
  });

  it('should say when everything is current', async () => {
    // Arrange
    const current = new RecordingRestartGateway(undefined, { outdated: [], queued: [] });
    const { controller: sut, io } = controller(undefined, current);

    // Act
    await sut.execute([], {});

    // Assert
    should(io.out).deepEqual(['Every running ferret is up to date.']);
  });

  it('should clear the queue', async () => {
    // Arrange
    const { controller: sut, gateway, io } = controller();

    // Act
    await sut.execute([], { cancel: true });
    await sut.execute([], { cancel: true, json: true });

    // Assert
    should(gateway.cancels).equal(2);
    should(io.out[0]).equal('Cleared 2 waiting restarts.');
    should(JSON.parse(io.out[1] ?? '')).deepEqual({ cancelled: 2 });
  });

  it('should refuse a mix of modes and blank ids before any call', async () => {
    // Arrange
    const { controller: sut, gateway } = controller();

    // Act
    const results = await Promise.all([
      sut.execute([], { outdated: true, all: true }).catch((e: unknown) => e),
      sut.execute(['Wren'], { cancel: true }).catch((e: unknown) => e),
      sut.execute(['  '], {}).catch((e: unknown) => e),
    ]);

    // Assert
    for (const result of results) should((result as SessionCommandError).exitCode).equal(2);
    should(gateway.requests).deepEqual([]);
    should(gateway.cancels).equal(0);
  });
});
