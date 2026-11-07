import { describe, it } from 'bun:test';
import should from 'should';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';
import { RenameSessionController } from '../../../src/lib/session/rename-controller.ts';
import { capturedPresenter, RecordingApi } from './controller-doubles.ts';
import { sessionView } from './session-fixtures.ts';

function controller(responses: ConstructorParameters<typeof RecordingApi>[0]) {
  const api = new RecordingApi(responses);
  const { io, presenter } = capturedPresenter();
  return { api, io, subject: new RenameSessionController(api, presenter) };
}

describe('RenameSessionController', () => {
  it('should refuse a rename that names neither a first name nor a title', async () => {
    // Arrange
    const { api, subject } = controller({});

    // Act
    const failure = await subject.execute('ses-1', '  ', { title: ' ' }).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(SessionCommandError);
    should((failure as Error).message).equal('give a new name, a new --title, or both');
    should(api.calls).be.empty();
  });

  it('should refuse a first name outside the grammar before calling the daemon', async () => {
    // Arrange
    const { api, subject } = controller({});

    // Act
    const failure = await subject.execute('ses-1', 'Mary Jane').catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(SessionCommandError);
    should((failure as Error).message).match(/letters, digits or hyphens/);
    should(api.calls).be.empty();
  });

  it('should send a first name to the daemon as typed, which resolves it like any session route', async () => {
    // Arrange — the daemon owns the name rule, so the CLI no longer lists the fleet to guess at it.
    const renamed = sessionView({ id: 'ses-1', teammate: 'marin' });
    const { api, subject } = controller({ rename: renamed });

    // Act
    await subject.execute(' MARY-JANE ', 'marin');

    // Assert
    should(api.calls).deepEqual([{ method: 'rename', args: ['MARY-JANE', undefined, 'marin'] }]);
  });

  it('should pass an unknown reference through so the daemon answers for it', async () => {
    // Arrange
    const renamed = sessionView({ id: 'ses-9', name: 'Untitled' });
    const { api, io, subject } = controller({ rename: renamed });

    // Act
    await subject.execute('ses-9', 'marin');

    // Assert
    should(api.calls[0]).deepEqual({ method: 'rename', args: ['ses-9', undefined, 'marin'] });
    should(io.out).deepEqual(['renamed ses-9: Untitled']);
  });

  it('should show the new first name title-cased after a rename', async () => {
    // Arrange
    const renamed = sessionView({ teammate: 'mary-jane' });
    const { io, subject } = controller({ rename: renamed });

    // Act
    await subject.execute('ses-1', 'Mary-Jane');

    // Assert
    should(io.out).deepEqual(['renamed ses-1: Mary-Jane — Fix Transcript Scrolling']);
  });
});
