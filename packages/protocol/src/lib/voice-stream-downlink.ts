/**
 * The downlink unit of the voice stream — a 2-byte length and UTF-8 JSON, zero-padded to 1,024 bytes —
 * and the fragments a turn's words travel in.
 *
 * Contract: `docs/voice-stream.md` §4 – §6. Pure and total — a bad unit is a `VoiceResult` error.
 */
import { z } from 'zod';
import {
  VOICE_DOWNLINK_JSON_MAX_BYTES,
  VOICE_DOWNLINK_LENGTH_BYTES,
  VOICE_DOWNLINK_UNIT_BYTES,
  VOICE_FRAGMENT_TEXT_MAX_BYTES,
  VOICE_TURN_WORDS_MAX_BYTES,
  VoiceCounterSchema,
  type VoiceNonce,
  VoiceNonceSchema,
  type VoiceResult,
  voiceErr,
  voiceIsWellFormed,
  voiceOk,
  voiceParseJson,
  voiceUtf8,
  voiceUtf8Decode,
} from './voice-stream.ts';

/** The in-stream failures the plan names (§1.4). The field accepts any token of the same shape. */
export const VOICE_STREAM_ERROR_CODES = ['engine_behind', 'engine_timeout'] as const;

export const VoiceStreamStateSchema = z.enum(['listening', 'hearing', 'finishing', 'counting', 'held', 'muted']);
export type VoiceStreamState = z.infer<typeof VoiceStreamStateSchema>;

const SafeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A bounded piece of a turn's words. `offset` and `total` count UTF-8 bytes. */
export interface VoiceFragment {
  readonly turnId: number;
  readonly revision: number;
  readonly offset: number;
  readonly total: number;
  readonly text: string;
}

/** A pending send. `sendAt` and `now` are unix milliseconds on the daemon's clock. */
export interface VoiceCountdown {
  readonly turnId: number;
  readonly revision: number;
  readonly sendAt: number;
  readonly now: number;
}

/** One downlink unit, decoded. Every unit stands on its own. */
export interface VoiceDownlinkUnit {
  readonly nonce: VoiceNonce;
  readonly state: VoiceStreamState;
  readonly countdown?: VoiceCountdown;
  readonly sent?: { readonly sendId: string };
  readonly error?: { readonly code: string };
  readonly fragment?: VoiceFragment;
}

const WireSchema = z.strictObject({
  n: VoiceNonceSchema,
  s: VoiceStreamStateSchema,
  c: z.strictObject({ t: VoiceCounterSchema, r: VoiceCounterSchema, at: SafeCount, now: SafeCount }).optional(),
  d: z
    .string()
    .regex(/^[A-Za-z0-9_:.-]{1,64}$/)
    .optional(),
  e: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .optional(),
  f: z
    .strictObject({ t: VoiceCounterSchema, r: VoiceCounterSchema, o: SafeCount, l: SafeCount, x: z.string() })
    .optional(),
});
type Wire = z.infer<typeof WireSchema>;

/** The bytes a string takes inside a JSON string, quotes excluded: a quote costs two, a control six. */
export const voiceEscapedBytes = (text: string): number => voiceUtf8(JSON.stringify(text)).byteLength - 2;

/** The UTF-8 length of a string. */
const utf8Length = (text: string): number => voiceUtf8(text).byteLength;

/**
 * A fragment's own consistency, which needs no other fragment: a total within the ceiling, text that is
 * well-formed and fits the cap, an end inside the total, and no empty piece of a non-empty total.
 */
export function checkVoiceFragment(fragment: VoiceFragment): VoiceResult<VoiceFragment> {
  if (fragment.total > VOICE_TURN_WORDS_MAX_BYTES)
    return voiceErr('fragment_total', 'a turn revision is over its size ceiling');
  if (!voiceIsWellFormed(fragment.text)) return voiceErr('fragment_text', 'the fragment text is not well-formed');
  if (voiceEscapedBytes(fragment.text) > VOICE_FRAGMENT_TEXT_MAX_BYTES)
    return voiceErr('fragment_inconsistent', 'the fragment text is over its per-unit cap');
  const length = utf8Length(fragment.text);
  if (fragment.offset + length > fragment.total)
    return voiceErr('fragment_inconsistent', 'the fragment runs past its total');
  if (fragment.total > 0 && length === 0)
    return voiceErr('fragment_inconsistent', 'an empty fragment of a non-empty revision');
  return voiceOk(fragment);
}

const wireOf = (unit: VoiceDownlinkUnit): Record<string, unknown> => {
  const wire: Record<string, unknown> = { n: unit.nonce, s: unit.state };
  if (unit.countdown !== undefined)
    wire.c = {
      t: unit.countdown.turnId,
      r: unit.countdown.revision,
      at: unit.countdown.sendAt,
      now: unit.countdown.now,
    };
  if (unit.sent !== undefined) wire.d = unit.sent.sendId;
  if (unit.error !== undefined) wire.e = unit.error.code;
  if (unit.fragment !== undefined)
    wire.f = {
      t: unit.fragment.turnId,
      r: unit.fragment.revision,
      o: unit.fragment.offset,
      l: unit.fragment.total,
      x: unit.fragment.text,
    };
  return wire;
};

const unitOf = (wire: Wire): VoiceDownlinkUnit => ({
  nonce: wire.n,
  state: wire.s,
  ...(wire.c === undefined
    ? {}
    : { countdown: { turnId: wire.c.t, revision: wire.c.r, sendAt: wire.c.at, now: wire.c.now } }),
  ...(wire.d === undefined ? {} : { sent: { sendId: wire.d } }),
  ...(wire.e === undefined ? {} : { error: { code: wire.e } }),
  ...(wire.f === undefined
    ? {}
    : { fragment: { turnId: wire.f.t, revision: wire.f.r, offset: wire.f.o, total: wire.f.l, text: wire.f.x } }),
});

/**
 * The bytes of one downlink unit. A unit that is not valid is `unit_shape` (or the fragment's own
 * code); one whose JSON would pass 1,022 bytes is `unit_too_large`. Never truncates, never throws.
 */
export function encodeDownlinkUnit(unit: VoiceDownlinkUnit): VoiceResult<Uint8Array> {
  const wire = wireOf(unit);
  if (!WireSchema.safeParse(wire).success) return voiceErr('unit_shape', 'the unit is not a valid downlink unit');
  if (unit.fragment !== undefined) {
    const checked = checkVoiceFragment(unit.fragment);
    if (!checked.ok) return checked;
  }
  return packDownlinkJson(JSON.stringify(wire));
}

/**
 * The unit's bytes for already-serialised JSON: length, body, zeros. Over 1,022 bytes is
 * `unit_too_large` — never a truncation. The worst valid unit is proved to fit, so only a caller handing
 * this JSON of its own can reach the refusal.
 */
export function packDownlinkJson(jsonText: string): VoiceResult<Uint8Array> {
  const json = voiceUtf8(jsonText);
  if (json.byteLength > VOICE_DOWNLINK_JSON_MAX_BYTES)
    return voiceErr('unit_too_large', 'the unit JSON is longer than a downlink unit holds');
  const out = new Uint8Array(VOICE_DOWNLINK_UNIT_BYTES);
  new DataView(out.buffer).setUint16(0, json.byteLength, false);
  out.set(json, VOICE_DOWNLINK_LENGTH_BYTES);
  return voiceOk(out);
}

/** Reads one downlink unit. Exactly 1,024 bytes in; every refusal in the document's §4.1 is a value. */
export function decodeDownlinkUnit(bytes: Uint8Array): VoiceResult<VoiceDownlinkUnit> {
  if (bytes.byteLength !== VOICE_DOWNLINK_UNIT_BYTES)
    return voiceErr('unit_size', `a downlink unit is exactly ${String(VOICE_DOWNLINK_UNIT_BYTES)} bytes`);
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, false);
  if (length === 0 || length > VOICE_DOWNLINK_JSON_MAX_BYTES)
    return voiceErr('unit_length', 'the downlink length is zero or past the unit');
  const end = VOICE_DOWNLINK_LENGTH_BYTES + length;
  for (let index = end; index < VOICE_DOWNLINK_UNIT_BYTES; index += 1)
    if (bytes[index] !== 0) return voiceErr('unit_padding', 'the downlink padding is not zero');
  const text = voiceUtf8Decode(bytes.subarray(VOICE_DOWNLINK_LENGTH_BYTES, end));
  const json = text === undefined ? undefined : voiceParseJson(text);
  if (json === undefined) return voiceErr('unit_encoding', 'the downlink body is not UTF-8 JSON');
  const wire = WireSchema.safeParse(json.value);
  if (!wire.success) return voiceErr('unit_shape', 'the downlink body is not a downlink unit');
  const unit = unitOf(wire.data);
  if (unit.fragment !== undefined) {
    const checked = checkVoiceFragment(unit.fragment);
    if (!checked.ok) return checked;
  }
  return voiceOk(unit);
}

// ── Making fragments ───────────────────────────────────────────────────────────────────────────────

/**
 * A revision's text as the fragments that carry it: contiguous, cut on code-point boundaries (an emoji
 * or a CJK character is never split), each at most `VOICE_FRAGMENT_TEXT_MAX_BYTES` as JSON spells it.
 * Empty text is one empty fragment. Over 16 KB, an unfit counter or text that is not well-formed is an
 * error, not a truncation.
 */
export function fragmentTurnWords(words: {
  readonly turnId: number;
  readonly revision: number;
  readonly text: string;
}): VoiceResult<readonly VoiceFragment[]> {
  const { turnId, revision, text } = words;
  if (!VoiceCounterSchema.safeParse(turnId).success || !VoiceCounterSchema.safeParse(revision).success)
    return voiceErr('fragment_inconsistent', 'a turn and a revision are unsigned 32-bit integers');
  if (!voiceIsWellFormed(text)) return voiceErr('fragment_text', 'the text is not well-formed');
  const total = utf8Length(text);
  if (total > VOICE_TURN_WORDS_MAX_BYTES) return voiceErr('fragment_total', 'the text is over its size ceiling');
  if (total === 0) return voiceOk([{ turnId, revision, offset: 0, total: 0, text: '' }]);
  const fragments: VoiceFragment[] = [];
  let piece = '';
  let pieceEscaped = 0;
  let offset = 0;
  const flush = (): void => {
    fragments.push({ turnId, revision, offset, total, text: piece });
    offset += utf8Length(piece);
    piece = '';
    pieceEscaped = 0;
  };
  for (const codePoint of text) {
    const escaped = voiceEscapedBytes(codePoint);
    if (pieceEscaped + escaped > VOICE_FRAGMENT_TEXT_MAX_BYTES) flush();
    piece += codePoint;
    pieceEscaped += escaped;
  }
  flush();
  return voiceOk(fragments);
}

// ── Reassembling ───────────────────────────────────────────────────────────────────────────────────

/** The newest turn revision a browser has seen, and as much of its text as has arrived. */
export interface TurnWords {
  readonly turnId: number;
  readonly revision: number;
  readonly total: number;
  /** UTF-8 bytes received so far. */
  readonly received: number;
  /** The text so far. Show it; but it is the revision only when `complete`. */
  readonly text: string;
  /** True only when the whole revision has arrived — what a `shown` control may be sent for. */
  readonly complete: boolean;
}

/** Applies one fragment to the assembly (`undefined` before the first). The rules are the document's §6.2. */
export function applyVoiceFragment(words: TurnWords | undefined, fragment: VoiceFragment): VoiceResult<TurnWords> {
  const checked = checkVoiceFragment(fragment);
  if (!checked.ok) return checked;
  const length = utf8Length(fragment.text);
  if (words !== undefined) {
    const stale =
      fragment.turnId < words.turnId || (fragment.turnId === words.turnId && fragment.revision < words.revision);
    if (stale) return voiceErr('fragment_inconsistent', 'a fragment of an older turn or revision');
  }
  if (words === undefined || fragment.turnId !== words.turnId || fragment.revision !== words.revision) {
    if (fragment.offset !== 0) return voiceErr('fragment_inconsistent', 'a new revision must begin at offset zero');
    return voiceOk({
      turnId: fragment.turnId,
      revision: fragment.revision,
      total: fragment.total,
      received: length,
      text: fragment.text,
      complete: length === fragment.total,
    });
  }
  if (words.complete) return voiceErr('fragment_inconsistent', 'a fragment of a revision that is already whole');
  if (fragment.total !== words.total) return voiceErr('fragment_inconsistent', 'the total changed within a revision');
  if (fragment.offset !== words.received)
    return voiceErr('fragment_inconsistent', 'a fragment is not contiguous with what has arrived');
  const received = words.received + length;
  return voiceOk({ ...words, received, text: words.text + fragment.text, complete: received === words.total });
}
