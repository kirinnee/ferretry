import { describe, it } from 'bun:test';
import should from 'should';
import {
  TerminalStreamBridge,
  type TerminalStreamScheduler,
  type TerminalStreamService,
  type TerminalStreamTimer,
} from '../../../src/adapters/index.ts';
import {
  TERMINAL_INPUT_REDRAW_LADDER_MS,
  TERMINAL_MAX_BUFFERED_OUTPUT_BYTES,
  TERMINAL_MAX_INPUT_FRAME_BYTES,
  TERMINAL_MAX_QUEUED_INPUT_BYTES,
  TERMINAL_POLL_HISTORY_LINES,
  TERMINAL_REATTACH_LINES,
  TERMINAL_REDRAW_POLL_MS,
  type TerminalCapture,
} from '../../../src/lib/index.ts';

/**
 * Let everything already queued run. The service and scheduler here are fakes that settle in microtasks,
 * and a macrotask never starts before the microtask queue is empty — so one turn of the event loop is the
 * event "the bridge has finished reacting", with no wall-clock time in it.
 */
const turn = async (): Promise<void> => await new Promise<void>(resolve => setImmediate(resolve));

const ESC = '\u001b';
/** A pane of `lines`, all of them visible, at the size a 100×N viewer reports. */
const pane = (lines: readonly string[], cursorX = 0, cursorY = 0): TerminalCapture => ({
  lines,
  cols: 100,
  rows: lines.length,
  cursorX,
  cursorY,
  historySize: 0,
});
/** The smallest pane the protocol lets a viewer report: five rows, a prompt on the first. */
const PROMPT = pane(['$ ', '', '', '', ''], 2);
/** The complete redraw of {@link PROMPT}: erase everything, paint both rows, park the cursor. */
const PROMPT_REDRAW = `${ESC}[3J${ESC}[2J${ESC}[H$ \r\n\r\n\r\n\r\n${ESC}[1;3H`;
const text = (frames: readonly Uint8Array[]): string[] => frames.map(frame => new TextDecoder().decode(frame));

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
  /** What the next capture returns. */
  screen: TerminalCapture = PROMPT;
  /** How much history each capture asked for, in order. */
  readonly depths: number[] = [];
  async capture(_sessionId: string, _terminalId: string, historyLines: number): Promise<TerminalCapture> {
    this.calls.push('capture');
    this.depths.push(historyLines);
    if (this.holding) await new Promise<void>(resolve => (this.held = resolve));
    if (this.fail) throw new Error('no terminal');
    return this.screen;
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
    await turn();
    scheduler.callback?.();
    await turn();

    // Assert
    // Both complete: the first because nothing came before it, the second because the resize reflowed
    // the viewer, so nothing it showed before may be a delta's starting point.
    should(text(sent)).deepEqual([PROMPT_REDRAW, PROMPT_REDRAW]);
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
    await turn();

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
    await turn();

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
    await turn();

    // Assert
    should(whileBehind).deepEqual([0, 0]);
    should(text(sent)).deepEqual([PROMPT_REDRAW]);
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
      await turn();
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
    await turn();
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
    await turn();
    scheduler.callback?.();
    await turn();

    // Assert — the armed tick was replaced by the first rung, the next capture by the second, and the
    // poll after the last rung is ordinary again.
    should(scheduler.cleared).be.true();
    should(scheduler.delays).deepEqual([TERMINAL_REDRAW_POLL_MS, ...TERMINAL_INPUT_REDRAW_LADDER_MS.slice(0, 2)]);
    for (let rung = 2; rung <= TERMINAL_INPUT_REDRAW_LADDER_MS.length; rung += 1) {
      scheduler.callback?.();
      await turn();
    }
    should(scheduler.delays).deepEqual([
      TERMINAL_REDRAW_POLL_MS,
      ...TERMINAL_INPUT_REDRAW_LADDER_MS,
      TERMINAL_REDRAW_POLL_MS,
    ]);
    should(TERMINAL_INPUT_REDRAW_LADDER_MS[0]).equal(0);
    should(Math.max(...TERMINAL_INPUT_REDRAW_LADDER_MS)).be.below(TERMINAL_REDRAW_POLL_MS);
  });

  it("should send a viewer of the pane's own size only the row a keystroke changed", async () => {
    // A keystroke used to cost a complete redraw — the whole history and screen, for one character.
    // Arrange
    const service = new FakeService();
    const scheduler = new FakeScheduler();
    const sent: Uint8Array[] = [];
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: bytes => sent.push(bytes), close: () => undefined, bufferedBytes: () => 0 },
      scheduler,
    );

    // Act — the viewer says its size (the pane's), the first redraw lands, then one character is typed.
    await bridge.open();
    bridge.fromClient(JSON.stringify({ type: 'resize', cols: 100, rows: 5 }));
    await turn();
    scheduler.callback?.();
    await turn();
    service.screen = pane(['$ a', '', '', '', ''], 3);
    bridge.fromClient(Uint8Array.of(97));
    await turn();
    scheduler.callback?.();
    await turn();

    // Assert — after the two complete redraws (attach, then the resize), one row and a cursor move; and
    // only the complete redraws read the whole history, the keystroke's capture a window of it.
    should(text(sent)).deepEqual([PROMPT_REDRAW, PROMPT_REDRAW, `${ESC}[1;1H${ESC}[0m${ESC}[2K$ a${ESC}[1;4H`]);
    should(service.depths).deepEqual([TERMINAL_REATTACH_LINES, TERMINAL_REATTACH_LINES, TERMINAL_POLL_HISTORY_LINES]);
  });

  it('should keep sending deltas when a viewer repeats the size it already has, and redraw only when it changes', async () => {
    // A resize control used to forget the picture the viewer holds even when it named the size the
    // viewer already was, so a client re-sending its size turned every following poll into a complete
    // redraw of up to the byte budget. Only a size that CHANGED reflows the emulator.
    // Arrange
    const service = new FakeService();
    const scheduler = new FakeScheduler();
    const sent: Uint8Array[] = [];
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: bytes => sent.push(bytes), close: () => undefined, bufferedBytes: () => 0 },
      scheduler,
    );
    const poll = async (): Promise<void> => {
      scheduler.callback?.();
      await turn();
    };

    // Act — the viewer reports its size and receives that redraw, then reports the SAME size again and
    // one character is typed.
    await bridge.open();
    bridge.fromClient(JSON.stringify({ type: 'resize', cols: 100, rows: 5 }));
    await turn();
    await poll();
    bridge.fromClient(JSON.stringify({ type: 'resize', cols: 100, rows: 5 }));
    await turn();
    service.screen = pane(['$ a', '', '', '', ''], 3);
    await poll();
    const beforeChange = text(sent);
    bridge.fromClient(JSON.stringify({ type: 'resize', cols: 90, rows: 5 }));
    await turn();
    await poll();

    // Assert — attach and the first resize are complete redraws; the repeat leaves the next poll a one-row
    // delta; a changed size is complete again.
    should(beforeChange).deepEqual([PROMPT_REDRAW, PROMPT_REDRAW, `${ESC}[1;1H${ESC}[0m${ESC}[2K$ a${ESC}[1;4H`]);
    should(sent).have.length(4);
    should(service.calls.filter(call => call.startsWith('resize:'))).deepEqual([
      'resize:100x5',
      'resize:100x5',
      'resize:90x5',
    ]);
  });

  it('should read the whole history again when a poll finds the viewer needs a complete redraw', async () => {
    // A delta needs a window of history; a complete redraw is worth all of it. A viewer that never said
    // its size can only be sent complete redraws, so its poll's window is followed by a full capture.
    // Arrange
    const service = new FakeService();
    const scheduler = new FakeScheduler();
    const sent: Uint8Array[] = [];
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: bytes => sent.push(bytes), close: () => undefined, bufferedBytes: () => 0 },
      scheduler,
    );

    // Act
    await bridge.open();
    service.screen = pane(['$ a', '', '', '', ''], 3);
    scheduler.callback?.();
    await turn();

    // Assert
    should(service.depths).deepEqual([TERMINAL_REATTACH_LINES, TERMINAL_POLL_HISTORY_LINES, TERMINAL_REATTACH_LINES]);
    should(text(sent)).deepEqual([PROMPT_REDRAW, `${ESC}[3J${ESC}[2J${ESC}[H$ a\r\n\r\n\r\n\r\n${ESC}[1;4H`]);
  });

  it('should drop the second capture of a viewer that left while the first was being read', async () => {
    // Arrange — the full capture is the one suspended; the viewer leaves during it.
    const service = new FakeService();
    const scheduler = new FakeScheduler();
    const sent: Uint8Array[] = [];
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: bytes => sent.push(bytes), close: () => undefined, bufferedBytes: () => 0 },
      scheduler,
    );
    await bridge.open();
    service.screen = pane(['$ a', '', '', '', ''], 3);
    const window = service.capture.bind(service);
    service.capture = async (sessionId, terminalId, historyLines) => {
      if (historyLines === TERMINAL_REATTACH_LINES) service.holding = true;
      return await window(sessionId, terminalId, historyLines);
    };

    // Act
    scheduler.callback?.();
    await turn();
    bridge.close();
    service.release();
    await turn();

    // Assert — the attach's redraw only; the complete redraw the second capture was for went nowhere.
    should(text(sent)).deepEqual([PROMPT_REDRAW]);
  });

  it('should close the stream when queued input outgrows its budget while the pane is not draining it', async () => {
    // A pane that stops taking keystrokes must not let a viewer pile up input in daemon memory.
    // Arrange — the first write never finishes, so every later frame waits behind it.
    const service = new FakeService();
    let unblock: () => void = () => undefined;
    service.write = async () => {
      await new Promise<void>(resolve => (unblock = resolve));
    };
    const closed: Array<[number, string]> = [];
    const bridge = new TerminalStreamBridge(
      service,
      'session-a',
      '0123456789ab',
      { send: () => undefined, close: (code, reason) => closed.push([code, reason]) },
      new FakeScheduler(),
    );
    const frame = new Uint8Array(TERMINAL_MAX_INPUT_FRAME_BYTES);
    const frames = TERMINAL_MAX_QUEUED_INPUT_BYTES / TERMINAL_MAX_INPUT_FRAME_BYTES;

    // Act — a full budget is admitted; one frame more is not.
    for (let sent = 0; sent < frames; sent += 1) bridge.fromClient(frame);
    const admittedOnly = [...closed];
    bridge.fromClient(frame);
    unblock();

    // Assert
    should(admittedOnly).deepEqual([]);
    should(closed).deepEqual([[1009, 'terminal input queue exceeded']]);
  });
});
