/**
 * The voice stream (`/v1/voice/stream`): constants, refusals, the start record and nonces.
 *
 * The wire contract is `docs/voice-stream.md` — implement against that document, not this file. This
 * module is the one place its numbers live; a test reads the document's constants table and fails if a
 * value there and the constant here disagree. Everything under `voice-stream*.ts` is pure and total: a
 * bad input is a `VoiceResult` error, never a throw, and nothing reads a clock — time is a parameter.
 */
import { z } from 'zod';

// ── Uplink: browser → daemon, one fixed unit every 40 ms ───────────────────────────────────────────

/** Samples of PCM in one uplink unit (40 ms at 16 kHz). */
export const VOICE_UPLINK_PCM_SAMPLES = 640;
/** Bytes of PCM in one uplink unit: 16-bit little-endian. */
export const VOICE_UPLINK_PCM_BYTES = 1280;
/** The control slot, its length byte included. */
export const VOICE_UPLINK_SLOT_BYTES = 64;
/** The most JSON a control slot holds. */
export const VOICE_UPLINK_SLOT_JSON_MAX_BYTES = 63;
/** One uplink unit. */
export const VOICE_UPLINK_UNIT_BYTES = 1344;
/** The nominal uplink cadence. */
export const VOICE_UPLINK_UNIT_INTERVAL_MS = 40;
/** The nominal uplink rate. */
export const VOICE_UPLINK_UNITS_PER_SECOND = 25;

// ── Downlink: daemon → browser, one fixed unit every 200 ms ────────────────────────────────────────

/** One downlink unit. */
export const VOICE_DOWNLINK_UNIT_BYTES = 1024;
/** The big-endian length prefix of a downlink unit. */
export const VOICE_DOWNLINK_LENGTH_BYTES = 2;
/** The most JSON a downlink unit holds. */
export const VOICE_DOWNLINK_JSON_MAX_BYTES = 1022;
/** The nominal downlink cadence. */
export const VOICE_DOWNLINK_UNIT_INTERVAL_MS = 200;
/** The most escaped text bytes one fragment carries; the unit's worst case is proved to fit it. */
export const VOICE_FRAGMENT_TEXT_MAX_BYTES = 700;
/** The most UTF-8 bytes one revision of a turn's words may have. */
export const VOICE_TURN_WORDS_MAX_BYTES = 16384;

// ── Nonces, the start record, and the reassembler ──────────────────────────────────────────────────

/** A nonce is this many characters of unpadded base64url. */
export const VOICE_NONCE_CHARS = 12;
/** The random bytes a nonce is made from: 9 bytes are exactly 12 base64url characters. */
export const VOICE_NONCE_RANDOM_BYTES = 9;
/** The longest start record, as bytes of UTF-8. */
export const VOICE_START_RECORD_MAX_BYTES = 1024;
/** The longest run of bytes one reassembler feed may carry. */
export const VOICE_REASSEMBLER_MAX_RUN_BYTES = 65536;

// ── The rules the daemon applies ───────────────────────────────────────────────────────────────────

/** How long a `shown` must have been received before an automatic send. */
export const VOICE_SHOWN_MIN_AGE_MS = 500;
/** The oldest the newest echoed nonce's issue time may be at the moment of an automatic send. */
export const VOICE_ECHO_MAX_AGE_MS = 1000;
/** The window the rate guard counts over. */
export const VOICE_RATE_WINDOW_MS = 5000;
/** The most uplink units one window may hold: floor(1.25 × 25 units/s × 5 s). One more closes the stream. */
export const VOICE_RATE_MAX_UNITS = 156;

/** The largest value of a turn or revision counter. */
export const VOICE_COUNTER_MAX = 0xffff_ffff;

// ── Refusals, as values ────────────────────────────────────────────────────────────────────────────

/** Every way the codec says no. A closed set: the document lists each and when it applies. */
export type VoiceStreamErrorCode =
  | 'start_invalid'
  | 'unit_size'
  | 'run_too_large'
  | 'slot_length'
  | 'slot_padding'
  | 'slot_encoding'
  | 'slot_shape'
  | 'unit_length'
  | 'unit_padding'
  | 'unit_encoding'
  | 'unit_shape'
  | 'unit_too_large'
  | 'stream_ended_mid_unit'
  | 'fragment_total'
  | 'fragment_text'
  | 'fragment_inconsistent';

export interface VoiceStreamError {
  readonly code: VoiceStreamErrorCode;
  /** A sentence for a log. Never the content that was refused. */
  readonly message: string;
}

export type VoiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: VoiceStreamError };

export const voiceOk = <T>(value: T): VoiceResult<T> => ({ ok: true, value });
export const voiceErr = (code: VoiceStreamErrorCode, message: string): VoiceResult<never> => ({
  ok: false,
  error: { code, message },
});

// ── The start record ───────────────────────────────────────────────────────────────────────────────

export const VoiceStreamPurposeSchema = z.enum(['dictation', 'voice-chat']);
export type VoiceStreamPurpose = z.infer<typeof VoiceStreamPurposeSchema>;
export const VoiceStreamStyleSchema = z.enum(['after-stop', 'real-time']);
export type VoiceStreamStyle = z.infer<typeof VoiceStreamStyleSchema>;

/** The first record a browser sends, as the one `text` record of the stream. Strict. */
export const VoiceStreamStartSchema = z.strictObject({
  purpose: VoiceStreamPurposeSchema,
  sessionId: z.string().min(1).max(128),
  style: VoiceStreamStyleSchema,
});
export type VoiceStreamStart = z.infer<typeof VoiceStreamStartSchema>;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** The UTF-8 bytes of text. */
export const voiceUtf8 = (text: string): Uint8Array => utf8Encoder.encode(text);

/** Decodes UTF-8 strictly; invalid input is `undefined` rather than a replacement character. */
export const voiceUtf8Decode = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

/** Parses JSON text; invalid input is `undefined`. A literal `null` is valid JSON and also `null`. */
export const voiceParseJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
};

/** Parses the start record's text. Total: oversize, bad JSON and a wrong shape are all `start_invalid`. */
export function parseVoiceStreamStart(text: string): VoiceResult<VoiceStreamStart> {
  if (voiceUtf8(text).byteLength > VOICE_START_RECORD_MAX_BYTES)
    return voiceErr('start_invalid', 'the start record is over its size limit');
  const json = voiceParseJson(text);
  if (json === undefined) return voiceErr('start_invalid', 'the start record is not JSON');
  const parsed = VoiceStreamStartSchema.safeParse(json.value);
  if (!parsed.success) return voiceErr('start_invalid', 'the start record is not {purpose, sessionId, style}');
  return voiceOk(parsed.data);
}

// ── Nonces ─────────────────────────────────────────────────────────────────────────────────────────

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export const VoiceNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/);
export type VoiceNonce = z.infer<typeof VoiceNonceSchema>;

/**
 * A nonce from `VOICE_NONCE_RANDOM_BYTES` random bytes. The codec holds no randomness: the caller
 * supplies the bytes, so a nonce is as unguessable as the caller's source and this stays pure. Wrong
 * length answers `undefined`.
 */
export function encodeVoiceNonce(random: Uint8Array): VoiceNonce | undefined {
  if (random.byteLength !== VOICE_NONCE_RANDOM_BYTES) return undefined;
  let out = '';
  for (let index = 0; index < VOICE_NONCE_RANDOM_BYTES; index += 3) {
    const a = random[index] ?? 0;
    const b = random[index + 1] ?? 0;
    const c = random[index + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    out +=
      (BASE64URL[(bits >> 18) & 63] ?? '') +
      (BASE64URL[(bits >> 12) & 63] ?? '') +
      (BASE64URL[(bits >> 6) & 63] ?? '') +
      (BASE64URL[bits & 63] ?? '');
  }
  return out;
}

/** A turn or revision counter: an unsigned 32-bit integer. */
export const VoiceCounterSchema = z.number().int().min(0).max(VOICE_COUNTER_MAX);

/** True for well-formed Unicode: no lone surrogate. */
export const voiceIsWellFormed = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};

/** Concatenates byte runs into one. */
export const voiceConcat = (parts: readonly Uint8Array[]): Uint8Array => {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const whole = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.byteLength;
  }
  return whole;
};
