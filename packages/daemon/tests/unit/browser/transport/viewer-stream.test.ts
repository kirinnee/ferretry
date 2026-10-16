import { describe, it } from 'bun:test';
import should from 'should';
import {
  assembleBrowserStream,
  type BrowserInputEvent,
  type BrowserScreencastFrame,
  EMPTY_BROWSER_STREAM_ASSEMBLY,
} from '@ferretry/protocol';
import {
  BrowserViewerStream,
  type BrowserViewerHost,
  type FrameClock,
  type FrameTimer,
  decodeFrameEnvelope,
  type ViewerAttachment,
  type ViewerDownstream,
  type ViewerStreamOptions,
  type ViewerTerminalSignal,
} from '../../../../src/lib/index.ts';

/** Every whole envelope a run of sent chunks carries, read exactly as a viewer reads the stream. */
const envelopesIn = (sent: readonly Uint8Array[]): Uint8Array[] => {
  let assembly = EMPTY_BROWSER_STREAM_ASSEMBLY;
  const envelopes: Uint8Array[] = [];
  for (const chunk of sent) {
    const step = assembleBrowserStream(assembly, chunk);
    if (!step.ok) throw new Error(step.message);
    assembly = step.assembly;
    envelopes.push(...step.envelopes);
  }
  return envelopes;
};

const jpegTextOf = (envelope: Uint8Array | undefined): string | false => {
  const decoded = decodeFrameEnvelope(envelope as Uint8Array);
  return decoded.ok && new TextDecoder().decode(decoded.value.jpegBytes);
};

class FakeClock implements FrameClock {
  private current = 0;
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

  get armed(): boolean {
    return this.due !== undefined;
  }

  advance(ms: number): void {
    this.current += ms;
    const due = this.due;
    if (due === undefined || due.at > this.current) return;
    this.due = undefined;
    due.callback();
  }
}

class FakeDownstream implements ViewerDownstream {
  sent: Uint8Array[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  result: number | void = undefined;
  buffered = 0;
  throwOnSend = false;

  send(envelope: Uint8Array): number | void {
    if (this.throwOnSend) throw new Error('socket is gone');
    this.sent.push(envelope);
    return this.result;
  }

  throwOnClose = false;

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    if (this.throwOnClose) throw new Error('socket is already gone');
  }

  bufferedBytes(): number {
    return this.buffered;
  }
}

class FakeHost implements BrowserViewerHost {
  dispatched: BrowserInputEvent[] = [];
  detachments = 0;
  failNextDispatch = false;
  onFrame?: (frame: BrowserScreencastFrame) => void;
  onTerminal?: (signal: ViewerTerminalSignal) => void;
  /** Emitted during the attach round trip, before the stream object exists. */
  early?: { readonly frame?: BrowserScreencastFrame; readonly terminal?: ViewerTerminalSignal };

  attachViewer(
    _sessionId: string,
    onFrame: (frame: BrowserScreencastFrame) => void,
    onTerminal: (signal: ViewerTerminalSignal) => void,
  ): Promise<ViewerAttachment> {
    this.onFrame = onFrame;
    this.onTerminal = onTerminal;
    if (this.early?.frame) onFrame(this.early.frame);
    if (this.early?.terminal) onTerminal(this.early.terminal);
    return Promise.resolve({
      detach: () => {
        this.detachments += 1;
      },
    });
  }

  dispatchHumanInput(_sessionId: string, input: BrowserInputEvent): Promise<void> {
    if (this.failNextDispatch) {
      this.failNextDispatch = false;
      return Promise.reject(new Error('page detached'));
    }
    this.dispatched.push(input);
    return Promise.resolve();
  }
}

const frame = (overrides: Partial<BrowserScreencastFrame> = {}): BrowserScreencastFrame => ({
  dataBase64: btoa('jpeg-bytes'),
  width: 800,
  height: 600,
  pageId: 'page-1',
  ...overrides,
});

const message = (value: unknown): string => JSON.stringify(value);

const mouseMove = { kind: 'mouse', type: 'mouseMoved', x: 4, y: 5 } as const;

async function connect(overrides: { readonly host?: FakeHost; readonly options?: ViewerStreamOptions } = {}) {
  const host = overrides.host ?? new FakeHost();
  const downstream = new FakeDownstream();
  const clock = new FakeClock();
  const stream = await BrowserViewerStream.connect(host, 'session-1', downstream, clock, overrides.options);
  return { host, downstream, clock, stream };
}

describe('browser viewer stream — downstream frames', () => {
  it('should send a small frame as one chunk carrying one page-id envelope', async () => {
    // Arrange
    const { host, downstream } = await connect();

    // Act
    host.onFrame?.(frame());

    // Assert
    should(downstream.sent).have.length(1);
    const decoded = decodeFrameEnvelope(envelopesIn(downstream.sent)[0] as Uint8Array);
    should(decoded.ok && decoded.value.pageId).equal('page-1');
    should(decoded.ok && new TextDecoder().decode(decoded.value.jpegBytes)).equal('jpeg-bytes');
  });

  it('should replay a frame that arrived during the attach round trip', async () => {
    // Arrange
    const host = new FakeHost();
    host.early = { frame: frame({ pageId: 'early' }) };

    // Act
    const { downstream } = await connect({ host });

    // Assert
    should(downstream.sent).have.length(1);
  });

  it('should prefer a terminal signal over a frame that arrived during attach', async () => {
    // Arrange
    const host = new FakeHost();
    host.early = { frame: frame(), terminal: { code: 1001, reason: 'browser stopped' } };

    // Act
    const { downstream, stream } = await connect({ host });

    // Assert
    should(downstream.sent).be.empty();
    should(downstream.closes).deepEqual([{ code: 1001, reason: 'browser stopped' }]);
    should(stream.finished).be.true();
  });

  it('should retain only the newest frame while the transport is congested', async () => {
    // Arrange
    const { host, downstream, clock } = await connect();
    downstream.buffered = 1;

    // Act
    host.onFrame?.(frame({ dataBase64: btoa('first') }));
    host.onFrame?.(frame({ dataBase64: btoa('second') }));

    // Assert: nothing was queued behind the congestion.
    should(downstream.sent).be.empty();
    should(clock.armed).be.true();

    // Act
    downstream.buffered = 0;
    clock.advance(16);

    // Assert
    should(downstream.sent).have.length(1);
    should(jpegTextOf(envelopesIn(downstream.sent)[0])).equal('second');
  });

  it('should cut a frame larger than one record into chunks that each fit it', async () => {
    // Arrange: a record of 40 bytes leaves 19 for the payload after the 21-byte chunk header.
    const { host, downstream } = await connect({ options: { chunkBytes: 40 } });
    const pixels = 'x'.repeat(100);

    // Act
    host.onFrame?.(frame({ dataBase64: btoa(pixels) }));

    // Assert
    should(downstream.sent.length).be.above(1);
    should(downstream.sent.every(chunk => chunk.byteLength <= 40)).be.true();
    should(jpegTextOf(envelopesIn(downstream.sent)[0])).equal(pixels);
  });

  it('should not send a frame identical to the last one the transport accepted', async () => {
    // Arrange
    const { host, downstream } = await connect();
    host.onFrame?.(frame());

    // Act: the same pixels for the same page, then a change.
    host.onFrame?.(frame());
    host.onFrame?.(frame({ dataBase64: btoa('changed') }));

    // Assert
    should(envelopesIn(downstream.sent).map(jpegTextOf)).eql(['jpeg-bytes', 'changed']);
  });

  it('should let pixels the viewer already holds supersede a different frame still waiting', async () => {
    // Arrange
    const { host, downstream, clock } = await connect();
    host.onFrame?.(frame());
    downstream.buffered = 1;
    host.onFrame?.(frame({ dataBase64: btoa('transient') }));

    // Act: the page returns to what the viewer is showing before the waiting frame could go.
    host.onFrame?.(frame());
    downstream.buffered = 0;
    clock.advance(16);

    // Assert
    should(envelopesIn(downstream.sent).map(jpegTextOf)).eql(['jpeg-bytes']);
  });

  it('should resend a frame whole, under a new serial, when the transport drops one of its chunks', async () => {
    // Arrange
    const { host, downstream, clock } = await connect({ options: { chunkBytes: 40 } });
    const pixels = 'y'.repeat(100);
    let calls = 0;
    downstream.send = chunk => {
      calls += 1;
      downstream.sent.push(chunk);
      return calls === 2 ? 0 : undefined;
    };

    // Act
    host.onFrame?.(frame({ dataBase64: btoa(pixels) }));

    // Assert: the send stopped at the dropped chunk, and nothing complete reached the viewer yet.
    should(downstream.sent).have.length(2);
    should(envelopesIn(downstream.sent)).have.length(0);

    // Act
    clock.advance(16);

    // Assert
    should(envelopesIn(downstream.sent).map(jpegTextOf)).eql([pixels]);
    // A resend of what the viewer still lacks is not "identical to what it holds".
    host.onFrame?.(frame({ dataBase64: btoa(pixels) }));
    should(envelopesIn(downstream.sent)).have.length(1);
  });

  it('should send nothing, and remember nothing as shown, when no chunk fits the record', async () => {
    // Arrange
    const { host, downstream } = await connect({ options: { chunkBytes: 21 } });

    // Act
    host.onFrame?.(frame());
    host.onFrame?.(frame());

    // Assert
    should(downstream.sent).be.empty();
  });

  it('should retain a dropped frame and resend it once the transport recovers', async () => {
    // Arrange
    const { host, downstream, clock } = await connect();
    downstream.result = 0;

    // Act
    host.onFrame?.(frame());

    // Assert
    should(downstream.sent).have.length(1);
    should(clock.armed).be.true();

    // Act
    downstream.result = undefined;
    clock.advance(16);

    // Assert
    should(downstream.sent).have.length(2);
  });

  it('should never resend a frame the transport accepted under backpressure', async () => {
    // Arrange
    const { host, downstream, clock } = await connect();
    downstream.result = -1;

    // Act
    host.onFrame?.(frame());
    clock.advance(1_000);

    // Assert: duplicating accepted pixels is worse than dropping the next frame.
    should(downstream.sent).have.length(1);
    should(clock.armed).be.false();
  });

  it('should drop one corrupt or identity-free frame without ending a healthy stream', async () => {
    // Arrange
    const { host, downstream, stream } = await connect();

    // Act
    host.onFrame?.(frame({ dataBase64: 'not base64 at all!' }));
    host.onFrame?.(frame({ dataBase64: '' }));
    host.onFrame?.(frame({ pageId: 'p'.repeat(200) }));

    // Assert: kteam closed the socket over a single bad payload.
    should(downstream.sent).be.empty();
    should(downstream.closes).be.empty();
    should(stream.finished).be.false();
  });

  it('should end the stream when a frame exceeds the byte ceiling', async () => {
    // Arrange
    const { host, downstream } = await connect();
    const oversize = btoa('x'.repeat(8 * 1024 * 1024 + 1));

    // Act
    host.onFrame?.(frame({ dataBase64: oversize }));

    // Assert
    should(downstream.closes).deepEqual([{ code: 1009, reason: 'browser frame exceeded' }]);
  });

  it('should end the stream when the transport throws on send', async () => {
    // Arrange
    const { host, downstream } = await connect();
    downstream.throwOnSend = true;

    // Act
    host.onFrame?.(frame());

    // Assert
    should(downstream.closes).deepEqual([{ code: 1011, reason: 'browser display send failed' }]);
  });

  it('should ignore frames that arrive after the stream ended', async () => {
    // Arrange
    const { host, downstream, stream } = await connect();
    stream.close();

    // Act
    host.onFrame?.(frame());

    // Assert
    should(downstream.sent).be.empty();
  });
});

describe('browser viewer stream — upstream input', () => {
  it('should dispatch normalized input from text and binary messages in arrival order', async () => {
    // Arrange
    const { host, stream } = await connect();

    // Act
    stream.fromClient(message(mouseMove));
    stream.fromClient(new TextEncoder().encode(message({ kind: 'insertText', text: 'hi' })));
    stream.fromClient(new TextEncoder().encode(message({ kind: 'insertText', text: 'there' })).buffer);
    await stream.settled;

    // Assert
    should(host.dispatched).deepEqual([
      { kind: 'mouse', type: 'mouseMoved', x: 4, y: 5, buttons: 0, clickCount: 0, deltaX: 0, deltaY: 0, modifiers: 0 },
      { kind: 'insertText', text: 'hi' },
      { kind: 'insertText', text: 'there' },
    ]);
  });

  it('should reject a malformed or unparseable client message as a policy violation', async () => {
    // Arrange
    const { downstream, stream } = await connect();

    // Act
    stream.fromClient('{not json');

    // Assert
    should(downstream.closes).deepEqual([{ code: 1008, reason: 'invalid browser input' }]);
    should(stream.finished).be.true();
  });

  it('should reject an input event the schema does not accept', async () => {
    // Arrange
    const { downstream, stream } = await connect();

    // Act
    stream.fromClient(message({ kind: 'telepathy' }));

    // Assert
    should(downstream.closes).deepEqual([{ code: 1008, reason: 'invalid browser input' }]);
  });

  it('should end the stream when one message is larger than the ceiling', async () => {
    // Arrange
    const { downstream, stream } = await connect();

    // Act
    stream.fromClient(message({ kind: 'insertText', text: 'x'.repeat(300 * 1024) }));

    // Assert
    should(downstream.closes).deepEqual([{ code: 1009, reason: 'browser input queue exceeded' }]);
  });

  it('should end the stream when queued input outgrows its budget', async () => {
    // Arrange
    const host = new FakeHost();
    const downstream = new FakeDownstream();
    const stream = await BrowserViewerStream.connect(host, 'session-1', downstream, new FakeClock(), {
      maxQueuedInputBytes: 100,
    });

    // Act: nothing has drained yet, so the second message exceeds the in-flight budget.
    stream.fromClient(message({ kind: 'insertText', text: 'x'.repeat(40) }));
    stream.fromClient(message({ kind: 'insertText', text: 'y'.repeat(40) }));

    // Assert
    should(downstream.closes).deepEqual([{ code: 1009, reason: 'browser input queue exceeded' }]);
  });

  it('should free the input budget again once a dispatch settles', async () => {
    // Arrange
    const host = new FakeHost();
    const downstream = new FakeDownstream();
    const stream = await BrowserViewerStream.connect(host, 'session-1', downstream, new FakeClock(), {
      maxQueuedInputBytes: 100,
    });

    // Act
    stream.fromClient(message({ kind: 'insertText', text: 'x'.repeat(40) }));
    await stream.settled;
    stream.fromClient(message({ kind: 'insertText', text: 'y'.repeat(40) }));
    await stream.settled;

    // Assert
    should(downstream.closes).be.empty();
    should(host.dispatched).have.length(2);
  });

  it('should end the stream when a dispatch fails', async () => {
    // Arrange
    const { host, downstream, stream } = await connect();
    host.failNextDispatch = true;

    // Act
    stream.fromClient(message(mouseMove));
    await stream.settled;

    // Assert
    should(downstream.closes).deepEqual([{ code: 1011, reason: 'browser input failed' }]);
  });

  it('should ignore client messages after the stream ended', async () => {
    // Arrange
    const { host, stream } = await connect();
    stream.close();

    // Act
    stream.fromClient(message(mouseMove));
    await stream.settled;

    // Assert
    should(host.dispatched).be.empty();
  });

  it('should not dispatch input queued before the stream ended', async () => {
    // Arrange
    const { host, stream } = await connect();

    // Act: the close lands in the same tick, before the serial dispatch runs.
    stream.fromClient(message(mouseMove));
    stream.close();
    await stream.settled;

    // Assert
    should(host.dispatched).be.empty();
  });
});

describe('browser viewer stream — held keys', () => {
  const keyDown = (key: string, code: string) => ({ kind: 'key', type: 'keyDown', key, code });

  it('should release keys still held when the viewer disconnects, newest first', async () => {
    // Arrange
    const { host, stream } = await connect();
    stream.fromClient(message(keyDown('Shift', 'ShiftLeft')));
    stream.fromClient(message(keyDown('a', 'KeyA')));
    await stream.settled;

    // Act
    stream.close();
    await stream.settled;

    // Assert
    should(host.dispatched.slice(2)).deepEqual([
      {
        kind: 'key',
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 0,
        nativeVirtualKeyCode: 0,
        modifiers: 0,
        autoRepeat: false,
        isKeypad: false,
      },
      {
        kind: 'key',
        type: 'keyUp',
        key: 'Shift',
        code: 'ShiftLeft',
        windowsVirtualKeyCode: 0,
        nativeVirtualKeyCode: 0,
        modifiers: 0,
        autoRepeat: false,
        isKeypad: false,
      },
    ]);
    should(host.detachments).equal(1);
  });

  it('should release a key held by a message that never reached the browser', async () => {
    // Arrange: kteam recorded held keys inside the dispatch task, so this key stayed down forever.
    const { host, stream } = await connect();

    // Act
    stream.fromClient(message(keyDown('Control', 'ControlLeft')));
    stream.close();
    await stream.settled;

    // Assert
    should(host.dispatched).have.length(1);
    should(host.dispatched[0]).match({ type: 'keyUp', code: 'ControlLeft' });
  });

  it('should forget a key the client already released', async () => {
    // Arrange
    const { host, stream } = await connect();
    stream.fromClient(message(keyDown('a', 'KeyA')));
    stream.fromClient(message({ kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' }));
    await stream.settled;

    // Act
    stream.close();
    await stream.settled;

    // Assert
    should(host.dispatched).have.length(2);
  });

  it('should survive a release that the browser refuses', async () => {
    // Arrange
    const { host, stream } = await connect();
    stream.fromClient(message(keyDown('a', 'KeyA')));
    await stream.settled;
    host.failNextDispatch = true;

    // Act
    stream.close();

    // Assert
    await stream.settled;
    should(host.detachments).equal(1);
  });

  it('should detach exactly once however many times it is closed', async () => {
    // Arrange
    const { host, downstream, stream } = await connect();

    // Act
    stream.close();
    stream.close();

    // Assert
    should(host.detachments).equal(1);
    should(downstream.closes).be.empty();
  });

  it('should tolerate a transport that throws while being closed', async () => {
    // Arrange: a socket that has already gone away throws from close().
    const { host, downstream, stream } = await connect();
    downstream.throwOnClose = true;

    // Act
    host.onTerminal?.({ code: 1011, reason: 'browser crashed' });

    // Assert: the stream still finishes and still releases its viewer slot.
    should(downstream.closes).deepEqual([{ code: 1011, reason: 'browser crashed' }]);
    should(stream.finished).be.true();
    should(host.detachments).equal(1);
  });

  it('should cancel a pending frame retry when the stream ends', async () => {
    // Arrange
    const { host, downstream, clock, stream } = await connect();
    downstream.result = 0;
    host.onFrame?.(frame());

    // Act
    stream.close();
    clock.advance(1_000);

    // Assert
    should(clock.cancellations).equal(1);
    should(downstream.sent).have.length(1);
  });
});
