/**
 * The hand-off link as a QR grid. Kept apart from `setup-handoff.ts` so the link grammar needs no library: this file
 * is the only one that does.
 *
 * NEEDS-APP-SHELL: `qrcode-generator` is not a dependency of this package yet (see app/NEEDS-APP-SHELL.txt).
 */

import qrcode from 'qrcode-generator';

/**
 * The QR, as a grid of dark/light modules.
 *
 * Returned as data rather than as markup so the component owns every pixel: the
 * library's own `createSvgTag` hardcodes black on white, which is a hole punched
 * through the dark theme, and an `<img>` of a data URL cannot inherit a token.
 * Error correction is `M` — the QR is read off a lit screen at arm's length, not
 * off a printed label under a forklift, and every level above `M` costs modules
 * that make the picture denser and therefore harder for a cheap camera.
 *
 * Type number 0 lets the library pick the smallest version the text fits in, so a
 * short link stays a coarse, easily-read QR instead of being padded into a fine one.
 */
export const qrModules = (text: string): readonly (readonly boolean[])[] => {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_row, row) =>
    Array.from({ length: size }, (_column, column) => code.isDark(row, column)),
  );
};
