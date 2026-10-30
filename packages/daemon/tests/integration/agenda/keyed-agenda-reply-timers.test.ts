import { describe, it } from 'bun:test';
import should from 'should';
import { KeyedAgendaReplyTimers } from '../../../src/adapters/agenda/keyed-agenda-reply-timers.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * Waits until a sentinel timer, set LAST with the same delay, has run. Timers of equal delay expire in the order
 * they were set, so every task that was going to run has run by then: a task absent from the log never will.
 */
async function afterTheTimers(timers: KeyedAgendaReplyTimers): Promise<void> {
  let reached = false;
  timers.schedule('sentinel', 5, () => {
    reached = true;
  });
  await waitFor(() => reached, 'the sentinel timer, set after the others, to run');
}

describe('KeyedAgendaReplyTimers', () => {
  it('should run the latest task for a key once, and none that was replaced or cancelled', async () => {
    // Arrange
    const timers = new KeyedAgendaReplyTimers();
    const ran: string[] = [];

    // Act
    timers.schedule('s1', 5, () => ran.push('replaced'));
    timers.schedule('s1', 5, () => ran.push('latest'));
    timers.schedule('s2', 5, () => ran.push('cancelled'));
    timers.cancel('s2');
    timers.cancel('never-scheduled');
    await afterTheTimers(timers);

    // Assert
    should(ran).deepEqual(['latest']);
  });

  it('should stop every pending task on close', async () => {
    // Arrange
    const timers = new KeyedAgendaReplyTimers();
    const ran: string[] = [];
    timers.schedule('s1', 5, () => ran.push('s1'));
    timers.schedule('s2', 5, () => ran.push('s2'));

    // Act
    timers.close();
    await afterTheTimers(timers);

    // Assert
    should(ran).be.empty();
  });
});
