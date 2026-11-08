/**
 * A QR symbol for a share link, computed in this tab. The link holds a live code, so no image service ever sees it:
 * the modules come from `qrcode-generator` (local, byte mode, error level M, the level printed codes use — today's
 * choice) and are drawn as SVG by `QrSymbol`.
 */
import qrcode from 'qrcode-generator';

/** One encoded symbol: a square of modules, dark where `true`. */
export interface QrMatrix {
  readonly size: number;
  readonly version: number;
  /** Row-major, `size` rows of `size` modules. Dark is `true`. */
  readonly modules: readonly (readonly boolean[])[];
}

/** The largest symbol a phone camera reads reliably (today's encoder was capped here too). */
export const MAX_QR_VERSION = 20;

export class QrEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrEncodeError';
  }
}

/** Throws `QrEncodeError` for a value too long to encode, rather than encoding a truncated credential. */
export function encodeQr(value: string): QrMatrix {
  if (value === '') throw new QrEncodeError('a QR symbol needs something to encode');
  const code = qrcode(0, 'M');
  code.addData(value, 'Byte');
  try {
    code.make();
  } catch {
    throw new QrEncodeError('this value is too long for a QR symbol; refusing rather than truncating it');
  }
  const size = code.getModuleCount();
  if ((size - 17) / 4 > MAX_QR_VERSION)
    throw new QrEncodeError('this value is too long for a QR symbol a phone can scan; refusing rather than drawing it');
  const modules = Array.from({ length: size }, (_row, y) =>
    Array.from({ length: size }, (_cell, x) => code.isDark(y, x)),
  );
  return { size, version: (size - 17) / 4, modules };
}
