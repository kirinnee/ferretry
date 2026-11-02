import { describe, it } from 'bun:test';
import should from 'should';
import { cutOffResume } from '../../../../src/lib/session/resume/cut-off.ts';

/** A session a person cut off (`fy session revoke-credential`) comes back only when a person resumes it. */
describe('resuming a session a person cut off', () => {
  it('should restore it for a person, at the CLI or in the app', () => {
    should([cutOffResume(true, 'admin-cli'), cutOffResume(true, 'admin-ui')]).deepEqual(['restore', 'restore']);
  });

  it('should restore it for the owner in the app on a paired device (C4): "Resume session" is a person asking', () => {
    should(cutOffResume(true, 'device')).equal('restore');
  });

  it('should refuse every other reviver: a peer, the Warden, the daemon itself, or anyone it cannot name', () => {
    for (const actor of ['peer', 'warden', 'daemon', 'unknown'] as const)
      should({ actor, answer: cutOffResume(true, actor) }).deepEqual({ actor, answer: 'refuse' });
  });

  it('should leave a session nobody cut off exactly as it was', () => {
    should(cutOffResume(false, 'peer')).equal('proceed');
    should(cutOffResume(false, 'admin-cli')).equal('proceed');
  });
});
