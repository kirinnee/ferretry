import { describe, it } from 'bun:test';
import should from 'should';
import {
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  type TerminalStreamService,
} from '../../../src/adapters/index.ts';

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
  setTimeout(callback: () => void): unknown {
    this.callback = callback;
    return 1;
  }
  clearTimeout(): void {
    this.cleared = true;
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
});
