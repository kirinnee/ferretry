import { describe, it } from 'bun:test';
import { fixedClock } from '@ferretry/kernel/testing';
import should from 'should';
import { KeyedAgendaReplyTimers } from '../../../../daemon/adapters/agenda/keyed-agenda-reply-timers.ts';

describe('KeyedAgendaReplyTimers', () => {
  it('should run the latest task for a key once, and none that was replaced or cancelled', async () => {
    // Arrange
    const clock = fixedClock();
    const timers = new KeyedAgendaReplyTimers(clock);
    const ran: string[] = [];

    // Act
    timers.schedule('s1', 5, () => ran.push('replaced'));
    timers.schedule('s1', 5, () => ran.push('latest'));
    timers.schedule('s2', 5, () => ran.push('cancelled'));
    timers.cancel('s2');
    timers.cancel('never-scheduled');
    await clock.advance(4);
    const early = [...ran];
    await clock.advance(1);
    await clock.advance(60_000);

    // Assert
    should(early).be.empty();
    should(ran).deepEqual(['latest']);
  });

  it('should stop every pending task on close', async () => {
    // Arrange
    const clock = fixedClock();
    const timers = new KeyedAgendaReplyTimers(clock);
    const ran: string[] = [];
    timers.schedule('s1', 5, () => ran.push('s1'));
    timers.schedule('s2', 5, () => ran.push('s2'));

    // Act
    timers.close();
    await clock.advance(60_000);

    // Assert
    should(ran).be.empty();
  });
});
