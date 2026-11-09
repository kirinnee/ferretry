/**
 * The hand-off link as a QR grid. Kept apart from `setup-handoff.ts` so the link grammar needs no encoder: this file
 * is the only one that does, and the encoder is the shell's one local copy (`localQr`, S14).
 */

import { localQr, QrEncodeError } from '@ferretry/app';

/**
 * The QR, as a grid of dark/light modules.
 *
 * Returned as data rather than as markup so the component owns every pixel: the library's own `createSvgTag`
 * hardcodes black on white, which is a hole punched through the dark theme, and an `<img>` of a data URL cannot
 * inherit a token. Error correction is `M` — the QR is read off a lit screen at arm's length — and the smallest
 * version the text fits in is used, so a short link stays a coarse, easily-read QR. The link is built here, in this
 * tab, and no image service ever sees it.
 */
export const qrModules = (text: string): readonly (readonly boolean[])[] => localQr(text).modules;

/**
 * {@link qrModules}, or `undefined` when the link cannot be drawn as a code a phone reads (empty, or longer than the
 * encoder's cap: a first-run page opened with a long query string builds such a link). Any other failure is a bug and
 * still throws.
 */
export const tryQrModules = (text: string): readonly (readonly boolean[])[] | undefined => {
  try {
    return qrModules(text);
  } catch (error: unknown) {
    if (error instanceof QrEncodeError) return undefined;
    throw error;
  }
};
