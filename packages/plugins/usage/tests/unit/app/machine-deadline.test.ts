import { describe, expect, it } from 'bun:test';
import {
  type DeadlineSchedule,
  MACHINE_READ_DEADLINE_MS,
  realSchedule,
  withDeadline,
} from '../../../app/lib/machine-deadline.ts';

/** A schedule the test fires by hand, recording whether it was cancelled. */
function handSchedule() {
  const state = { delay: -1, cancelled: false, fire: () => {} };
  const schedule: DeadlineSchedule = (run, delayMs) => {
    state.delay = delayMs;
    state.fire = run;
    return () => {
      state.cancelled = true;
    };
  };
  return { state, schedule };
}

describe('withDeadline', () => {
  it('should answer what the read answered, and cancel the timer', async () => {
    const { state, schedule } = handSchedule();
    expect(await withDeadline(Promise.resolve('answer'), 5_000, schedule)).toBe('answer');
    expect(state.delay).toBe(5_000);
    expect(state.cancelled).toBe(true);
  });

  it('should pass on the read’s own failure, and cancel the timer', async () => {
    const { state, schedule } = handSchedule();
    await expect(withDeadline(Promise.reject(new Error('refused')), 5_000, schedule)).rejects.toThrow('refused');
    expect(state.cancelled).toBe(true);
  });

  it('should give up waiting at the deadline with a plain sentence, and swallow the late answer', async () => {
    const { state, schedule } = handSchedule();
    let late: (value: string) => void = () => {};
    const bounded = withDeadline(new Promise<string>(resolve => (late = resolve)), 20_000, schedule);
    state.fire();
    const error = await bounded.then(
      () => undefined,
      (caught: unknown) => caught as Error & { deadlineMs: number },
    );
    expect(error?.message).toBe('did not answer within 20s');
    expect(error?.name).toBe('MachineDeadlineError');
    expect(error?.deadlineMs).toBe(20_000);
    late('too late');
  });

  it('should default to twenty seconds on the browser clock', async () => {
    expect(MACHINE_READ_DEADLINE_MS).toBe(20_000);
    const cancel = realSchedule(() => {}, 60_000);
    expect(typeof cancel).toBe('function');
    cancel();
    expect(await withDeadline(Promise.resolve(1))).toBe(1);
  });
});
