import { describe, expect, test } from 'bun:test';
import { encodeFrame, FrameError, FrameReader, MAX_FRAME_BYTES } from '../../../daemon/lib/native/frames.ts';

/** The frames a native host and the daemon speak (daemon/lib/native/frames.ts): exact, bounded, and never guessed at. */
describe('frames', () => {
  const message = {
    id: 7,
    kind: 'load',
    paths: { encoder: '/state/encoder' },
    files: { vad: new Uint8Array([1, 2, 3]).buffer, 'ort-wasm': new Uint8Array(100).fill(9).buffer },
    samples: Float32Array.from([0.5, -0.25, 1]),
  };

  test('round-trips text, byte-runs and audio, each back as the type it went in', () => {
    const [frame] = new FrameReader().push(encodeFrame(message));
    const back = frame?.message as typeof message;
    expect(back.id).toBe(7);
    expect(back.paths).toEqual({ encoder: '/state/encoder' });
    expect(new Uint8Array(back.files.vad)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(back.files['ort-wasm'])).toEqual(new Uint8Array(100).fill(9));
    expect(back.samples).toBeInstanceOf(Float32Array);
    expect([...back.samples]).toEqual([0.5, -0.25, 1]);
    expect(frame?.buffers).toHaveLength(3);
  });

  test('reads frames however the stream is cut: a byte at a time, and two in one chunk', () => {
    const one = encodeFrame({ id: 1, a: 'x' });
    const two = encodeFrame({ id: 2, samples: new Float32Array(1000).fill(2) });
    const together = new Uint8Array([...one, ...two]);
    const slow = new FrameReader();
    const seen: unknown[] = [];
    for (const byte of together) for (const frame of slow.push(new Uint8Array([byte]))) seen.push(frame.message);
    expect(seen.map(m => (m as { id: number }).id)).toEqual([1, 2]);
    expect(new FrameReader().push(together).map(f => (f.message as { id: number }).id)).toEqual([1, 2]);
    const split = new FrameReader();
    expect(split.push(together.subarray(0, 12))).toEqual([]);
    expect(split.push(together.subarray(12)).map(f => (f.message as { id: number }).id)).toEqual([1, 2]);
  });

  test('refuses a message over the bound before it is built, and a length over the bound before it is read', () => {
    expect(() => encodeFrame({ samples: new Float32Array(MAX_FRAME_BYTES / 4) })).toThrow(FrameError);
    const prefix = new Uint8Array(8);
    prefix.set([0x46, 0x59, 0x53, 0x48]);
    new DataView(prefix.buffer).setUint32(4, MAX_FRAME_BYTES + 1);
    expect(() => new FrameReader().push(prefix)).toThrow(/too large/u);
  });

  test('bytes that are not a frame, a cut header and a pointer outside the frame are all refused', () => {
    expect(() => new FrameReader().push(new TextEncoder().encode('a library printing a line\n'))).toThrow(FrameError);
    const good = encodeFrame({ a: new Uint8Array(4).buffer });
    const broken = good.slice();
    new DataView(broken.buffer).setUint32(8, 10_000); // a header longer than the frame
    expect(() => new FrameReader().push(broken)).toThrow(/cut short/u);
    const text = new TextDecoder().decode(good.subarray(12, 12 + new DataView(good.buffer).getUint32(8)));
    expect(text).toContain('$bin');
    const header = new TextEncoder().encode(text.replace('"$bin":0', '"$bin":9999'));
    const lying = new Uint8Array(12 + header.length + 4);
    lying.set(good.subarray(0, 12));
    new DataView(lying.buffer).setUint32(4, 4 + header.length + 4);
    new DataView(lying.buffer).setUint32(8, header.length);
    lying.set(header, 12);
    expect(() => new FrameReader().push(lying)).toThrow(/pointed outside/u);
  });
});

describe('frames of raw bytes', () => {
  test('a Uint8Array (a model byte-run that is not a whole ArrayBuffer) comes back as a Uint8Array of the same bytes', () => {
    const whole = new Uint8Array([9, 8, 7, 6, 5]);
    const [frame] = new FrameReader().push(encodeFrame({ bytes: whole.subarray(1, 4) }));
    const back = (frame as { message: { bytes: Uint8Array } }).message.bytes;
    expect(back).toBeInstanceOf(Uint8Array);
    expect([...back]).toEqual([8, 7, 6]);
  });
});

describe('a frame whose header is not JSON', () => {
  test('is refused as unreadable, not guessed at', () => {
    const header = new TextEncoder().encode('{nope');
    const frame = new Uint8Array(12 + header.length);
    frame.set([0x46, 0x59, 0x53, 0x48]);
    new DataView(frame.buffer).setUint32(4, 4 + header.length);
    new DataView(frame.buffer).setUint32(8, header.length);
    frame.set(header, 12);
    expect(() => new FrameReader().push(frame)).toThrow(/could not be read/u);
  });
});
