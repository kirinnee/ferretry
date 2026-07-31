import { describe, it } from 'bun:test';
import should from 'should';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';
import { capturedPresenter } from './controller-doubles.ts';
import { sessionView } from './session-fixtures.ts';

describe('SessionPresenter', () => {
  it('should print the detail block on stdout', () => {
    // Arrange
    const { io, presenter } = capturedPresenter();

    // Act
    presenter.view(sessionView());

    // Assert
    should(io.out[0]).startWith('- (ses-1)');
    should(io.err).be.empty();
  });

  it('should print indented JSON when asked', () => {
    // Arrange
    const { io, presenter } = capturedPresenter();

    // Act
    presenter.view(sessionView(), true);

    // Assert
    should(io.out.join('\n')).match(/^\{\n {2}"config"/);
  });

  it('should keep notes on stderr so stdout stays machine-readable', () => {
    // Arrange
    const { io, presenter } = capturedPresenter();

    // Act
    presenter.note('note: still launching');

    // Assert
    should(io.out).be.empty();
    should(io.err).deepEqual(['note: still launching']);
  });

  it('should report a usage mistake with exit code 2', () => {
    // Arrange
    const { io, presenter } = capturedPresenter();

    // Act
    presenter.fail(new SessionCommandError('you typed it wrong'));

    // Assert
    should(io.err).deepEqual(['you typed it wrong']);
    should(io.exitCode).equal(2);
  });

  it('should report any other failure with exit code 1', () => {
    // Arrange
    const { io, presenter } = capturedPresenter();

    // Act
    presenter.fail(new Error('connection refused'));

    // Assert
    should(io.err).deepEqual(['connection refused']);
    should(io.exitCode).equal(1);
  });

  it('should report a thrown non-error without losing what it said', () => {
    // Arrange
    const { io, presenter } = capturedPresenter();

    // Act
    presenter.fail('the daemon closed the socket');

    // Assert
    should(io.err).deepEqual(['the daemon closed the socket']);
    should(io.exitCode).equal(1);
  });

  it('should carry an explicit exit code from the domain error', () => {
    // Arrange
    const { io, presenter } = capturedPresenter();

    // Act
    presenter.fail(new SessionCommandError('the daemon refused', 1));

    // Assert
    should(io.exitCode).equal(1);
  });
});
