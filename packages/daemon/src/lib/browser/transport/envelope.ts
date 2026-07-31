import { BROWSER_MAX_PAGE_ID_LENGTH } from '@ferretry/protocol';

/** ASCII "FYBF" — Ferretry browser frame. */
export const FRAME_ENVELOPE_MAGIC: readonly number[] = [0x46, 0x59, 0x42, 0x46];
export const FRAME_ENVELOPE_VERSION = 1;
export const FRAME_ENVELOPE_HEADER_BYTES = 7;
/** A single JPEG frame larger than this is a bug upstream, never a viewport. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const MAX_PAGE_ID_BYTES = 0xffff;

/**
 * Browser frame envelope v1 — one binary message, so identity and pixels can never be reordered
 * independently:
 *
 *   bytes 0..3   ASCII magic "FYBF"
 *   byte  4      version 1
 *   bytes 5..6   unsigned big-endian UTF-8 page-id byte length
 *   next N bytes UTF-8 opaque page id
 *   remainder    JPEG bytes
 *
 * The message boundary supplies the JPEG length. Both directions of the codec live here so the
 * viewer and the daemon can never drift apart — the kteam original described the layout in a
 * comment and hand-wrote an independent decoder in the web client.
 */
export type FrameEnvelopeResult =
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly ok: false; readonly message: string };

export function encodeFrameEnvelope(pageId: string, jpegBytes: Uint8Array): FrameEnvelopeResult {
  if (pageId.length === 0) return { ok: false, message: 'pageId must not be empty' };
  if (pageId.length > BROWSER_MAX_PAGE_ID_LENGTH) return { ok: false, message: 'pageId is too long' };
  if (jpegBytes.byteLength === 0) return { ok: false, message: 'frame must not be empty' };
  if (jpegBytes.byteLength > MAX_FRAME_BYTES) return { ok: false, message: 'frame exceeds the byte ceiling' };

  const pageIdBytes = new TextEncoder().encode(pageId);
  if (pageIdBytes.byteLength > MAX_PAGE_ID_BYTES) return { ok: false, message: 'pageId is too long' };

  const envelope = new Uint8Array(FRAME_ENVELOPE_HEADER_BYTES + pageIdBytes.byteLength + jpegBytes.byteLength);
  envelope.set(FRAME_ENVELOPE_MAGIC, 0);
  envelope[4] = FRAME_ENVELOPE_VERSION;
  // The view is scoped to this envelope's own bytes: the buffer may be larger than the array when a
  // caller hands us a pooled allocation, and writing at absolute offset 5 would then corrupt it.
  new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength).setUint16(5, pageIdBytes.byteLength, false);
  envelope.set(pageIdBytes, FRAME_ENVELOPE_HEADER_BYTES);
  envelope.set(jpegBytes, FRAME_ENVELOPE_HEADER_BYTES + pageIdBytes.byteLength);
  return { ok: true, value: envelope };
}

export interface DecodedFrameEnvelope {
  readonly pageId: string;
  readonly jpegBytes: Uint8Array;
}

export type DecodedFrameEnvelopeResult =
  | { readonly ok: true; readonly value: DecodedFrameEnvelope }
  | { readonly ok: false; readonly message: string };

export function decodeFrameEnvelope(envelope: Uint8Array): DecodedFrameEnvelopeResult {
  if (envelope.byteLength <= FRAME_ENVELOPE_HEADER_BYTES) return { ok: false, message: 'envelope is truncated' };
  if (FRAME_ENVELOPE_MAGIC.some((byte, index) => envelope[index] !== byte)) {
    return { ok: false, message: 'envelope magic does not match' };
  }
  if (envelope[4] !== FRAME_ENVELOPE_VERSION) return { ok: false, message: 'unsupported envelope version' };

  const header = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const pageIdBytes = header.getUint16(5, false);
  const jpegStart = FRAME_ENVELOPE_HEADER_BYTES + pageIdBytes;
  if (pageIdBytes === 0) return { ok: false, message: 'envelope carries no page id' };
  if (jpegStart >= envelope.byteLength) return { ok: false, message: 'envelope is truncated' };

  const pageId = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let decodedPageId: string;
  try {
    decodedPageId = pageId.decode(envelope.subarray(FRAME_ENVELOPE_HEADER_BYTES, jpegStart));
  } catch {
    return { ok: false, message: 'page id is not valid UTF-8' };
  }
  if (decodedPageId.length > BROWSER_MAX_PAGE_ID_LENGTH) return { ok: false, message: 'pageId is too long' };
  return { ok: true, value: { pageId: decodedPageId, jpegBytes: envelope.subarray(jpegStart) } };
}
