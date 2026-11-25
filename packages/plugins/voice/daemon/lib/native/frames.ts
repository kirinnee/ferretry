/**
 * THE FRAMES THE DAEMON AND A NATIVE SPEECH HOST SAY TO EACH OTHER over the host's stdin and stdout (docs/design/voice-modes.md
 * §2.3.1). One frame is one message:
 *
 *   `FYSH` · u32 payload length · u32 header length · header (JSON) · binary parts
 *
 * The header is the message with every audio buffer and model byte-run replaced by `{ $bin: <offset>, kind, bytes }`, which
 * points into the binary parts, so a 12 MB runtime or a minute of audio is never written as JSON text. A frame is BOUNDED:
 * the length is read first and a frame over {@link MAX_FRAME_BYTES} is refused before one more byte of it is kept, so a
 * confused or hostile peer cannot make this process hold gigabytes. The reader never guesses: bytes that are not a frame end
 * the conversation (the caller then ends the host), because a stream that lost its place cannot be trusted to be at the
 * start of the next one.
 */

/** The most one frame may carry, header and binary parts together: about 35 minutes of 16 kHz audio. */
export const MAX_FRAME_BYTES = 128 * 1024 * 1024;

const MAGIC = new Uint8Array([0x46, 0x59, 0x53, 0x48]); // FYSH
const PREFIX = MAGIC.length + 4;

/** The peer sent something that is not a frame this program wrote, or one that is too large. */
export class FrameError extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'FrameError';
  }
}

type BinKind = 'f32' | 'u8' | 'ab';
interface Bin {
  readonly $bin: number;
  readonly kind: BinKind;
  readonly bytes: number;
}

const isBin = (value: unknown): value is Bin =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Bin).$bin === 'number' &&
  typeof (value as Bin).bytes === 'number' &&
  ['f32', 'u8', 'ab'].includes((value as Bin).kind);

function viewOf(value: unknown): { kind: BinKind; bytes: Uint8Array } | undefined {
  if (value instanceof ArrayBuffer) return { kind: 'ab', bytes: new Uint8Array(value) };
  if (value instanceof Float32Array)
    return { kind: 'f32', bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
  if (value instanceof Uint8Array)
    return { kind: 'u8', bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
  return undefined;
}

/** One message as a frame. Throws {@link FrameError} when it would be over {@link MAX_FRAME_BYTES}. */
export function encodeFrame(message: unknown): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  const header = new TextEncoder().encode(
    JSON.stringify(message, (_key, value: unknown) => {
      const view = viewOf(value);
      if (view === undefined) return value;
      const bin: Bin = { $bin: offset, kind: view.kind, bytes: view.bytes.byteLength };
      parts.push(view.bytes);
      offset += view.bytes.byteLength;
      return bin;
    }),
  );
  const payload = 4 + header.byteLength + offset;
  if (payload > MAX_FRAME_BYTES) throw new FrameError('That is more than one message to the speech host may carry.');
  const out = new Uint8Array(PREFIX + payload);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(MAGIC.length, payload);
  view.setUint32(PREFIX, header.byteLength);
  out.set(header, PREFIX + 4);
  let at = PREFIX + 4 + header.byteLength;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** What a frame held: the message, and the buffers that came with it (so a worker can be handed them, not a copy). */
export interface DecodedFrame {
  readonly message: unknown;
  readonly buffers: readonly ArrayBuffer[];
}

function decodePayload(payload: Uint8Array): DecodedFrame {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const headerLength = view.getUint32(0);
  if (4 + headerLength > payload.byteLength) throw new FrameError('A message from the speech host was cut short.');
  const blob = payload.subarray(4 + headerLength);
  const buffers: ArrayBuffer[] = [];
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + headerLength)), (_key, value: unknown) => {
      if (!isBin(value)) return value;
      if (value.$bin < 0 || value.bytes < 0 || value.$bin + value.bytes > blob.byteLength)
        throw new FrameError('A message from the speech host pointed outside itself.');
      // A copy, so the buffer is its own (aligned, transferable) and the frame's memory can go.
      const copy = blob.slice(value.$bin, value.$bin + value.bytes).buffer as ArrayBuffer;
      buffers.push(copy);
      if (value.kind === 'ab') return copy;
      if (value.kind === 'u8') return new Uint8Array(copy);
      if (copy.byteLength % 4 !== 0) throw new FrameError('A message from the speech host held a broken audio buffer.');
      return new Float32Array(copy);
    });
  } catch (error) {
    if (error instanceof FrameError) throw error;
    throw new FrameError('A message from the speech host could not be read.');
  }
  return { message, buffers };
}

/** Cuts a byte stream into frames. Push chunks as they arrive; each call answers the frames that are now complete. */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private held = 0;

  push(chunk: Uint8Array): DecodedFrame[] {
    this.chunks.push(chunk);
    this.held += chunk.byteLength;
    const out: DecodedFrame[] = [];
    for (;;) {
      if (this.held < PREFIX) return out;
      const head = this.take(PREFIX, false);
      for (let index = 0; index < MAGIC.length; index += 1)
        if (head[index] !== MAGIC[index]) throw new FrameError('The speech host said something that is not a message.');
      const payload = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(MAGIC.length);
      if (payload > MAX_FRAME_BYTES) throw new FrameError('The speech host sent a message that is too large.');
      if (payload < 4) throw new FrameError('The speech host sent a message that is too short.');
      if (this.held < PREFIX + payload) return out;
      this.take(PREFIX, true);
      out.push(decodePayload(this.take(payload, true)));
    }
  }

  /** The first `count` bytes held; `consume` drops them (a peek joins only what it needs, never the whole frame). */
  private take(count: number, consume: boolean): Uint8Array {
    const first = this.chunks[0];
    if (first !== undefined && first.byteLength >= count) {
      const bytes = first.subarray(0, count);
      if (consume) {
        this.held -= count;
        if (first.byteLength === count) this.chunks.shift();
        else this.chunks[0] = first.subarray(count);
      }
      return bytes;
    }
    const joined = new Uint8Array(count);
    let at = 0;
    let index = 0;
    while (at < count) {
      const chunk = this.chunks[index] as Uint8Array;
      const want = Math.min(chunk.byteLength, count - at);
      joined.set(chunk.subarray(0, want), at);
      at += want;
      if (want < chunk.byteLength) {
        if (consume) {
          this.chunks.splice(0, index);
          this.chunks[0] = chunk.subarray(want);
        }
        break;
      }
      index += 1;
      if (at >= count && consume) this.chunks.splice(0, index);
    }
    if (consume) this.held -= count;
    return joined;
  }
}
