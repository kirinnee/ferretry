/**
 * A QR SYMBOL COMPUTED ON THIS MACHINE (S14, m6): the ONE QR encoder in the workspace and the ONE `qrcode-generator`
 * dependency, for every half that draws a code: the app (Onboarding's hand-off link, Access's pairing URL, Catalogs'
 * share link, through `@ferretry/app`'s `localQr`) and the Catalogs CLI's terminal block drawing. It lives in the shared
 * package because a CLI half may not import the app shell. The text can be a live credential (a pairing URL or share
 * link holds a code), so no image service ever sees it: the modules are computed here, in byte mode at error level M
 * (the level printed codes use), and drawn by the caller (as SVG so a theme can colour them, or as terminal blocks).
 *
 * THE CODE IS NEVER RETAINED: no cache keyed by input and no last-result memo, so a live credential cannot outlive the
 * screen that showed it in module scope.
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

/**
 * The text as UTF-8, one character per byte. `qrcode-generator` keeps only the low eight bits of each character, so
 * text beyond Latin-1 (a name with an emoji or Japanese in it) would be silently corrupted; handing it bytes it maps
 * one to one makes the symbol carry exactly what a scanner decodes as UTF-8.
 */
const utf8Bytes = (text: string): string =>
  Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join('');

/** Throws {@link QrEncodeError} for a value too long to encode, rather than encoding a truncated credential. */
export function localQr(text: string): QrMatrix {
  // A TypeError, not a QrEncodeError: a caller that handed over a non-string has a bug to fix, not a value to
  // degrade, so `tryQrModules` rethrows it. `utf8Bytes` would otherwise encode `undefined` as zero bytes.
  if (typeof text !== 'string') throw new TypeError('a QR symbol encodes text');
  if (text === '') throw new QrEncodeError('a QR symbol needs something to encode');
  const code = qrcode(0, 'M');
  code.addData(utf8Bytes(text), 'Byte');
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
