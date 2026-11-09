/**
 * The hand-off link as a QR grid. Kept apart from `setup-handoff.ts` so the link grammar needs no encoder: this file
 * is the only one that does, and the encoder is the shell's one local copy (`localQr`, S14).
 */

import { localQr } from '@ferretry/app';

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
