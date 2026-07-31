import { describe, it } from 'bun:test';
import should from 'should';
import {
  admitTerminalFrame,
  decideTerminalOutput,
  decideTerminalRedraw,
  decideTerminalSend,
  parseTerminalFrame,
  releaseTerminalFrame,
  resolveTerminalRedraw,
  shouldScheduleTerminalRedraw,
  TERMINAL_MAX_BUFFERED_OUTPUT_BYTES,
  TERMINAL_MAX_CONTROL_FRAME_BYTES,
  TERMINAL_MAX_INPUT_FRAME_BYTES,
  TERMINAL_MAX_QUEUED_INPUT_BYTES,
  TERMINAL_REDRAW_POLL_MS,
  TERMINAL_STREAM_CLOSES,
  type TerminalChargedOperation,
  type TerminalOperation,
  type TerminalRedrawState,
  type TerminalStreamClose,
  type TerminalStreamFrame,
  utf8ByteLength,
} from '../../../src/lib/terminal/stream-policy.ts';

const invalidFrame: TerminalStreamClose = TERMINAL_STREAM_CLOSES.invalidFrame;

const resizeFrame = (cols: number, rows: number): string => JSON.stringify({ type: 'resize', cols, rows });

const redrawState = (overrides: Partial<TerminalRedrawState> = {}): TerminalRedrawState => ({
  closed: false,
  desynced: true,
  redrawRunning: false,
  redrawScheduled: false,
  bufferedBytes: 0,
  droppedVersion: 1,
  ...overrides,
});

const accepted = (frame: TerminalStreamFrame): TerminalChargedOperation => {
  const decision = parseTerminalFrame(frame);
  if (decision.outcome !== 'accepted') throw new Error('expected an accepted frame');
  return decision.charged;
};

const inputBytes = (operation: TerminalOperation): Uint8Array => {
  if (operation.kind !== 'input') throw new Error('expected a raw input operation');
  return operation.bytes;
};

const acceptedInput = (frame: TerminalStreamFrame): Uint8Array => inputBytes(accepted(frame).operation);

describe('utf8ByteLength', () => {
  it.each([
    { value: '', expected: 0 },
    { value: 'resize', expected: 6 },
    { value: 'é', expected: 2 },
    { value: '本', expected: 3 },
    { value: '🐿', expected: 4 },
    { value: '\ud800', expected: 3 },
    { value: '\ud800x', expected: 4 },
    { value: 'a🐿本', expected: 8 },
  ])('should count UTF-8 bytes for $value', ({ value, expected }) => {
    // Act
    const actual = utf8ByteLength(value);

    // Assert
    should(actual).equal(expected);
  });

  it('should agree with an encoder on mixed content', () => {
    // Arrange
    const value = 'plain ascii · é · 本 · 🐿 · tail';

    // Act
    const actual = utf8ByteLength(value);

    // Assert
    should(actual).equal(new TextEncoder().encode(value).byteLength);
  });
});

describe('parseTerminalFrame', () => {
  it('should read a binary frame as raw terminal input', () => {
    // Arrange
    const frame = Uint8Array.from([0x1b, 0x5b, 0x41]);

    // Act
    const decision = parseTerminalFrame(frame);

    // Assert
    should(decision).match({ outcome: 'accepted', charged: { bytes: 3, operation: { kind: 'input' } } });
    should(acceptedInput(frame)).deepEqual(frame);
  });

  it('should copy input away from the buffer the socket still owns', () => {
    // Arrange
    const frame = Uint8Array.from([1, 2, 3]);

    // Act
    const bytes = acceptedInput(frame);
    frame.set([9, 9, 9]);

    // Assert
    should(bytes).deepEqual(Uint8Array.from([1, 2, 3]));
  });

  it('should read an ArrayBuffer frame and honour a view window', () => {
    // Arrange
    const backing = Uint8Array.from([1, 2, 3, 4, 5]);
    const window = backing.subarray(1, 4);

    // Act
    const fromBuffer = parseTerminalFrame(backing.buffer);
    const fromWindow = acceptedInput(window);

    // Assert
    should(fromBuffer).match({ outcome: 'accepted', charged: { bytes: 5 } });
    should(fromWindow).deepEqual(Uint8Array.from([2, 3, 4]));
  });

  it('should accept an input frame at the framing limit and reject one past it', () => {
    // Arrange
    const atLimit = new Uint8Array(TERMINAL_MAX_INPUT_FRAME_BYTES);
    const overLimit = new Uint8Array(TERMINAL_MAX_INPUT_FRAME_BYTES + 1);

    // Act
    const withinLimit = parseTerminalFrame(atLimit);
    const pastLimit = parseTerminalFrame(overLimit);

    // Assert
    should(withinLimit).match({ outcome: 'accepted', charged: { bytes: TERMINAL_MAX_INPUT_FRAME_BYTES } });
    should(pastLimit).deepEqual({ outcome: 'rejected', close: invalidFrame });
  });

  it('should accept an empty input frame', () => {
    // Act
    const decision = parseTerminalFrame(new Uint8Array(0));

    // Assert
    should(decision).match({ outcome: 'accepted', charged: { bytes: 0, operation: { kind: 'input' } } });
  });

  it('should read a text frame as a bounded resize control message', () => {
    // Arrange
    const frame = resizeFrame(120, 40);

    // Act
    const decision = parseTerminalFrame(frame);

    // Assert
    should(decision).deepEqual({
      outcome: 'accepted',
      charged: { operation: { kind: 'resize', size: { cols: 120, rows: 40 } }, bytes: utf8ByteLength(frame) },
    });
  });

  it.each([
    { label: 'malformed JSON', frame: '{"type":"resize"' },
    { label: 'a JSON scalar', frame: '"resize"' },
    { label: 'an unknown control type', frame: JSON.stringify({ type: 'kill', cols: 80, rows: 24 }) },
    { label: 'a missing dimension', frame: JSON.stringify({ type: 'resize', cols: 80 }) },
    { label: 'a non-numeric dimension', frame: JSON.stringify({ type: 'resize', cols: '80', rows: 24 }) },
    { label: 'a fractional dimension', frame: resizeFrame(80.5, 24) },
    { label: 'geometry below the supported minimum', frame: resizeFrame(4, 24) },
    { label: 'geometry above the supported maximum', frame: resizeFrame(80, 4096) },
    { label: 'unknown extra keys', frame: JSON.stringify({ type: 'resize', cols: 80, rows: 24, shell: 'sh' }) },
  ])('should reject a text frame carrying $label', ({ frame }) => {
    // Act
    const decision = parseTerminalFrame(frame);

    // Assert
    should(decision).deepEqual({ outcome: 'rejected', close: invalidFrame });
  });

  it('should reject an oversized text frame before parsing it', () => {
    // Arrange: valid JSON, but padded past the control-frame budget.
    const padded = JSON.stringify({
      type: 'resize',
      cols: 80,
      rows: 24,
      pad: 'x'.repeat(TERMINAL_MAX_CONTROL_FRAME_BYTES),
    });

    // Act
    const decision = parseTerminalFrame(padded);

    // Assert
    should(utf8ByteLength(padded)).be.above(TERMINAL_MAX_CONTROL_FRAME_BYTES);
    should(decision).deepEqual({ outcome: 'rejected', close: invalidFrame });
  });

  it('should measure a text frame in UTF-8 bytes rather than code units', () => {
    // Arrange: every padding character costs three bytes, so the frame is over budget while its
    // length in code units is not.
    const padded = JSON.stringify({ type: 'resize', cols: 80, rows: 24, pad: '本'.repeat(6_000) });

    // Act
    const decision = parseTerminalFrame(padded);

    // Assert
    should(padded.length).be.below(TERMINAL_MAX_CONTROL_FRAME_BYTES);
    should(decision).deepEqual({ outcome: 'rejected', close: invalidFrame });
  });
});

describe('terminal input queue', () => {
  it('should charge an admitted frame against the queue budget', () => {
    // Act
    const decision = admitTerminalFrame(1_000, 24);

    // Assert
    should(decision).deepEqual({ outcome: 'queued', queuedBytes: 1_024 });
  });

  it('should admit a frame that exactly fills the budget', () => {
    // Act
    const decision = admitTerminalFrame(TERMINAL_MAX_QUEUED_INPUT_BYTES - 8, 8);

    // Assert
    should(decision).deepEqual({ outcome: 'queued', queuedBytes: TERMINAL_MAX_QUEUED_INPUT_BYTES });
  });

  it('should refuse a frame that would overflow the budget', () => {
    // Act
    const decision = admitTerminalFrame(TERMINAL_MAX_QUEUED_INPUT_BYTES, 1);

    // Assert
    should(decision).deepEqual({ outcome: 'rejected', close: TERMINAL_STREAM_CLOSES.queueOverflow });
    should(TERMINAL_STREAM_CLOSES.queueOverflow.code).equal(1009);
  });

  it('should release a completed frame and never go negative', () => {
    // Act
    const released = releaseTerminalFrame(64, 24);
    const floored = releaseTerminalFrame(8, 24);

    // Assert
    should(released).equal(40);
    should(floored).equal(0);
  });

  it('should return to an empty queue after admitting and releasing the same frames', () => {
    // Arrange
    const frames = [12, 480, 2_048];

    // Act
    let queued = 0;
    for (const bytes of frames) {
      const decision = admitTerminalFrame(queued, bytes);
      queued = decision.outcome === 'queued' ? decision.queuedBytes : queued;
    }
    for (const bytes of frames) queued = releaseTerminalFrame(queued, bytes);

    // Assert
    should(queued).equal(0);
  });
});

describe('decideTerminalSend', () => {
  it.each([
    { label: 'a socket that reports nothing', sent: undefined, expected: { outcome: 'sent' } },
    { label: 'a queued send', sent: 0, expected: { outcome: 'sent' } },
    { label: 'a written count', sent: 4_096, expected: { outcome: 'sent' } },
    {
      label: 'a socket that has gone away',
      sent: -1,
      expected: { outcome: 'rejected', close: TERMINAL_STREAM_CLOSES.viewerUnavailable },
    },
  ])('should interpret $label', ({ sent, expected }) => {
    // Act
    const decision = decideTerminalSend(sent);

    // Assert
    should(decision).deepEqual(expected);
  });
});

describe('decideTerminalOutput', () => {
  it('should forward deltas to a viewer that is keeping up', () => {
    // Act
    const decision = decideTerminalOutput({ desynced: false, bufferedBytes: TERMINAL_MAX_BUFFERED_OUTPUT_BYTES });

    // Assert
    should(decision).deepEqual({ action: 'forward' });
  });

  it('should drop deltas once the viewer socket is backed up', () => {
    // Act
    const decision = decideTerminalOutput({ desynced: false, bufferedBytes: TERMINAL_MAX_BUFFERED_OUTPUT_BYTES + 1 });

    // Assert
    should(decision).deepEqual({ action: 'drop' });
  });

  it('should keep dropping while desynced even after the socket drains', () => {
    // Act
    const decision = decideTerminalOutput({ desynced: true, bufferedBytes: 0 });

    // Assert
    should(decision).deepEqual({ action: 'drop' });
  });
});

describe('terminal redraw ladder', () => {
  it.each([
    { label: 'nothing is armed', state: {}, expected: true },
    { label: 'the stream is closed', state: { closed: true }, expected: false },
    { label: 'a snapshot is in flight', state: { redrawRunning: true }, expected: false },
    { label: 'a poll is already armed', state: { redrawScheduled: true }, expected: false },
  ])('should arm a poll only when $label', ({ state, expected }) => {
    // Act
    const actual = shouldScheduleTerminalRedraw(redrawState(state));

    // Assert
    should(actual).equal(expected);
    should(TERMINAL_REDRAW_POLL_MS).be.above(0);
  });

  it.each([
    { label: 'the stream is closed', state: { closed: true } },
    { label: 'the stream is in sync', state: { desynced: false } },
    { label: 'a snapshot is already in flight', state: { redrawRunning: true } },
  ])('should stay idle when $label', ({ state }) => {
    // Act
    const decision = decideTerminalRedraw(redrawState(state));

    // Assert
    should(decision).deepEqual({ action: 'idle' });
  });

  it('should defer while the viewer socket is still backed up', () => {
    // Act
    const decision = decideTerminalRedraw(redrawState({ bufferedBytes: TERMINAL_MAX_BUFFERED_OUTPUT_BYTES + 1 }));

    // Assert
    should(decision).deepEqual({ action: 'defer' });
  });

  it('should snapshot the version it repairs once the socket has drained', () => {
    // Act
    const decision = decideTerminalRedraw(redrawState({ bufferedBytes: 0, droppedVersion: 7 }));

    // Assert
    should(decision).deepEqual({ action: 'snapshot', version: 7 });
  });

  it.each([
    { label: 'no delta was dropped meanwhile', dropped: 7, expected: { outcome: 'resynced' } },
    { label: 'more deltas were dropped meanwhile', dropped: 9, expected: { outcome: 'stale' } },
  ])('should resolve a delivered snapshot when $label', ({ dropped, expected }) => {
    // Act
    const resolution = resolveTerminalRedraw(7, dropped);

    // Assert
    should(resolution).deepEqual(expected);
  });

  it('should carry a slow viewer from drop through redraw back into sync', () => {
    // Arrange: a viewer whose socket is full, then drains after one poll.
    let desynced = false;
    let droppedVersion = 0;
    let bufferedBytes = TERMINAL_MAX_BUFFERED_OUTPUT_BYTES + 1;

    // Act: two deltas arrive while the socket is full.
    const actions: string[] = [];
    for (let delta = 0; delta < 2; delta += 1) {
      const output = decideTerminalOutput({ desynced, bufferedBytes });
      actions.push(output.action);
      if (output.action === 'drop') {
        desynced = true;
        droppedVersion += 1;
      }
    }
    const deferred = decideTerminalRedraw(redrawState({ desynced, bufferedBytes, droppedVersion }));
    bufferedBytes = 0;
    const snapshot = decideTerminalRedraw(redrawState({ desynced, bufferedBytes, droppedVersion }));
    const resolution =
      snapshot.action === 'snapshot' ? resolveTerminalRedraw(snapshot.version, droppedVersion) : { outcome: 'stale' };
    if (resolution.outcome === 'resynced') desynced = false;

    // Assert
    should(actions).deepEqual(['drop', 'drop']);
    should(deferred).deepEqual({ action: 'defer' });
    should(snapshot).deepEqual({ action: 'snapshot', version: 2 });
    should(resolution).deepEqual({ outcome: 'resynced' });
    should(decideTerminalOutput({ desynced, bufferedBytes })).deepEqual({ action: 'forward' });
  });

  it('should redraw again when deltas are dropped while a snapshot is in flight', () => {
    // Arrange
    const snapshot = decideTerminalRedraw(redrawState({ droppedVersion: 3 }));

    // Act: a further drop advances the version before the snapshot is delivered.
    const resolution = snapshot.action === 'snapshot' ? resolveTerminalRedraw(snapshot.version, 4) : undefined;

    // Assert
    should(resolution).deepEqual({ outcome: 'stale' });
    should(shouldScheduleTerminalRedraw(redrawState({ droppedVersion: 4 }))).be.true();
  });
});
