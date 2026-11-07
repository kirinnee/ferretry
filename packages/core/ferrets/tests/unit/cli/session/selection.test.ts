import { describe, it } from 'bun:test';
import should from 'should';
import { selectSessions } from '../../../src/lib/session/selection.ts';
import { sessionView } from './session-fixtures.ts';

const running = sessionView({ id: 'ses-run', label: 'batch' }, { status: 'running' });
const parked = sessionView({ id: 'ses-park' }, { status: 'waiting' });
const done = sessionView({ id: 'ses-done', label: 'batch' }, { status: 'completed' });
const failed = sessionView({ id: 'ses-fail' }, { status: 'failed' });

describe('selectSessions', () => {
  it('should show every live session by default, including a parked one', () => {
    // Arrange / Act
    const actual = selectSessions([running, parked, done, failed]);

    // Assert
    should(actual.sessions.map(view => view.config.id)).deepEqual(['ses-run', 'ses-park']);
    should(actual.emptyMessage).be.undefined();
  });

  it('should include terminal sessions when asked for everything', () => {
    // Arrange / Act
    const actual = selectSessions([running, done, failed], { all: true });

    // Assert
    should(actual.sessions).have.length(3);
  });

  it('should filter by an exact ownership label before the liveness filter', () => {
    // Arrange / Act
    const actual = selectSessions([running, parked, done], { label: 'batch' });

    // Assert
    should(actual.sessions.map(view => view.config.id)).deepEqual(['ses-run']);
  });

  it('should point at --all when the label matched only terminal sessions', () => {
    // Arrange / Act
    const actual = selectSessions([done], { label: 'batch' });

    // Assert
    should(actual.sessions).be.empty();
    should(actual.emptyMessage).equal('no running sessions (use -a to show terminal ones)');
  });

  it('should say which label matched nothing rather than claiming there are no sessions', () => {
    // Arrange / Act
    const actual = selectSessions([running, parked], { label: 'other', all: true });

    // Assert
    should(actual.emptyMessage).equal('no sessions with label "other"');
  });

  it('should report an empty fleet plainly', () => {
    // Arrange / Act
    const actual = selectSessions([], { all: true });

    // Assert
    should(actual.emptyMessage).equal('no sessions');
  });
});
