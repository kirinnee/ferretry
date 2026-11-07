import { describe, it } from 'bun:test';
import should from 'should';
import {
  bootNotice,
  couldNotAutoResume,
  freshCandidates,
  stillOwed,
} from '../../../../src/lib/session/auto-resume/policy.ts';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const HOUR = 3_600_000;

describe('auto-resume policy', () => {
  it('should phrase a skip the way the app shows it', () => {
    should(couldNotAutoResume('the login expired')).equal("couldn't auto-resume: the login expired");
  });

  it('should owe a resume only to a session still sitting in failed', () => {
    should(stillOwed({ status: 'failed', mode: 'auto' })).equal(true);
    should(stillOwed({ status: 'stopped', mode: 'auto' })).equal(false);
    should(stillOwed({ status: 'completed', mode: 'interactive' })).equal(false);
    should(stillOwed({ status: 'running', mode: 'auto' })).equal(false);
    should(stillOwed(undefined)).equal(false);
  });

  it('should drop candidates older than the window and keep the newest record per session', () => {
    // Arrange
    const candidates = [
      { id: 'old', status: 'running', at: new Date(NOW - 30 * HOUR).toISOString() },
      { id: 'dup', status: 'running', at: new Date(NOW - 3 * HOUR).toISOString() },
      { id: 'dup', status: 'thinking', at: new Date(NOW - 1 * HOUR).toISOString() },
      { id: 'dup', status: 'waiting', at: new Date(NOW - 2 * HOUR).toISOString() },
      { id: 'garbled', status: 'running', at: 'not a date' },
    ];

    // Act
    const actual = freshCandidates(candidates, NOW, 24 * HOUR);

    // Assert
    should(actual).deepEqual([{ id: 'dup', status: 'thinking', at: new Date(NOW - HOUR).toISOString() }]);
  });

  it('should tell a mid-turn session that what it was running could not be checked', () => {
    for (const mode of ['auto', 'interactive'] as const) {
      const notice = bootNotice('tool_running', mode) ?? '';
      should(notice).startWith('Ferretry resumed you after the machine restarted mid-turn');
      should(notice).not.containEql('not from the owner');
    }
  });

  it('should send an idle auto session a nothing-was-interrupted notice', () => {
    should(bootNotice('awaiting_user', 'auto')).startWith(
      'Ferretry resumed you after the machine restarted, and nothing was interrupted.',
    );
  });

  it('should send an idle interactive session nothing, so it just gets its terminal back', () => {
    should(bootNotice('awaiting_user', 'interactive')).equal(undefined);
  });
});
