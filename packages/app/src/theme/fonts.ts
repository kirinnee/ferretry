/// <reference path="./woff2.d.ts" />
/**
 * WHICH FONT FILES EACH STYLE DRAWS WITH — and the hint that fetches the first-paint ones early.
 *
 * A font is a PACK (`theme/packs/font/<id>/`: `font.ts`, its woff2 files and its licence text), and the registry generator
 * writes every face's `@font-face` into `generated/theme-packs.css` and the built URL of every file into `FONT_FILE_URLS`.
 * Type is a STYLE decision (a palette is colour only), so this table names, per style, which font ids draw its text and its
 * code; it is kept for two things the stylesheet cannot do: telling the browser, before it has laid anything out, which files
 * the ACTIVE style is about to need, and giving the byte budget something to count. (The table moves into each style pack's
 * `fonts` once styles are packs.) `tests/unit/theme-fonts.test.ts` fails when it and the style stacks disagree.
 *
 * `text` faces draw body, chrome and headings, so they are preloaded. `code` faces draw `pre` and
 * `.mono` only; they load when a code block first appears, which is soon enough, and keeping them out
 * of the preload keeps a sans style's first paint from competing with the JavaScript for bandwidth.
 *
 * A style absent from the table (Contrast) draws with the device's own faces by design.
 *
 * Every bundled font is under the SIL Open Font License 1.1 (OFL), the latin-subset woff2 cut Fontsource publishes from each
 * font's upstream release; its licence text is `LICENSE.txt` in its pack. Deliberately NOT bundled (platform or non-free faces
 * named first in a stack so an installed copy wins, with an open look-alike answering everywhere else): Tahoma, Trebuchet MS,
 * Verdana, Lucida Console, Aptos (Public Sans answers), DIN Condensed (Barlow Condensed), Georgia (Gelasio), Arial Black
 * (Archivo Black), Helvetica Neue. Contrast draws with the device's own faces on purpose.
 */

import { FONT_FILE_URLS, FONT_PACKS } from '../generated/theme-packs.ts';
import type { StyleId } from './catalog.ts';

export interface ThemeFontFiles {
  /** Drawn on first paint: preloaded. */
  readonly text: readonly string[];
  /** Drawn only inside code: fetched on first use. */
  readonly code: readonly string[];
}

type FontId = (typeof FONT_PACKS)[number]['id'];

/** The built URLs of a font pack's files, in the order the pack lists its faces. */
const urlsOf = (id: FontId): readonly string[] => {
  const pack = FONT_PACKS.find(candidate => candidate.id === id);
  if (pack === undefined) throw new Error(`font pack "${id}" does not exist`);
  return pack.faces.map(face => FONT_FILE_URLS[`${id}/${face.file.slice(2)}`] as string);
};

/**
 * The built URLs of the code face's regular and bold files, for a plugin half that draws code on a canvas the stylesheet
 * cannot reach (the terminal emulator measures its cells from a face it loads itself). The files are the shell's.
 */
const [jetBrainsRegular, jetBrainsBold] = urlsOf('jetbrains-mono') as [string, string];
export const CODE_FACE_URLS = { regular: jetBrainsRegular, bold: jetBrainsBold } as const;

const STYLE_FONT_IDS: Readonly<
  Partial<Record<StyleId, { readonly text: readonly FontId[]; readonly code: readonly FontId[] }>>
> = {
  studio: { text: ['inter'], code: ['jetbrains-mono'] },
  mission: { text: ['public-sans', 'cascadia-mono'], code: [] },
  neo: { text: ['archivo-black'], code: ['ibm-plex-mono'] },
  geist: { text: ['geist'], code: ['geist-mono'] },
  glass: { text: ['inter'], code: ['jetbrains-mono'] },
  neumorphism: { text: ['nunito'], code: ['jetbrains-mono'] },
  retro: { text: ['public-sans'], code: ['jetbrains-mono'] },
  hud: { text: ['orbitron', 'public-sans'], code: ['cascadia-mono'] },
  swiss: { text: ['hanken-grotesk'], code: ['jetbrains-mono'] },
  pixel: { text: ['inter', 'pixelify-sans', 'press-start-2p'], code: ['jetbrains-mono'] },
  briefing: { text: ['poppins'], code: ['ibm-plex-mono'] },
  genz: { text: ['bagel-fat-one', 'bricolage-grotesque'], code: ['jetbrains-mono'] },
  exaggerated: { text: ['inter'], code: ['jetbrains-mono'] },
};

export const STYLE_FONT_FILES: Readonly<Partial<Record<StyleId, ThemeFontFiles>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(STYLE_FONT_IDS).map(([style, ids]) => [
      style,
      { text: ids.text.flatMap(urlsOf), code: ids.code.flatMap(urlsOf) },
    ]),
  ),
);

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
