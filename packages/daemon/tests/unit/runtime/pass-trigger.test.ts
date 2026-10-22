import { describe, it } from 'bun:test';
import should from 'should';
import { PassTrigger, type PassTriggerTimers } from '../../../src/lib/runtime/pass-trigger.ts';

/** Timers on a hand-moved clock: {@link advance} fires every timer that falls due. */
class ManualTimers implements PassTriggerTimers {
  now = 0;
  private next = 1;
  private readonly armed = new Map<number, { readonly at: number; readonly callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next;
    this.next += 1;
    this.armed.set(handle, { at: this.now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.armed.delete(handle as number);
  }

  /** How many timers are armed now. */
  get pending(): number {
    return this.armed.size;
  }

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.armed.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      this.now = due[1].at;
      this.armed.delete(due[0]);
      due[1].callback();
    }
    this.now = until;
  }
}

function trigger(backstopMs = 1_000) {
  const timers = new ManualTimers();
  const passes: number[] = [];
  const subject = new PassTrigger({ backstopMs, timers, now: () => timers.now });
  return { subject, timers, passes, due: () => passes.push(timers.now) };
}

describe('PassTrigger', () => {
  it('should run a pass one backstop after arming, and every backstop after that', () => {
    // Arrange
    const { subject, timers, passes, due } = trigger();

    // Act
    subject.arm(due);
    timers.advance(2_500);

    // Assert
    should(passes).deepEqual([1_000, 2_000]);
  });

  it('should bring a pass forward on a nudge, and count the backstop from that pass', () => {
    // Arrange
    const { subject, timers, passes, due } = trigger();
    subject.arm(due);

    // Act
    timers.advance(100);
    subject.nudge(50);
    timers.advance(1_200);

    // Assert
    should(passes).deepEqual([150, 1_150]);
  });

  it('should keep the earlier pass when a later nudge arrives, so a burst is one pass', () => {
    // Arrange
    const { subject, timers, passes, due } = trigger();
    subject.arm(due);

    // Act
    subject.nudge(30);
    subject.nudge(300);
    subject.nudge(-5);
    timers.advance(400);

    // Assert — the negative nudge means "now"; the rest joined it.
    should(passes).deepEqual([0]);
  });

  it('should keep the earliest nudge heard before arming for the arming', () => {
    // Arrange
    const { subject, timers, passes, due } = trigger();

    // Act
    subject.nudge(500);
    subject.nudge(200);
    subject.nudge(800);
    subject.arm(due);
    timers.advance(300);

    // Assert
    should(passes).deepEqual([200]);
  });

  it('should let a pass nudge the next one', () => {
    // Arrange
    const { subject, timers, passes } = trigger();
    subject.arm(() => {
      passes.push(timers.now);
      if (passes.length === 1) subject.nudge(10);
    });

    // Act
    subject.nudge(0);
    timers.advance(20);

    // Assert
    should(passes).deepEqual([0, 10]);
  });

  it('should fire nothing and ignore nudges once disarmed', () => {
    // Arrange
    const { subject, timers, passes, due } = trigger();
    const disarm = subject.arm(due);

    // Act
    disarm();
    subject.nudge(0);
    timers.advance(5_000);

    // Assert
    should(passes).be.empty();
    should(timers.pending).equal(0);
  });

  it('should not run a pass whose timer fires after the disarm', () => {
    // Arrange — a timer source that cannot cancel.
    const fired: (() => void)[] = [];
    const passes: string[] = [];
    const subject = new PassTrigger({
      backstopMs: 1_000,
      timers: { setTimeout: callback => fired.push(callback), clearTimeout: () => undefined },
      now: () => 0,
    });
    const disarm = subject.arm(() => passes.push('pass'));

    // Act
    disarm();
    for (const callback of fired) callback();

    // Assert
    should(passes).be.empty();
  });
});
