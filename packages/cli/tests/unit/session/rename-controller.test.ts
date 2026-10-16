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

  it('should refuse a first name that matches more than one session, naming their ids', async () => {
    // Arrange
    const { api, subject } = controller({
      list: [sessionView({ id: 'ses-1', teammate: 'mary-jane' }), sessionView({ id: 'ses-2', teammate: 'Mary-Jane' })],
    });

    // Act
    const failure = await subject.execute('MARY-JANE', 'marin').catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).equal('Mary-Jane names 2 sessions (ses-1, ses-2); rename by id');
    should(api.methods()).deepEqual(['list']);
  });

  it('should pass an unknown reference through so the daemon answers for it', async () => {
    // Arrange
    const renamed = sessionView({ id: 'ses-9', name: 'Untitled' });
    const { api, io, subject } = controller({ list: [], rename: renamed });

    // Act
    await subject.execute('ses-9', 'marin');

    // Assert
    should(api.calls[1]).deepEqual({ method: 'rename', args: ['ses-9', undefined, 'marin'] });
    should(io.out).deepEqual(['renamed ses-9: Untitled']);
  });

  it('should show the new first name title-cased after a rename', async () => {
    // Arrange
    const renamed = sessionView({ teammate: 'mary-jane' });
    const { io, subject } = controller({ list: [sessionView()], rename: renamed });

    // Act
    await subject.execute('ses-1', 'Mary-Jane');

    // Assert
    should(io.out).deepEqual(['renamed ses-1: Mary-Jane — Fix Transcript Scrolling']);
  });
});
