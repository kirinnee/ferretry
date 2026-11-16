/**
 * A QR SYMBOL COMPUTED IN THIS TAB (S14, m6): the ONE `qrcode-generator` copy in the workspace, for every plugin that
 * draws a code (Onboarding's hand-off link, Catalogs' share link). The text can be a live credential (a share link
 * holds a code), so no image service ever sees it: the modules are computed here, in byte mode at error level M (the
 * level printed codes use), and drawn by the caller as SVG so a theme can colour them.
 *
 * It refuses rather than truncates: a value too long for a symbol a phone camera reads reliably throws
 * {@link QrEncodeError}, and an empty value too.
 */
import qrcode from 'qrcode-generator';

/** One encoded symbol: a square of modules, dark where `true`. */
export interface QrMatrix {
  readonly size: number;
  readonly version: number;
  /** Row-major, `size` rows of `size` modules. Dark is `true`. */
  readonly modules: readonly (readonly boolean[])[];
}

/** The largest symbol a phone camera reads reliably. */
export const MAX_QR_VERSION = 20;

export class QrEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrEncodeError';
  }
}

/** Throws {@link QrEncodeError} for a value too long to encode, rather than encoding a truncated credential. */
export function localQr(text: string): QrMatrix {
  if (text === '') throw new QrEncodeError('a QR symbol needs something to encode');
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
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
