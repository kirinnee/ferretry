/// <reference path="./woff2.d.ts" />
/**
 * WHICH FONT FILES EACH STYLE DRAWS WITH — and the hint that fetches the first-paint ones early.
 *
 * Type is a STYLE decision (a palette is colour only), so this table is keyed by style. `styles/theme-fonts.css` declares
 * the faces and `styles/style/<id>.css` names them; this file is the third view of the same fact, kept for two things the
 * stylesheet cannot do: telling the browser, before it has laid anything out, which files the ACTIVE style is about to
 * need, and giving the byte budget something to count. `tests/unit/theme-fonts.test.ts` reads all three and fails when
 * they disagree.
 *
 * `text` faces draw body, chrome and headings, so they are preloaded. `code` faces draw `pre` and
 * `.mono` only; they load when a code block first appears, which is soon enough, and keeping them out
 * of the preload keeps a sans style's first paint from competing with the JavaScript for bandwidth.
 *
 * A style absent from the table (Contrast) draws with the device's own faces by design.
 */

import archivoBlack from '../assets/fonts/archivo-black-latin-400-normal.woff2';
import cascadiaMono from '../assets/fonts/cascadia-mono-latin-wght-normal.woff2';
import geist from '../assets/fonts/geist-latin-wght-normal.woff2';
import geistMono from '../assets/fonts/geist-mono-latin-wght-normal.woff2';
import ibmPlexMono400 from '../assets/fonts/ibm-plex-mono-latin-400-normal.woff2';
import ibmPlexMono700 from '../assets/fonts/ibm-plex-mono-latin-700-normal.woff2';
import inter from '../assets/fonts/inter-latin-wght-normal.woff2';
import jetBrainsMono400 from '../assets/fonts/jetbrains-mono-latin-400-normal.woff2';
import jetBrainsMono700 from '../assets/fonts/jetbrains-mono-latin-700-normal.woff2';
import publicSans from '../assets/fonts/public-sans-latin-wght-normal.woff2';
import type { StyleId } from './catalog.ts';

export interface ThemeFontFiles {
  /** Drawn on first paint: preloaded. */
  readonly text: readonly string[];
  /** Drawn only inside code: fetched on first use. */
  readonly code: readonly string[];
}

const jetBrainsMono = [jetBrainsMono400, jetBrainsMono700] as const;

/**
 * The built URLs of the code face's regular and bold files, for a plugin half that draws code on a canvas the stylesheet
 * cannot reach (the terminal emulator measures its cells from a face it loads itself). The files are the shell's.
 */
export const CODE_FACE_URLS = { regular: jetBrainsMono400, bold: jetBrainsMono700 } as const;
const ibmPlexMono = [ibmPlexMono400, ibmPlexMono700] as const;

export const STYLE_FONT_FILES: Readonly<Partial<Record<StyleId, ThemeFontFiles>>> = Object.freeze({
  studio: { text: [inter], code: jetBrainsMono },
  mission: { text: [publicSans, cascadiaMono], code: [] },
  neo: { text: [archivoBlack], code: ibmPlexMono },
  geist: { text: [geist], code: [geistMono] },
});

/** The scope of the document a preload is added to — injected so a test can stand in for the page. */
export interface PreloadHost {
  readonly head: Pick<HTMLHeadElement, 'append'>;
  readonly createElement: (tag: 'link') => HTMLLinkElement;
}

const preloaded = new WeakMap<object, Set<string>>();

/**
 * Hints the browser to fetch the active style's text faces now. Safe to call as often as the theme
 * changes: each file is hinted once per document, and an unknown or font-less style hints nothing.
 */
export function preloadThemeFonts(style: string | undefined, host: PreloadHost = document): void {
  const files = STYLE_FONT_FILES[style as StyleId];
  if (files === undefined) return;
  const seen = preloaded.get(host) ?? new Set<string>();
  preloaded.set(host, seen);
  for (const href of files.text) {
    if (seen.has(href)) continue;
    seen.add(href);
    const link = host.createElement('link');
    link.rel = 'preload';
    link.as = 'font';
    link.type = 'font/woff2';
    // A font fetch is always CORS-mode, so a preload without this is fetched twice.
    link.crossOrigin = 'anonymous';
    link.href = href;
    host.head.append(link);
  }
}
