import { describe, it } from 'bun:test';
import should from 'should';
import { isTmuxServerAbsent } from '../../../src/lib/tmux/server-absent.ts';

describe('whether tmux refused because no server is running', () => {
  it.each([
    'error connecting to /tmp/fy-home/tmux.sock (No such file or directory)',
    'no server running on /tmp/fy-home/tmux.sock',
    'failed to connect to server',
  ])('should read %s as no server', stderr => {
    should(isTmuxServerAbsent(stderr)).be.true();
  });

  it.each([
    'error connecting to /tmp/fy-home/tmux.sock (Permission denied)',
    // A server that answered, then went away mid-request: a race, not absence.
    'server exited unexpectedly',
    "can't find session: fy-123",
    'unknown command: lsit-sessions',
    '',
  ])('should not read %s as no server', stderr => {
    should(isTmuxServerAbsent(stderr)).be.false();
  });
});
