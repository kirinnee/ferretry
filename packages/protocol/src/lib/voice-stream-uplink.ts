/**
 * The uplink unit of the voice stream: 1,280 bytes of PCM and a 64-byte control slot.
 *
 * Contract: `docs/voice-stream.md` §3. Pure and total — a bad unit is a `VoiceResult` error.
 */
import { z } from 'zod';
import {
  VOICE_UPLINK_PCM_BYTES,
  VOICE_UPLINK_PCM_SAMPLES,
  VOICE_UPLINK_SLOT_JSON_MAX_BYTES,
  VOICE_UPLINK_UNIT_BYTES,
  VoiceCounterSchema,
  type VoiceNonce,
  VoiceNonceSchema,
  type VoiceResult,
  voiceErr,
  voiceOk,
  voiceParseJson,
  voiceUtf8,
  voiceUtf8Decode,
} from './voice-stream.ts';

/** At most one control per unit. */
export type VoiceUplinkControl =
  | { readonly kind: 'shown'; readonly turnId: number; readonly revision: number }
  | { readonly kind: 'hold'; readonly turnId: number }
  | { readonly kind: 'send-now'; readonly turnId: number }
  | { readonly kind: 'muted' }
  | { readonly kind: 'unmuted' }
  | { readonly kind: 'end' };

/** One uplink unit, decoded: 640 samples, the newest nonce echo, and at most one control. */
export interface VoiceUplinkUnit {
  readonly pcm: Int16Array;
  readonly echo?: VoiceNonce;
  readonly control?: VoiceUplinkControl;
}

const echo = VoiceNonceSchema.optional();

/** The slot's JSON, strict: an echo alone, or an echo (optional) with exactly one control. */
const SlotSchema = z.union([
  z.strictObject({ n: VoiceNonceSchema }),
  z.strictObject({ n: echo, k: z.enum(['muted', 'unmuted', 'end']) }),
  z.strictObject({ n: echo, k: z.enum(['hold', 'send-now']), t: VoiceCounterSchema }),
  z.strictObject({ n: echo, k: z.literal('shown'), t: VoiceCounterSchema, r: VoiceCounterSchema }),
]);
type Slot = z.infer<typeof SlotSchema>;

const slotToUnitParts = (slot: Slot): { readonly echo?: VoiceNonce; readonly control?: VoiceUplinkControl } => {
  const base = slot.n === undefined ? {} : { echo: slot.n };
  if (!('k' in slot)) return base;
  switch (slot.k) {
    case 'shown':
      return { ...base, control: { kind: 'shown', turnId: slot.t, revision: slot.r } };
    case 'hold':
    case 'send-now':
      return { ...base, control: { kind: slot.k, turnId: slot.t } };
    case 'muted':
    case 'unmuted':
    case 'end':
      return { ...base, control: { kind: slot.k } };
  }
};

/** The slot's JSON object for an echo and a control, members in the order the document fixes. */
const slotObject = (unit: Pick<VoiceUplinkUnit, 'echo' | 'control'>): Record<string, unknown> | undefined => {
  const { echo: nonce, control } = unit;
  if (nonce === undefined && control === undefined) return undefined;
  const slot: Record<string, unknown> = {};
  if (nonce !== undefined) slot.n = nonce;
  if (control !== undefined) {
    slot.k = control.kind;
    if ('turnId' in control) slot.t = control.turnId;
    if ('revision' in control) slot.r = control.revision;
  }
  return slot;
};

/**
 * The bytes of one uplink unit. A PCM block that is not 640 samples is `unit_size`; an echo or control
 * that is not a valid slot is `slot_shape`. Never throws, never truncates.
 */
export function encodeUplinkUnit(unit: VoiceUplinkUnit): VoiceResult<Uint8Array> {
  const slot = slotObject(unit);
  if (slot !== undefined && !SlotSchema.safeParse(slot).success)
    return voiceErr('slot_shape', 'the echo or control is not a valid slot');
  return packUplinkUnit(unit.pcm, slot === undefined ? undefined : JSON.stringify(slot));
}

/**
 * The unit's bytes for a PCM block and already-serialised slot JSON (`undefined` is the empty slot).
 * JSON over 63 bytes is `slot_length` — never a truncation. The worst valid slot is proved to fit, so
 * only a caller handing this JSON of its own can reach the refusal.
 */
export function packUplinkUnit(pcm: Int16Array, slotJsonText: string | undefined): VoiceResult<Uint8Array> {
  if (pcm.length !== VOICE_UPLINK_PCM_SAMPLES)
    return voiceErr('unit_size', `an uplink unit carries exactly ${String(VOICE_UPLINK_PCM_SAMPLES)} samples`);
  const json = slotJsonText === undefined ? new Uint8Array(0) : voiceUtf8(slotJsonText);
  if (json.byteLength > VOICE_UPLINK_SLOT_JSON_MAX_BYTES)
    return voiceErr('slot_length', 'the slot JSON is longer than the slot holds');
  const out = new Uint8Array(VOICE_UPLINK_UNIT_BYTES);
  const view = new DataView(out.buffer);
  for (let index = 0; index < VOICE_UPLINK_PCM_SAMPLES; index += 1) view.setInt16(index * 2, pcm[index] ?? 0, true);
  out[VOICE_UPLINK_PCM_BYTES] = json.byteLength;
  out.set(json, VOICE_UPLINK_PCM_BYTES + 1);
  return voiceOk(out);
}

/** Reads one uplink unit. Exactly 1,344 bytes in; every refusal in the document's §3.2 is a value. */
export function decodeUplinkUnit(bytes: Uint8Array): VoiceResult<VoiceUplinkUnit> {
  if (bytes.byteLength !== VOICE_UPLINK_UNIT_BYTES)
    return voiceErr('unit_size', `an uplink unit is exactly ${String(VOICE_UPLINK_UNIT_BYTES)} bytes`);
  const length = bytes[VOICE_UPLINK_PCM_BYTES] ?? 0;
  if (length > VOICE_UPLINK_SLOT_JSON_MAX_BYTES)
    return voiceErr('slot_length', 'the control slot length is past the slot');
  const jsonStart = VOICE_UPLINK_PCM_BYTES + 1;
  for (let index = jsonStart + length; index < VOICE_UPLINK_UNIT_BYTES; index += 1)
    if (bytes[index] !== 0) return voiceErr('slot_padding', 'the control slot padding is not zero');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pcm = new Int16Array(VOICE_UPLINK_PCM_SAMPLES);
  for (let index = 0; index < VOICE_UPLINK_PCM_SAMPLES; index += 1) pcm[index] = view.getInt16(index * 2, true);
  if (length === 0) return voiceOk({ pcm });
  const text = voiceUtf8Decode(bytes.subarray(jsonStart, jsonStart + length));
  const json = text === undefined ? undefined : voiceParseJson(text);
  if (json === undefined) return voiceErr('slot_encoding', 'the control slot is not UTF-8 JSON');
  const slot = SlotSchema.safeParse(json.value);
  if (!slot.success) return voiceErr('slot_shape', 'the control slot is not an echo and at most one control');
  return voiceOk({ pcm, ...slotToUnitParts(slot.data) });
}

/**
 * Float samples in [-1, 1] as signed 16-bit: the Web Audio convention (negative scales by 32768,
 * positive by 32767), clamped, with NaN as silence.
 */
export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const raw = samples[index] ?? 0;
    const clamped = Number.isNaN(raw) ? 0 : Math.max(-1, Math.min(1, raw));
    out[index] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return out;
}

/** Signed 16-bit samples as floats in [-1, 1]; the inverse of {@link float32ToInt16}. */
export function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    out[index] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return out;
}
