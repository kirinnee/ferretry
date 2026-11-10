/**
 * A rendezvous REFUSAL, read off the first binary frame of a dial. The Worker explains before it hangs up
 * (`worker/src/adapters/worker.ts` `refusalUpgrade`): a control frame on the all-zero rendezvous session id carrying
 * `{t:'error', code, reason}`, THEN a close. A browser that waited only for the close would never see the sentence,
 * and the shell would fail the session with the operator's own words instead.
 *
 * Reads the 28-byte frame header by hand (magic 0xFE, version 1, kind control 0x01, 16 zero session bytes) because the
 * shell's wire decoder is not part of its public API.
 */

const FRAME_MAGIC = 0xfe;
const FRAME_VERSION = 0x01;
const CONTROL_KIND = 0x01;
const HEADER_BYTES = 28;
const SESSION_ID_START = 4;
const SESSION_ID_END = 20;
const MIN_CODE = 4000;
const MAX_CODE = 4999;
const MAX_REASON = 200;

/** What the rendezvous said when it refused this browser. */
export interface RendezvousRefusal {
  readonly code: number;
  readonly reason: string;
}

/** The refusal a binary frame carries, or undefined when it is anything else (a `ready`, a session frame, noise). */
export function rendezvousRefusal(bytes: Uint8Array): RendezvousRefusal | undefined {
  if (bytes.length <= HEADER_BYTES) return undefined;
  if (bytes[0] !== FRAME_MAGIC || bytes[1] !== FRAME_VERSION || bytes[2] !== CONTROL_KIND) return undefined;
  for (let at = SESSION_ID_START; at < SESSION_ID_END; at += 1) if (bytes[at] !== 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_BYTES)));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { t, code, reason } = value as Record<string, unknown>;
  if (t !== 'error' || typeof code !== 'number' || !Number.isInteger(code)) return undefined;
  if (code < MIN_CODE || code > MAX_CODE) return undefined;
  if (typeof reason !== 'string' || reason.length > MAX_REASON) return undefined;
  return { code, reason };
}
