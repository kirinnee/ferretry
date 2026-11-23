/**
 * DURIAN'S TEXT-WIDTH ESTIMATE, WITHOUT THE SCENE COMPILER (r12 H13, Durian 0.6.2).
 *
 * Since 0.6.0 the alignment grid sets its chips with `chipW` (`core/chipw.ts`), which falls back to the scene compiler's `textW` for
 * a character outside printable ASCII. That one import made the alignment part, which the chat draws from its first load, pull the
 * whole 2D scene compiler (scene, story, camera, route, depth, data: +81 KB gzip measured) into every page. `vite-durian.ts`
 * resolves that import, and only that one, to this module: the estimate is ONE LINE of Durian's (`chW` in `core/scene.ts`), and
 * `tests/unit/app/hypermedia/durian-text-width.test.ts` holds it equal to the installed one on every character class, so a release
 * that changes it fails there. The compiler itself still lives in the animation's own chunk and counts its layout work as before
 * (this estimate is only reached for a character outside printable ASCII, which `chipW` rarely asks of it).
 */

/** Width of one character at 13 px: CJK 13, Indic scripts 8.6, capitals and a few wide marks 8.6, narrow marks 3.8, the rest 7.1. */
const characterWidth = (ch: string): number => {
  const code = ch.codePointAt(0) as number;
  if (code >= 0x2e80) return 13;
  if (code >= 0x0900 && code <= 0x0dff) return 8.6;
  if (/[A-Z@#%&mwMW]/u.test(ch)) return 8.6;
  return /[ilj.,:;'|!]/u.test(ch) ? 3.8 : 7.1;
};

/** The estimated width of `text` at `size` px. */
export function textW(text: string, size = 13): number {
  let width = 0;
  for (const ch of text) width += characterWidth(ch);
  return (width * size) / 13;
}
