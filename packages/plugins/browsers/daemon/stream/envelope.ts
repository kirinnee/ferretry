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
 * The message boundary supplies the JPEG length.
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
