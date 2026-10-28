import { describe, it } from 'bun:test';
import should from 'should';
import { KeyedAttentionReplyTimers } from '../../../src/adapters/attention/keyed-attention-reply-timers.ts';

const after = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms));

describe('KeyedAttentionReplyTimers', () => {
  it('should run the latest task for a key once, and none that was replaced or cancelled', async () => {
    // Arrange
    const timers = new KeyedAttentionReplyTimers();
    const ran: string[] = [];

    // Act
    timers.schedule('s1', 5, () => ran.push('replaced'));
    timers.schedule('s1', 5, () => ran.push('latest'));
    timers.schedule('s2', 5, () => ran.push('cancelled'));
    timers.cancel('s2');
    timers.cancel('never-scheduled');
    await after(30);

    // Assert
    should(ran).deepEqual(['latest']);
  });

  it('should stop every pending task on close', async () => {
    // Arrange
    const timers = new KeyedAttentionReplyTimers();
    const ran: string[] = [];
    timers.schedule('s1', 5, () => ran.push('s1'));
    timers.schedule('s2', 5, () => ran.push('s2'));

    // Act
    timers.close();
    await after(30);

    // Assert
    should(ran).be.empty();
  });
});
