import { z } from 'zod';

/**
 * The voice stream (`GET /v1/voice/stream`, design `docs/design/voice-modes.md` §3.1, as built by unit 4): the phone or
 * browser sends its microphone to the machine, and the machine answers with the words it hears. It is a §14 stream
 * session, so the same route table, capability guard and device proof serve it on every carrier, and a relay changes
 * nothing.
 *
 * BOTH DIRECTIONS ARE FIXED-SIZE BINARY UNITS. A relay sees only that a stream is open and its constant rates, never
 * when anyone speaks or pauses: silence and muted time are zero samples, and the downlink is a fixed tick. A `bytes`
 * record's boundaries are not preserved, so each side re-assembles units from the byte stream ({@link UnitAssembler}).
 *
 * Owner decision O1 (2026-11-24): there is NO countdown. The machine sends the message at once after the pause, so the
 * old `shown`, `hold` and `send-now` controls do not exist. What keeps a dead phone from sending is the nonce proof:
 * the send waits for an echo of a nonce the machine issued AFTER the pause was heard.
 */

export const STREAM_SAMPLE_RATE = 16_000;
/** One uplink unit is 40 ms of audio: 640 samples of PCM16, little endian, then the control slot. */
export const UNIT_MS = 40;
export const UNIT_SAMPLES = 640;
export const PCM_BYTES = UNIT_SAMPLES * 2;
export const CONTROL_SLOT_BYTES = 64;
export const UPLINK_UNIT_BYTES = PCM_BYTES + CONTROL_SLOT_BYTES;
/** One downlink unit every 200 ms: a 2-byte length, UTF-8 JSON, zero padding. */
export const DOWNLINK_UNIT_BYTES = 1024;
export const DOWNLINK_JSON_MAX_BYTES = DOWNLINK_UNIT_BYTES - 2;
export const TICK_MS = 200;
/** A turn ends here whatever the voice is doing (the design's endpointer cap). */
export const TURN_MAX_MS = 120_000;
/** A stream ends after two hours and the browser opens another. */
export const STREAM_MAX_MS = 2 * 60 * 60 * 1000;
/** The longest transcript the browser will reassemble; far above 120 s of speech. */
export const WORDS_MAX_CHARS = 16_384;
/** The nonce echo must arrive this soon after the machine could have sent the send. */
export const PROOF_WINDOW_MS = 1_000;
/** No uplink unit for this long and the phone is treated as gone. */
export const SILENT_PHONE_MS = 5_000;

/** The nonce the machine issues in every downlink unit: 8 random bytes, as 16 lowercase hex characters. */
export const NONCE_PATTERN = /^[0-9a-f]{16}$/u;
const NONCE_BYTES = 8;

/** How long a silence ends a turn. "Normal" is the design's 1.5 s; the others are tuned by unit 5's numbers. */
export const PAUSE_STYLES = { quick: 1_000, normal: 1_500, thinker: 2_500 } as const;
export const PauseStyleSchema = z.enum(['quick', 'normal', 'thinker']);
export type PauseStyle = z.infer<typeof PauseStyleSchema>;

/** The first record of a stream, as one text frame. Anything else first is a protocol error. */
export const StreamStartSchema = z.discriminatedUnion('purpose', [
  /** Live words only: nothing is sent to a ferret (Settings › Voice › Talk to test). */
  z.strictObject({
    t: z.literal('start'),
    v: z.literal(1),
    purpose: z.literal('test'),
    style: PauseStyleSchema.optional(),
  }),
  /** Voice mode: each finished turn is sent to this ferret as the person's own message. */
  z.strictObject({
    t: z.literal('start'),
    v: z.literal(1),
    purpose: z.literal('chat'),
    ferretId: z.string().min(1).max(128),
    style: PauseStyleSchema.optional(),
  }),
]);
export type StreamStart = z.infer<typeof StreamStartSchema>;

/** What the uplink's one optional control says. `end` is the person leaving voice mode. */
export const CONTROLS = { none: 0, muted: 1, unmuted: 2, end: 3 } as const;
export type StreamControl = keyof typeof CONTROLS;
const CONTROL_NAMES = Object.fromEntries(Object.entries(CONTROLS).map(([name, code]) => [code, name])) as Record<
  number,
  StreamControl
>;

/** Raised for a unit that does not parse: the stream is closed with a protocol error (4400), never repaired. */
export class StreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamProtocolError';
  }
}

export interface UplinkUnit {
  /** 640 samples. */
  readonly pcm: Int16Array;
  readonly control: StreamControl;
  /** The newest nonce this device has seen, or `undefined` before the first downlink unit. */
  readonly echo: string | undefined;
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(NONCE_BYTES);
  for (let index = 0; index < NONCE_BYTES; index += 1)
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

/** One 1,344-byte unit: PCM, then the 64-byte control slot (`[control, ...8 echo bytes, zero padding]`). */
export function encodeUplinkUnit(unit: UplinkUnit): Uint8Array {
  if (unit.pcm.length !== UNIT_SAMPLES) throw new StreamProtocolError(`an uplink unit holds ${UNIT_SAMPLES} samples`);
  const out = new Uint8Array(UPLINK_UNIT_BYTES);
  const view = new DataView(out.buffer);
  for (let index = 0; index < UNIT_SAMPLES; index += 1) view.setInt16(index * 2, unit.pcm[index] ?? 0, true);
  out[PCM_BYTES] = CONTROLS[unit.control];
  if (unit.echo !== undefined) {
    if (!NONCE_PATTERN.test(unit.echo)) throw new StreamProtocolError('a nonce is 16 hexadecimal characters');
    out.set(bytesOf(unit.echo), PCM_BYTES + 1);
  }
  return out;
}

const ZERO_ECHO = '0000000000000000';

export function decodeUplinkUnit(bytes: Uint8Array): UplinkUnit {
  if (bytes.byteLength !== UPLINK_UNIT_BYTES) throw new StreamProtocolError('an uplink unit is the wrong size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pcm = new Int16Array(UNIT_SAMPLES);
  for (let index = 0; index < UNIT_SAMPLES; index += 1) pcm[index] = view.getInt16(index * 2, true);
  const control = CONTROL_NAMES[bytes[PCM_BYTES] ?? -1];
  if (control === undefined) throw new StreamProtocolError('an uplink control is not one the stream defines');
  for (let index = PCM_BYTES + 1 + NONCE_BYTES; index < UPLINK_UNIT_BYTES; index += 1)
    if (bytes[index] !== 0) throw new StreamProtocolError('an uplink control slot is not zero padded');
  const echo = hexOf(bytes.subarray(PCM_BYTES + 1, PCM_BYTES + 1 + NONCE_BYTES));
  return { pcm, control, echo: echo === ZERO_ECHO ? undefined : echo };
}

/** What the machine is doing for this stream. */
export const StreamStateSchema = z.enum(['loading', 'listening', 'hearing', 'working', 'muted']);
export type StreamState = z.infer<typeof StreamStateSchema>;

/** One piece of a turn's words. A transcript longer than a unit arrives over consecutive ticks at rising offsets. */
export const WordsFragmentSchema = z.strictObject({
  turn: z.number().int().nonnegative(),
  rev: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().max(WORDS_MAX_CHARS),
  text: z.string(),
  final: z.boolean(),
});
export type WordsFragment = z.infer<typeof WordsFragmentSchema>;

/** How the last turn ended, kept in every unit until the next turn starts so a lost unit loses nothing. */
export const TurnOutcomeSchema = z.strictObject({
  turn: z.number().int().nonnegative(),
  outcome: z.enum(['sent', 'heard', 'dropped', 'cancelled', 'failed']),
  /** Only a `sent` turn: the stable send id (`<streamId>:<turn>`). */
  sendId: z.string().min(1).max(160).optional(),
  /** Only a turn that did not send: why (`no_words`, `phone_silent`, `engine_behind`, `engine_timeout`, `send_refused`, …). */
  code: z.string().min(1).max(64).optional(),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

export const StreamSnapshotSchema = z.strictObject({
  v: z.literal(1),
  state: StreamStateSchema,
  nonce: z.string().regex(NONCE_PATTERN),
  /** The turn in progress, or the next one to start. */
  turn: z.number().int().nonnegative(),
  words: WordsFragmentSchema.optional(),
  last: TurnOutcomeSchema.optional(),
  /** A fatal refusal: the stream closes right after this unit. Fixed sentences only; never a transcript. */
  error: z.strictObject({ code: z.string().min(1).max(64), message: z.string().min(1).max(200) }).optional(),
});
export type StreamSnapshot = z.infer<typeof StreamSnapshotSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** The unit's JSON length in bytes, so a fragment can be sized to fit. */
export const snapshotBytes = (snapshot: StreamSnapshot): number => encoder.encode(JSON.stringify(snapshot)).byteLength;

export function encodeDownlinkUnit(snapshot: StreamSnapshot): Uint8Array {
  const json = encoder.encode(JSON.stringify(StreamSnapshotSchema.parse(snapshot)));
  if (json.byteLength > DOWNLINK_JSON_MAX_BYTES)
    throw new StreamProtocolError('a downlink snapshot does not fit its unit');
  const out = new Uint8Array(DOWNLINK_UNIT_BYTES);
  new DataView(out.buffer).setUint16(0, json.byteLength);
  out.set(json, 2);
  return out;
}

export function decodeDownlinkUnit(bytes: Uint8Array): StreamSnapshot {
  if (bytes.byteLength !== DOWNLINK_UNIT_BYTES) throw new StreamProtocolError('a downlink unit is the wrong size');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0);
  if (length === 0 || length > DOWNLINK_JSON_MAX_BYTES)
    throw new StreamProtocolError('a downlink length is past its unit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes.subarray(2, 2 + length)));
  } catch {
    throw new StreamProtocolError('a downlink unit is not valid JSON');
  }
  const snapshot = StreamSnapshotSchema.safeParse(parsed);
  if (!snapshot.success) throw new StreamProtocolError('a downlink unit is not a snapshot');
  return snapshot.data;
}

/**
 * Cuts a byte stream into fixed-size units. A `bytes` record is a run of an ordered stream whose boundaries are not
 * preserved, so one record may hold half a unit or three; the unit size is the only boundary there is.
 */
export class UnitAssembler {
  private held = new Uint8Array(0);
  constructor(private readonly unitBytes: number) {}

  push(bytes: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.held.byteLength + bytes.byteLength);
    joined.set(this.held, 0);
    joined.set(bytes, this.held.byteLength);
    const units: Uint8Array[] = [];
    let at = 0;
    for (; at + this.unitBytes <= joined.byteLength; at += this.unitBytes)
      units.push(joined.slice(at, at + this.unitBytes));
    this.held = joined.slice(at);
    return units;
  }

  /** Bytes of a unit not yet complete: non-zero at the end of a stream is a stream that ended mid-unit. */
  get pending(): number {
    return this.held.byteLength;
  }
}

/**
 * The browser's side of the fragments: the words of one `(turn, rev)`, rebuilt from consecutive ticks. A newer revision
 * replaces the older at once; a fragment whose offset is not where the last one ended, or whose total changed, is a
 * protocol error.
 */
export class WordsAssembler {
  private key: string | undefined;
  private text = '';
  private total = 0;

  /** The whole revision once its last fragment is in, else `undefined`. */
  accept(
    fragment: WordsFragment,
  ): { readonly turn: number; readonly rev: number; readonly text: string; readonly final: boolean } | undefined {
    const key = `${fragment.turn}:${fragment.rev}`;
    if (key !== this.key) {
      if (fragment.offset !== 0) throw new StreamProtocolError('a words revision must start at offset 0');
      this.key = key;
      this.text = '';
      this.total = fragment.total;
    } else if (fragment.total !== this.total) {
      throw new StreamProtocolError('a words revision changed its total');
    }
    if (fragment.offset !== this.text.length) throw new StreamProtocolError('a words fragment is not the next one');
    this.text += fragment.text;
    if (this.text.length > this.total) throw new StreamProtocolError('a words revision is longer than its total');
    return this.text.length === this.total
      ? { turn: fragment.turn, rev: fragment.rev, text: this.text, final: fragment.final }
      : undefined;
  }
}

/** The close codes the stream ends with. 1000 is a normal end; 44xx follow the session's own 4400 family. */
export const STREAM_CLOSES = {
  ended: { code: 1000, reason: 'voice stream ended' },
  protocol: { code: 4400, reason: 'voice stream protocol error' },
  silentPhone: { code: 4408, reason: 'the device went silent' },
  busy: { code: 4429, reason: 'voice stream is busy' },
  tooFast: { code: 1008, reason: 'audio arrived faster than real time' },
  overloaded: { code: 4450, reason: 'the machine could not keep up' },
  failed: { code: 1011, reason: 'speech failed on the machine' },
} as const;
