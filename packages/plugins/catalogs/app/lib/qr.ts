/**
 * A QR symbol for a share link, computed in this tab. The link holds a live code, so no image service ever sees it:
 * the modules come from the shell's one local encoder (`localQr`, S14) and are drawn as SVG by `QrSymbol`.
 */
import { localQr, MAX_QR_VERSION, type QrMatrix, QrEncodeError } from '@ferretry/app';

export { MAX_QR_VERSION, QrEncodeError, type QrMatrix };

/** Throws `QrEncodeError` for a value too long to encode, rather than encoding a truncated credential. */
export const encodeQr = localQr;
