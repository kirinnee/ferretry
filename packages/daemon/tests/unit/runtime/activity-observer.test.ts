import { describe, it } from 'bun:test';
import should from 'should';
import { ACTIVITY_NESTING, ActivityLedger, type ActivityScopePort } from '../../../src/lib/runtime/liveness.ts';

/** A scope a test controls: a stack instead of async-local storage, which a synchronous test does not need. */
function stackScope<T>(): ActivityScopePort<T> {
  const stack: T[] = [];
  return {
    current: () => stack.at(-1),
    within: <R>(value: T, work: () => R): R => {
      stack.push(value);
      try {
        return work();
      } finally {
        stack.pop();
      }
    },
  };
}

describe('ActivityLedger observer', () => {
  it('should tell the observer the label and wall time of an activity as it ends', () => {
    // Arrange
    let now = 100;
    const told: [string, number][] = [];
    const subject = new ActivityLedger({ now: () => now }, undefined, (label, wallMs) => told.push([label, wallMs]));
    const expected: [string, number][] = [['terminal reaper', 40]];

    // Act
    const end = subject.begin('terminal reaper');
    now = 140;
    end();

    // Assert
    should(told).deepEqual(expected);
  });

  it('should label a nested activity with its whole path', async () => {
    // Arrange
    let now = 0;
    const told: [string, number][] = [];
    const subject = new ActivityLedger({ now: () => now }, stackScope(), (label, wallMs) => told.push([label, wallMs]));
    const expected: [string, number][] = [
      [`fleet refresh${ACTIVITY_NESTING}read index`, 5],
      ['fleet refresh', 12],
    ];

    // Act
    await subject.run('fleet refresh', async () => {
      now = 2;
      await subject.run('read index', () => {
        now = 7;
      });
      now = 12;
    });

    // Assert
    should(told).deepEqual(expected);
  });

  it('should report an activity once however many times it is ended', () => {
    // Arrange
    const told: string[] = [];
    const subject = new ActivityLedger({ now: () => 0 }, undefined, label => told.push(label));
    const end = subject.begin('self-check');

    // Act
    end();
    end();

    // Assert
    should(told).deepEqual(['self-check']);
  });
});

describe('ActivityLedger current', () => {
  it('should name the innermost running activity, with its nesting, and nothing outside any', async () => {
    // Arrange
    const subject = new ActivityLedger({ now: () => 0 }, stackScope());
    const seen: (string | undefined)[] = [];

    // Act
    seen.push(subject.current());
    await subject.run('fleet refresh', async () => {
      seen.push(subject.current());
      await subject.run('runtime homes', () => {
        seen.push(subject.current());
      });
    });
    seen.push(subject.current());

    // Assert
    should(seen).deepEqual([undefined, 'fleet refresh', `fleet refresh${ACTIVITY_NESTING}runtime homes`, undefined]);
  });
});
