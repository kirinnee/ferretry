/**
 * Registers and loads the bundled terminal face BEFORE an emulator measures its cells.
 *
 * ORDER IS THE WHOLE POINT. xterm measures a cell once, when it opens, and again only when its font
 * options change. A face that finishes loading after that measurement is drawn into cells sized for
 * the fallback — the same spaced-out text as no face at all — so the deck awaits this before it
 * constructs the emulator rather than adding the face and hoping.
 *
 * Loading never fails the terminal: a face that cannot be fetched leaves the theme's own stack, which
 * is what every terminal had before this existed.
 */

import { TERMINAL_FONT_FACE } from '../lib/terminal-font.ts';
import regularFace from '../assets/fonts/jetbrains-mono-latin-400-normal.woff2';
import boldFace from '../assets/fonts/jetbrains-mono-latin-700-normal.woff2';

/** The two browser facilities this needs, injected so a test can stand in for both. */
export interface TerminalFontEnvironment {
  readonly fonts: Pick<FontFaceSet, 'add'> | undefined;
  readonly createFace: ((family: string, source: string, weight: string) => Pick<FontFace, 'load'>) | undefined;
}

const browserEnvironment = (): TerminalFontEnvironment => ({
  fonts: typeof document === 'undefined' ? undefined : document.fonts,
  createFace:
    typeof FontFace === 'undefined'
      ? undefined
      : (family, source, weight) => new FontFace(family, `url("${source}")`, { weight, style: 'normal' }),
});

/** One load per page, however many terminals open: the faces are added to the document once. */
export function terminalFontLoader(environment: () => TerminalFontEnvironment): () => Promise<void> {
  let loading: Promise<void> | undefined;
  return () => {
    loading ??= (async () => {
      const { fonts, createFace } = environment();
      if (fonts === undefined || createFace === undefined) return;
      const faces = [
        createFace(TERMINAL_FONT_FACE, regularFace, '400'),
        createFace(TERMINAL_FONT_FACE, boldFace, '700'),
      ];
      await Promise.all(
        faces.map(async face => {
          const loaded = await face.load();
          fonts.add(loaded);
        }),
      ).catch(() => undefined);
    })();
    return loading;
  };
}

export const loadTerminalFont = terminalFontLoader(browserEnvironment);
