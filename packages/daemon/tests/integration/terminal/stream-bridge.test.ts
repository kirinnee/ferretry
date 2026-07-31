import { describe, it } from 'bun:test';
import should from 'should';
import {
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  type TerminalStreamService,
  type TerminalStreamTimer,
} from '../../../src/adapters/index.ts';
import { TERMINAL_MAX_BUFFERED_OUTPUT_BYTES } from '../../../src/lib/index.ts';

class FakeService implements TerminalStreamService {
  readonly calls: string[] = [];
  fail = false;
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
    if (this.fail) throw new Error('no terminal');
    return Uint8Array.of(27);
  }
}

class FakeScheduler implements TerminalStreamScheduler {
  callback?: () => void;
  cleared = false;
  schedule(callback: () => void): TerminalStreamTimer {
    this.callback = callback;
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
});
