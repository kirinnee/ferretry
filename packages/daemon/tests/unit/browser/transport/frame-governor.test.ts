import { describe, it } from 'bun:test';
import should from 'should';
import {
  BrowserFrameGovernor,
  type FrameClock,
  type FrameSink,
  type FrameTimer,
  MAX_HELD_FRAME_ACKNOWLEDGEMENTS,
  MIN_FRAME_INTERVAL_MS,
} from '../../../../src/lib/index.ts';

class FakeClock implements FrameClock {
  private current = 1_000;
  private due?: { readonly at: number; readonly callback: () => void };
  cancellations = 0;

  now(): number {
    return this.current;
  }

  schedule(callback: () => void, delayMs: number): FrameTimer {
    this.due = { at: this.current + delayMs, callback };
    return {
      cancel: () => {
        this.cancellations += 1;
        this.due = undefined;
      },
    };
  }

  get armedDelay(): number | undefined {
    return this.due === undefined ? undefined : this.due.at - this.current;
  }

  /** Advances time and fires the armed timer when it comes due. */
  advance(ms: number): void {
    this.current += ms;
    const due = this.due;
    if (due === undefined || due.at > this.current) return;
    this.due = undefined;
    due.callback();
  }
}

class FakeSink implements FakeSinkShape {
  written: string[] = [];
  acceptNext = true;
  drainListeners = 0;
  private listener?: () => void;

  write(frame: string): boolean {
    this.written.push(frame);
    return this.acceptNext;
  }

  watchDrain(listener: () => void): () => void {
    this.drainListeners += 1;
    this.listener = listener;
    return () => {
      this.drainListeners -= 1;
      this.listener = undefined;
    };
  }

  drain(): void {
    this.acceptNext = true;
    this.listener?.();
  }
}

interface FakeSinkShape extends FrameSink<string> {
  write(frame: string): boolean;
}

/** A sink with no drain signal at all — the case that used to stall the stream forever. */
class DrainlessSink implements FrameSink<string> {
  written: string[] = [];
  acceptNext = true;

  write(frame: string): boolean {
    this.written.push(frame);
    return this.acceptNext;
  }
}

function build(options: Parameters<typeof buildGovernor>[0] = {}) {
  return buildGovernor(options);
}

function buildGovernor(options: {
  readonly minIntervalMs?: number;
  readonly maxHeldAcknowledgements?: number;
  readonly onAcknowledgementRejected?: (session: string) => void;
}) {
  const clock = new FakeClock();
  const sink = new FakeSink();
  const governor = new BrowserFrameGovernor<string>(clock, sink, options);
  return { clock, sink, governor };
}

describe('browser frame governor', () => {
  it('should emit the first frame immediately and acknowledge it', () => {
    // Arrange
    const { sink, governor } = build();
    let acknowledged = 0;

    // Act
    governor.bind('session-1');
    governor.capture('session-1', 'frame-1', () => {
      acknowledged += 1;
    });

    // Assert
    should(sink.written).deepEqual(['frame-1']);
    should(acknowledged).equal(1);
    should(governor.snapshot().heldAcknowledgements).equal(0);
  });

  it('should pace later frames to the minimum interval and emit only the newest', () => {
    // Arrange
    const { clock, sink, governor } = build();
    governor.bind('session-1');
    governor.capture('session-1', 'frame-1', () => undefined);

    // Act: two more frames arrive well inside one interval.
    clock.advance(10);
    governor.capture('session-1', 'frame-2', () => undefined);
    clock.advance(10);
    governor.capture('session-1', 'frame-3', () => undefined);

    // Assert: nothing emitted yet, and the stale frame was replaced rather than queued.
    should(sink.written).deepEqual(['frame-1']);
    should(governor.snapshot().pendingFrame).equal('frame-3');
    should(clock.armedDelay).equal(MIN_FRAME_INTERVAL_MS - 20);

    // Act
    clock.advance(MIN_FRAME_INTERVAL_MS - 20);

    // Assert
    should(sink.written).deepEqual(['frame-1', 'frame-3']);
    should(governor.snapshot().pendingFrame).be.undefined();
  });

  it('should hold acknowledgements while the sink is blocked and release them on drain', () => {
    // Arrange
    const { clock, sink, governor } = build();
    const acknowledged: string[] = [];
    governor.bind('session-1');
    sink.acceptNext = false;

    // Act: the first write is accepted but blocks the sink.
    governor.capture('session-1', 'frame-1', () => void acknowledged.push('frame-1'));

    // Assert
    should(sink.written).deepEqual(['frame-1']);
    should(acknowledged).deepEqual([]);
    should(sink.drainListeners).equal(1);
    should(governor.snapshot().sinkWritable).be.false();

    // Act: frames keep arriving while blocked; no timer races the drain edge.
    clock.advance(500);
    governor.capture('session-1', 'frame-2', () => void acknowledged.push('frame-2'));
    clock.advance(500);
    governor.capture('session-1', 'frame-3', () => void acknowledged.push('frame-3'));

    // Assert
    should(sink.written).deepEqual(['frame-1']);
    should(governor.snapshot().timerArmed).be.false();
    should(governor.snapshot().heldAcknowledgements).equal(3);

    // Act
    sink.drain();

    // Assert: the freshest frame is painted and every held acknowledgement is released.
    should(sink.written).deepEqual(['frame-1', 'frame-3']);
    should(acknowledged).deepEqual(['frame-1', 'frame-2', 'frame-3']);
    should(sink.drainListeners).equal(0);
  });

  it('should release held acknowledgements on drain even when no frame is waiting', () => {
    // Arrange
    const { sink, governor } = build();
    const acknowledged: string[] = [];
    governor.bind('session-1');
    sink.acceptNext = false;
    governor.capture('session-1', 'frame-1', () => void acknowledged.push('frame-1'));

    // Act
    sink.drain();

    // Assert
    should(acknowledged).deepEqual(['frame-1']);
    should(sink.written).deepEqual(['frame-1']);
  });

  it('should refuse a frame that would exceed the acknowledgement window and ask for a rebind', () => {
    // Arrange
    const rejected: string[] = [];
    const { sink, governor } = build({ onAcknowledgementRejected: session => void rejected.push(session) });
    governor.bind('session-1');
    sink.acceptNext = false;

    // Act
    for (let index = 0; index <= MAX_HELD_FRAME_ACKNOWLEDGEMENTS; index += 1) {
      governor.capture('session-1', `frame-${index}`, () => undefined);
    }

    // Assert: the window stays at its ceiling and the refused frame is not retained.
    should(governor.snapshot().heldAcknowledgements).equal(MAX_HELD_FRAME_ACKNOWLEDGEMENTS);
    should(governor.snapshot().pendingFrame).equal(`frame-${MAX_HELD_FRAME_ACKNOWLEDGEMENTS - 1}`);
    should(rejected).deepEqual(['session-1']);

    // Act: a further overflow reports once per session, not once per frame.
    governor.capture('session-1', 'frame-extra', () => undefined);

    // Assert
    should(rejected).deepEqual(['session-1']);
  });

  it('should report a rejected acknowledgement whether it throws or rejects', async () => {
    // Arrange
    const rejected: string[] = [];
    const { governor } = build({ onAcknowledgementRejected: session => void rejected.push(session) });
    governor.bind('throwing');

    // Act
    governor.capture('throwing', 'frame-1', () => {
      throw new Error('cdp session detached');
    });

    // Assert
    should(rejected).deepEqual(['throwing']);

    // Arrange
    const asynchronous = build({ onAcknowledgementRejected: session => void rejected.push(session) });
    asynchronous.governor.bind('async');

    // Act
    asynchronous.governor.capture('async', 'frame-1', () => Promise.reject(new Error('detached')));
    await Promise.resolve();
    await Promise.resolve();

    // Assert
    should(rejected).deepEqual(['throwing', 'async']);
  });

  it('should survive a recovery hook that throws', () => {
    // Arrange
    const { governor } = build({
      onAcknowledgementRejected: () => {
        throw new Error('rebind failed');
      },
    });
    governor.bind('session-1');

    // Act & Assert
    should(() =>
      governor.capture('session-1', 'frame-1', () => {
        throw new Error('detached');
      }),
    ).not.throw();
  });

  it('should ignore frames from a session it is not bound to', () => {
    // Arrange
    const { sink, governor } = build();
    governor.bind('session-1');

    // Act
    governor.capture('session-2', 'stale', () => undefined);

    // Assert
    should(sink.written).deepEqual([]);
    should(governor.snapshot()).deepEqual({
      activeSession: 'session-1',
      heldAcknowledgements: 0,
      timerArmed: false,
      sinkWritable: true,
    });
  });

  it('should discard a rebound session state but keep the pending sink pressure', () => {
    // Arrange
    const { clock, sink, governor } = build();
    const acknowledged: string[] = [];
    governor.bind('session-1');
    sink.acceptNext = false;
    governor.capture('session-1', 'old-frame', () => void acknowledged.push('old-frame'));

    // Act
    governor.bind('session-2');

    // Assert: the previous session's retained state is gone, the sink is still known to be blocked.
    should(governor.snapshot().sinkWritable).be.false();
    should(governor.snapshot().heldAcknowledgements).equal(0);
    should(governor.snapshot().lastOutputAt).be.undefined();

    // Act: the new session's frame waits for the drain that the old session's write is owed.
    governor.capture('session-2', 'new-frame', () => void acknowledged.push('new-frame'));
    clock.advance(1_000);
    sink.drain();

    // Assert
    should(sink.written).deepEqual(['old-frame', 'new-frame']);
    should(acknowledged).deepEqual(['new-frame']);
  });

  it('should drop a timer whose session was rebound before it fired', () => {
    // Arrange
    const { clock, sink, governor } = build();
    governor.bind('session-1');
    governor.capture('session-1', 'frame-1', () => undefined);
    clock.advance(1);
    governor.capture('session-1', 'frame-2', () => undefined);

    // Act: rebind cancels the armed timer, then a fresh capture arms a new one.
    governor.bind('session-1');
    governor.capture('session-1', 'frame-3', () => undefined);

    // Assert
    should(clock.cancellations).equal(1);
    should(sink.written).deepEqual(['frame-1', 'frame-3']);
  });

  it('should stop governing on stop and dispose the drain subscription on dispose', () => {
    // Arrange
    const { clock, sink, governor } = build();
    governor.bind('session-1');
    sink.acceptNext = false;
    governor.capture('session-1', 'frame-1', () => undefined);

    // Act
    governor.stop();

    // Assert: the session is gone but the sink subscription remains, since the sink outlives it.
    should(governor.snapshot().activeSession).be.undefined();
    should(sink.drainListeners).equal(1);

    // Act
    governor.dispose();

    // Assert
    should(sink.drainListeners).equal(0);
    should(governor.snapshot()).deepEqual({ heldAcknowledgements: 0, timerArmed: false, sinkWritable: false });

    // Act: a drain after disposal must not resurrect a released listener.
    sink.drain();
    clock.advance(1_000);

    // Assert
    should(sink.written).deepEqual(['frame-1']);
  });

  it('should not stall forever behind a sink that cannot signal recovery', () => {
    // Arrange
    const clock = new FakeClock();
    const sink = new DrainlessSink();
    const governor = new BrowserFrameGovernor<string>(clock, sink, { minIntervalMs: 10 });
    sink.acceptNext = false;
    governor.bind('session-1');

    // Act
    governor.capture('session-1', 'frame-1', () => undefined);
    clock.advance(10);
    governor.capture('session-1', 'frame-2', () => undefined);
    clock.advance(10);

    // Assert: pacing continues, so a drain-less sink degrades to interval writes rather than a stall.
    should(sink.written).deepEqual(['frame-1', 'frame-2']);
    should(governor.snapshot().sinkWritable).be.true();
  });

  it('should ignore a drain listener that fires synchronously during subscription', () => {
    // Arrange: a sink that reports recovery before handing back its disposer.
    const clock = new FakeClock();
    let disposals = 0;
    const sink: FrameSink<string> = {
      write: () => false,
      watchDrain: listener => {
        listener();
        return () => {
          disposals += 1;
        };
      },
    };
    const governor = new BrowserFrameGovernor<string>(clock, sink, {});
    governor.bind('session-1');

    // Act
    governor.capture('session-1', 'frame-1', () => undefined);

    // Assert
    should(disposals).equal(1);
    should(governor.snapshot().sinkWritable).be.true();
    should(governor.snapshot().heldAcknowledgements).equal(0);
  });

  it('should clamp its options to sane floors', () => {
    // Arrange
    const clock = new FakeClock();
    const sink = new FakeSink();
    const governor = new BrowserFrameGovernor<string>(clock, sink, {
      minIntervalMs: -50,
      maxHeldAcknowledgements: 0,
    });
    governor.bind('session-1');
    sink.acceptNext = false;

    // Act: with a zero interval every frame flushes at once; the ack window still holds one.
    governor.capture('session-1', 'frame-1', () => undefined);
    governor.capture('session-1', 'frame-2', () => undefined);

    // Assert
    should(sink.written).deepEqual(['frame-1']);
    should(governor.snapshot().heldAcknowledgements).equal(1);
  });
});
