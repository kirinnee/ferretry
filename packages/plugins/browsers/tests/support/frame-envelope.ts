import { BROWSER_MAX_PAGE_ID_LENGTH } from '../../contract/index.ts';
import {
  FRAME_ENVELOPE_HEADER_BYTES,
  FRAME_ENVELOPE_MAGIC,
  FRAME_ENVELOPE_VERSION,
} from '../../daemon/stream/envelope.ts';

interface DecodedFrameEnvelope {
  readonly pageId: string;
  readonly jpegBytes: Uint8Array;
}

export type DecodedFrameEnvelopeResult =
  | { readonly ok: true; readonly value: DecodedFrameEnvelope }
  | { readonly ok: false; readonly message: string };

/** Reads a browser frame envelope back, so a test can prove what the encoder wrote. */
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
