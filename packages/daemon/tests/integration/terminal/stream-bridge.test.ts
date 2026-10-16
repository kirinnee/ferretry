import { describe, it } from 'bun:test';
import should from 'should';
import {
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  type TerminalStreamService,
  type TerminalStreamTimer,
} from '../../../src/adapters/index.ts';
import {
  TERMINAL_INPUT_REDRAW_MS,
  TERMINAL_MAX_BUFFERED_OUTPUT_BYTES,
  TERMINAL_REDRAW_POLL_MS,
} from '../../../src/lib/index.ts';

class FakeService implements TerminalStreamService {
  readonly calls: string[] = [];
  fail = false;
  /** Suspends the next `capture`, so a test can decide what happens WHILE one is in flight. */
  private held: (() => void) | undefined;
  holding = false;
  release(): void {
    this.holding = false;
    this.held?.();
    this.held = undefined;
  }
  async write(_sessionId: string, _terminalId: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`write:${[...bytes].join(',')}`);
    if (this.fail) throw new Error('no terminal');
  }
  async resize(_sessionId: string, _terminalId: string, cols: number, rows: number): Promise<unknown> {
    this.calls.push(`resize:${cols}x${rows}`);
    return undefined;
  }
  async capture(): Promise<Uint8Array> {
    this.calls.push('capture');
    if (this.holding) await new Promise<void>(resolve => (this.held = resolve));
    if (this.fail) throw new Error('no terminal');
    return Uint8Array.of(27);
  }
}

class FakeScheduler implements TerminalStreamScheduler {
  callback?: () => void;
  cleared = false;
  readonly delays: number[] = [];
  schedule(callback: () => void, milliseconds: number): TerminalStreamTimer {
    this.callback = callback;
    this.delays.push(milliseconds);
    return {
      cancel: () => {
        this.cleared = true;
      },
    };
  }
}

describe('TerminalStreamBridge', () => {
  it('should stream a terminal snapshot, serialise input and resize frames, and poll again', async () => {
    // Arrange
    const service = new FakeService();
    const scheduler = new FakeScheduler();
    const sent: Uint8Array[] = [];
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: bytes => sent.push(bytes), close: () => undefined },
      scheduler,
    );

    // Act
    await bridge.open();
    bridge.fromClient(Uint8Array.of(13));
    bridge.fromClient(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await Bun.sleep(1);
    scheduler.callback?.();
    await Bun.sleep(1);

    // Assert
    should(sent).deepEqual([Uint8Array.of(27), Uint8Array.of(27)]);
    should(service.calls.includes('write:13')).be.true();
    should(service.calls.includes('resize:120x40')).be.true();
    should(service.calls.filter(call => call === 'capture')).have.length(2);
  });

  it('should close invalid, unavailable, and failed terminal streams without leaving a poll behind', async () => {
    // Arrange
    const scheduler = new FakeScheduler();
    const closed: Array<[number, string]> = [];
    const invalid = new TerminalStreamBridge(
      new FakeService(),
      's',
      't',
      { send: () => undefined, close: (code, reason) => closed.push([code, reason]) },
      scheduler,
    );
    const unavailable = new TerminalStreamBridge(
      new FakeService(),
      's',
      't',
      { send: () => -1, close: (code, reason) => closed.push([code, reason]) },
      new FakeScheduler(),
    );
    const failingService = new FakeService();
    failingService.fail = true;
    const failing = new TerminalStreamBridge(
      failingService,
      's',
      't',
      { send: () => undefined, close: (code, reason) => closed.push([code, reason]) },
      new FakeScheduler(),
    );

    // Act
    invalid.fromClient('{');
    await unavailable.open();
    await failing.open();
    invalid.close();

    // Assert
    should(closed).deepEqual([
      [1008, 'invalid terminal input'],
      [1013, 'terminal viewer unavailable'],
      [1011, 'terminal redraw failed'],
    ]);
    should(scheduler.cleared).be.false();
  });

  it('should close the stream when an input frame cannot reach the pane', async () => {
    // A write that fails means the pane is gone, so the viewer must be told rather than left typing
    // into a socket whose keystrokes are silently discarded.
    // Arrange
    const service = new FakeService();
    const closed: Array<[number, string]> = [];
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: () => undefined, close: (code, reason) => closed.push([code, reason]) },
      new FakeScheduler(),
    );

    // Act
    service.fail = true;
    bridge.fromClient(Uint8Array.of(13));
    await Bun.sleep(1);

    // Assert
    should(closed).deepEqual([[1011, 'terminal operation failed']]);
  });

  it('should not write a captured snapshot downstream when the viewer left during the capture', async () => {
    // THE DEFECT THIS PINS, and its consequence is one package over. `redraw` checked `closed` once,
    // at the top, and then AWAITED a pane capture — so a `close()` landing during that await did not
    // stop the `downstream.send` that followed it. On a direct socket the write is inert. Over a
    // relay it was not: the frame reached a §14 stream session the link had already concluded and
    // deleted, and a daemon frame naming no live session makes the rendezvous close the DAEMON'S
    // SOCKET, taking every other relayed session on that link with it.
    //
    // Arrange — a capture suspended mid-flight, exactly where a real tmux round-trip suspends.
    const service = new FakeService();
    const sent: Uint8Array[] = [];
    const closed: Array<[number, string]> = [];
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: bytes => sent.push(bytes), close: (code, reason) => closed.push([code, reason]) },
      new FakeScheduler(),
    );
    service.holding = true;
    const opening = bridge.open();
    await Bun.sleep(1);

    // Act — the viewer leaves while the pane is still being captured, and only then does it resolve.
    bridge.close();
    service.release();
    await opening;

    // Assert — the capture happened and its result went nowhere, which is the whole property. The
    // bridge also says nothing more downstream: `close()` is the viewer's own departure, not a
    // failure this end reports back to a transport that has gone.
    should(service.calls).deepEqual(['capture']);
    should(sent).be.empty();
    should(closed).be.empty();
  });

  it('should drop a frame for a viewer that has stopped reading, and resume once it drains', async () => {
    // A slow viewer must never grow an unbounded backlog in the daemon. Because every frame is a
    // FULL pane redraw, the answer is to skip it — the next poll supersedes it — rather than to queue
    // it or to end an otherwise healthy stream. The pane is not even captured while behind.
    // Arrange
    const service = new FakeService();
    const scheduler = new FakeScheduler();
    const sent: Uint8Array[] = [];
    let buffered = TERMINAL_MAX_BUFFERED_OUTPUT_BYTES + 1;
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      {
        send: bytes => sent.push(bytes),
        close: () => undefined,
        bufferedBytes: () => buffered,
      },
      scheduler,
    );

    // Act
    await bridge.open();
    const whileBehind = [sent.length, service.calls.length] as const;
    buffered = TERMINAL_MAX_BUFFERED_OUTPUT_BYTES;
    scheduler.callback?.();
    await Bun.sleep(1);

    // Assert
    should(whileBehind).deepEqual([0, 0]);
    should(sent).deepEqual([Uint8Array.of(27)]);
    should(service.calls).deepEqual(['capture']);
  });

  it('should not resend an unchanged pane, but resend one the transport dropped or a resize reflowed', async () => {
    // An idle terminal polled ten times a second was ten identical full redraws a second for as long
    // as anyone watched — each a sealed record and a metered frame over a relay. A redraw equal to the
    // one the viewer already holds carries nothing. A redraw the transport answered `0` for never
    // reached the viewer, so it is not "already held"; and a resize reflows the viewer's emulator.
    // Arrange
    const service = new FakeService();
    const scheduler = new FakeScheduler();
    const sent: Uint8Array[] = [];
    let answer = 0;
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      {
        send: bytes => {
          sent.push(bytes);
          return answer;
        },
        close: () => undefined,
        bufferedBytes: () => 0,
      },
      scheduler,
    );
    const poll = async (): Promise<void> => {
      scheduler.callback?.();
      await Bun.sleep(1);
    };

    // Act — the first redraw is dropped, so the next poll must send the very same picture again.
    await bridge.open();
    answer = 1;
    await poll();
    const afterDrop = sent.length;
    await poll();
    await poll();
    const unchanged = sent.length;
    bridge.fromClient(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await Bun.sleep(1);
    await poll();

    // Assert
    should(afterDrop).equal(2);
    should(unchanged).equal(2);
    should(sent).have.length(3);
    should(service.calls.filter(call => call === 'capture')).have.length(5);
  });

  it('should capture the echo of a keystroke soon after it reaches the pane, not on the next ordinary tick', async () => {
    // Arrange
    const service = new FakeService();
    const scheduler = new FakeScheduler();
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: () => 1, close: () => undefined, bufferedBytes: () => 0 },
      scheduler,
    );

    // Act
    await bridge.open();
    bridge.fromClient(Uint8Array.of(97));
    await Bun.sleep(1);
    scheduler.callback?.();
    await Bun.sleep(1);

    // Assert — the armed tick was replaced by a short one, and the poll after it is ordinary again.
    should(scheduler.cleared).be.true();
    should(scheduler.delays).deepEqual([TERMINAL_REDRAW_POLL_MS, TERMINAL_INPUT_REDRAW_MS, TERMINAL_REDRAW_POLL_MS]);
    should(TERMINAL_INPUT_REDRAW_MS).be.below(TERMINAL_REDRAW_POLL_MS);
  });
});
