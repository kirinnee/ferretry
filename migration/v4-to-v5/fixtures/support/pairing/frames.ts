/**
 * The one binary framing every carrier uses.
 *
 * There is exactly one wire format whether the socket goes straight to a daemon or through a
 * rendezvous, because the alternative — a relayed conversation that looks different from a direct
 * one — makes the security story depend on the carrier, and nobody can reason about that later.
 *
 * A frame is a fixed 28-byte header and an opaque payload:
 *
 *     0       magic         0xFE
 *     1       version       0x01
 *     2       kind          see FRAME_KINDS
 *     3       reserved      0x00
 *     4..19   session id    16 bytes, all zero for rendezvous-scoped control
 *     20..27  sequence      unsigned 64-bit, big-endian
 *     28..    payload
 *
 * Only two kinds are end-to-end, and a rendezvous is structurally unable to read them: it copies
 * the payload without decoding it. The other two kinds are hop-by-hop and are meant to be read.
 */

import { bytesEqual, concatBytes, fromBase64UrlFixed, readUint64, toBase64Url, writeUint64 } from './binary.ts';
import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_VERSION,
  MAX_FRAME_BYTES,
  MAX_FRAME_SEQUENCE,
  RELAY_CLOSE_CODES,
  type RelayCloseCode,
  SESSION_ID_BYTES,
} from './constants.ts';

export const FRAME_KINDS = {
  /** Hop-by-hop rendezvous control. JSON payload. Absent on a direct carrier. */
  control: 0x01,
  /** End-to-end handshake. JSON payload the carrier must not decode. */
  handshake: 0x02,
  /** End-to-end record. AEAD ciphertext the carrier must not decode. */
  data: 0x03,
  /** Hop-by-hop flow control. Four-byte payload: how many further frames the sender may send. */
  credit: 0x04,
} as const;

export type FrameKind = (typeof FRAME_KINDS)[keyof typeof FRAME_KINDS];

const FRAME_KIND_VALUES: readonly number[] = Object.values(FRAME_KINDS);

/** The two kinds that belong to the end-to-end stream and therefore consume a sequence number. */
export function isEndToEndKind(kind: FrameKind): boolean {
  return kind === FRAME_KINDS.handshake || kind === FRAME_KINDS.data;
}

/** A session identifier as bytes, with its base64url spelling for maps and log lines. */
export interface SessionId {
  readonly bytes: Uint8Array;
  readonly text: string;
}

const ZERO_SESSION_BYTES = new Uint8Array(SESSION_ID_BYTES);

/** The all-zero identifier, which addresses the rendezvous itself rather than any session. */
export const RENDEZVOUS_SESSION_ID: SessionId = {
  bytes: ZERO_SESSION_BYTES,
  text: toBase64Url(ZERO_SESSION_BYTES),
};

export function sessionIdFromBytes(bytes: Uint8Array): SessionId | null {
  if (bytes.length !== SESSION_ID_BYTES) return null;
  const copy = Uint8Array.from(bytes);
  return { bytes: copy, text: toBase64Url(copy) };
}

export function sessionIdFromText(text: string): SessionId | null {
  const bytes = fromBase64UrlFixed(text, SESSION_ID_BYTES);
  return bytes === null ? null : { bytes, text };
}

export function isRendezvousSessionId(sessionId: SessionId): boolean {
  return bytesEqual(sessionId.bytes, ZERO_SESSION_BYTES);
}

export interface RelayFrame {
  readonly kind: FrameKind;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly payload: Uint8Array;
}

export type FrameDecodeResult =
  | { readonly ok: true; readonly frame: RelayFrame }
  | { readonly ok: false; readonly code: RelayCloseCode; readonly reason: string };

/** Build the 28-byte header on its own, because it is also the AEAD associated data. */
export function encodeFrameHeader(kind: FrameKind, sessionId: SessionId, sequence: number): Uint8Array {
  const header = new Uint8Array(FRAME_HEADER_BYTES);
  header[0] = FRAME_MAGIC;
  header[1] = FRAME_VERSION;
  header[2] = kind;
  header[3] = 0;
  header.set(sessionId.bytes, 4);
  writeUint64(header, 20, sequence);
  return header;
}

export function encodeFrame(frame: RelayFrame): Uint8Array {
  return concatBytes([encodeFrameHeader(frame.kind, frame.sessionId, frame.sequence), frame.payload]);
}

/**
 * Decode a frame, refusing everything that is not exactly one.
 *
 * Every refusal names a close code, because a carrier that cannot parse a frame has no honest
 * option but to end the connection: it cannot know what it just failed to understand.
 */
export function decodeFrame(bytes: Uint8Array): FrameDecodeResult {
  if (bytes.length < FRAME_HEADER_BYTES) {
    return { ok: false, code: RELAY_CLOSE_CODES.protocolError, reason: 'frame is shorter than its header' };
  }
  if (bytes.length > MAX_FRAME_BYTES) {
    return { ok: false, code: RELAY_CLOSE_CODES.frameTooLarge, reason: 'frame exceeds the maximum frame size' };
  }
  if (bytes[0] !== FRAME_MAGIC) {
    return { ok: false, code: RELAY_CLOSE_CODES.protocolError, reason: 'frame does not start with the frame magic' };
  }
  if (bytes[1] !== FRAME_VERSION) {
    return { ok: false, code: RELAY_CLOSE_CODES.versionUnsupported, reason: 'unsupported frame version' };
  }
  const kind = bytes[2] ?? 0;
  if (!FRAME_KIND_VALUES.includes(kind)) {
    return { ok: false, code: RELAY_CLOSE_CODES.protocolError, reason: 'unknown frame kind' };
  }
  if (bytes[3] !== 0) {
    return { ok: false, code: RELAY_CLOSE_CODES.protocolError, reason: 'reserved frame byte is not zero' };
  }
  // The header length was already proved, so this slice is exactly the identifier width. Routing
  // it through the nullable constructor would add a branch no input can reach.
  const sessionBytes = bytes.slice(4, 4 + SESSION_ID_BYTES);
  const sessionId: SessionId = { bytes: sessionBytes, text: toBase64Url(sessionBytes) };
  const sequence = readUint64(bytes, 20);
  if (sequence === null || sequence > MAX_FRAME_SEQUENCE) {
    return { ok: false, code: RELAY_CLOSE_CODES.sequenceBroken, reason: 'sequence number is out of range' };
  }
  return {
    ok: true,
    frame: {
      kind: kind as FrameKind,
      sessionId,
      sequence,
      payload: bytes.subarray(FRAME_HEADER_BYTES),
    },
  };
}

/** Encode a credit grant: how many further frames the peer this is sent to may send. */
export function encodeCreditPayload(frames: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, frames, false);
  return payload;
}

export function decodeCreditPayload(payload: Uint8Array): number | null {
  if (payload.length !== 4) return null;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
}
