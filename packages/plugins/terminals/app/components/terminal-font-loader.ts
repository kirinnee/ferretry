/**
 * Waits for the bundled terminal face BEFORE an emulator measures its cells.
 *
 * ORDER IS THE WHOLE POINT. xterm measures a cell once, when it opens, and again only when its font
 * options change. A face that finishes loading after that measurement is drawn into cells sized for
 * the fallback — the same spaced-out text as no face at all — so the deck awaits this before it
 * constructs the emulator rather than hoping.
 *
 * The face is the shell's own: `styles/theme-fonts.css` declares the JetBrains Mono files once for the whole
 * page (the same two woff2 files this loader used to register under its own name), so a plugin neither imports
 * the shell's assets nor ships a copy. Asking the document to load it is what is left to do here.
 *
 * Loading never fails the terminal: a face that cannot be fetched leaves the theme's own stack, which
 * is what every terminal had before this existed.
 */

import { TERMINAL_FONT_FACE } from '../lib/terminal-font.ts';

/** The one browser facility this needs, injected so a test can stand in for it. */
export interface TerminalFontEnvironment {
  readonly fonts: Pick<FontFaceSet, 'load'> | undefined;
}

const browserEnvironment = (): TerminalFontEnvironment => ({
  fonts: typeof document === 'undefined' ? undefined : document.fonts,
});

/** The two weights the emulator draws (regular and bold), at the size it opens with. */
const FACES = [`400 12.5px "${TERMINAL_FONT_FACE}"`, `700 12.5px "${TERMINAL_FONT_FACE}"`] as const;

/** One load per page, however many terminals open. */
export function terminalFontLoader(environment: () => TerminalFontEnvironment): () => Promise<void> {
  let loading: Promise<void> | undefined;
  return () => {
    loading ??= (async () => {
      const { fonts } = environment();
      if (fonts === undefined) return;
      await Promise.all(FACES.map(async face => await fonts.load(face))).catch(() => undefined);
    })();
    return loading;
  };
}

export const loadTerminalFont = terminalFontLoader(browserEnvironment);
