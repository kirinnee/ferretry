/**
 * Re-assembling fixed-size voice stream units from an ordered byte stream whose record boundaries
 * mean nothing (`docs/voice-stream.md` §7).
 *
 * A value, not an object: every step takes the old state and answers the new one, nothing is mutated and
 * nothing throws. The state holds at most one partial unit; one feed is bounded by
 * `VOICE_REASSEMBLER_MAX_RUN_BYTES`.
 */
import { decodeDownlinkUnit, type VoiceDownlinkUnit } from './voice-stream-downlink.ts';
import { decodeUplinkUnit, type VoiceUplinkUnit } from './voice-stream-uplink.ts';
import {
  VOICE_DOWNLINK_UNIT_BYTES,
  VOICE_REASSEMBLER_MAX_RUN_BYTES,
  VOICE_UPLINK_UNIT_BYTES,
  type VoiceResult,
  voiceConcat,
  voiceErr,
  voiceOk,
} from './voice-stream.ts';

/** Bytes received that do not yet make a whole unit — always fewer than one unit's worth. */
export interface VoiceReassembly {
  readonly pending: Uint8Array;
}

export const EMPTY_VOICE_REASSEMBLY: VoiceReassembly = { pending: new Uint8Array(0) };

export interface VoiceReassemblyStep<Unit> {
  readonly reassembly: VoiceReassembly;
  /** Every unit this run completed, decoded, in order. */
  readonly units: readonly Unit[];
}

function feed<Unit>(
  unitBytes: number,
  decode: (bytes: Uint8Array) => VoiceResult<Unit>,
  reassembly: VoiceReassembly,
  run: Uint8Array,
): VoiceResult<VoiceReassemblyStep<Unit>> {
  if (run.byteLength > VOICE_REASSEMBLER_MAX_RUN_BYTES)
    return voiceErr('run_too_large', 'a run of bytes is over the reassembler limit');
  const whole = reassembly.pending.byteLength === 0 ? run : voiceConcat([reassembly.pending, run]);
  const units: Unit[] = [];
  let offset = 0;
  while (whole.byteLength - offset >= unitBytes) {
    const decoded = decode(whole.subarray(offset, offset + unitBytes));
    if (!decoded.ok) return decoded;
    units.push(decoded.value);
    offset += unitBytes;
  }
  // A plain owned copy: `Buffer#slice` is a VIEW, so slicing would alias the caller's memory (which it may
  // overwrite) and keep its whole backing store alive. `Uint8Array.from` always allocates a fresh buffer.
  return voiceOk({ reassembly: { pending: Uint8Array.from(whole.subarray(offset)) }, units });
}

/** Feeds the daemon's receiving side: a run of the browser's bytes, answering the uplink units it completed. */
export const feedUplink = (
  reassembly: VoiceReassembly,
  run: Uint8Array,
): VoiceResult<VoiceReassemblyStep<VoiceUplinkUnit>> =>
  feed(VOICE_UPLINK_UNIT_BYTES, decodeUplinkUnit, reassembly, run);

/** Feeds the browser's receiving side: a run of the daemon's bytes, answering the downlink units it completed. */
export const feedDownlink = (
  reassembly: VoiceReassembly,
  run: Uint8Array,
): VoiceResult<VoiceReassemblyStep<VoiceDownlinkUnit>> =>
  feed(VOICE_DOWNLINK_UNIT_BYTES, decodeDownlinkUnit, reassembly, run);

/** The stream ended. Clean only on a unit boundary; any buffered byte is `stream_ended_mid_unit`. */
export function finishVoiceReassembly(reassembly: VoiceReassembly): VoiceResult<true> {
  return reassembly.pending.byteLength === 0
    ? voiceOk(true)
    : voiceErr('stream_ended_mid_unit', 'the stream ended in the middle of a unit');
}
