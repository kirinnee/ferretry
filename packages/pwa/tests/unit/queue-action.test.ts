import { describe, expect, test } from 'bun:test';
import { QUEUE_ACTION_ID, queueContribution } from '../../src/features/queue-view/queue-action.ts';

describe('queueContribution', () => {
  test('is a run action in the session group that opens the queue, with a count only when something waits', () => {
    let opened = 0;
    const contribution = queueContribution(0, () => opened++);
    expect(contribution.group).toBe('session');
    const built = contribution.build(undefined as never) as {
      id: string;
      label: string;
      detail?: string;
      run: () => void;
    };
    expect(built.id).toBe(QUEUE_ACTION_ID);
    expect(built.label).toBe('Message queue');
    expect(built.detail).toBeUndefined();
    built.run();
    expect(opened).toBe(1);
    const busy = queueContribution(2, () => undefined).build(undefined as never) as { detail?: string };
    expect(busy.detail).toBe('2 waiting');
  });
});
