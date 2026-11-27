/**
 * WHICH FONT FILES EACH STYLE DRAWS WITH, now that a font is a pack (`theme/packs/font/<id>/font.ts` + its woff2 files + its
 * licence text). The faces are generated from the packs (`generated/theme-packs.css`), `theme/fonts.ts` names font ids per
 * style and resolves them to files, and `styles/style/<id>.css` holds the stacks that name them. Type is a style decision,
 * so the table is keyed by style; this suite fails when those stop agreeing, and pins what each style fetched before the move.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FONT_PACKS } from '../../src/generated/theme-packs.ts';
import { STYLE_IDS } from '../../src/theme/catalog.ts';
import { preloadThemeFonts, STYLE_FONT_FILES, type PreloadHost } from '../../src/theme/fonts.ts';
import { readStyleFile } from '../../src/testing/theme-css.ts';

const srcDir = join(import.meta.dir, '../../src');
const fontsDir = join(srcDir, 'theme/packs/font');
const generatedCss = readFileSync(join(srcDir, 'generated/theme-packs.css'), 'utf8');

const sizeOf = (file: string): number => {
  for (const folder of readdirSync(fontsDir)) {
    const path = join(fontsDir, folder, file);
    if (existsSync(path)) return statSync(path).size;
  }
  throw new Error(`${file} is in no font pack`);
};
const file = (short: string): string => `${short.replace('|', '-latin-')}.woff2`;

/**
 * What each style preloaded (`text`) and lazy-loaded (`code`) before fonts became packs, and the bytes that cost. A style that
 * starts fetching a different or heavier set must change this on purpose. Styles with no row (Contrast) draw with the device.
 */
const EXPECTED = {
  studio: {
    text: ['inter|wght-normal'],
    code: ['jetbrains-mono|400-normal', 'jetbrains-mono|700-normal'],
    textBytes: 48256,
    codeBytes: 43076,
  },
  mission: { text: ['public-sans|wght-normal', 'cascadia-mono|wght-normal'], code: [], textBytes: 55644, codeBytes: 0 },
  neo: {
    text: ['archivo-black|400-normal'],
    code: ['ibm-plex-mono|400-normal', 'ibm-plex-mono|700-normal'],
    textBytes: 18604,
    codeBytes: 29616,
  },
  geist: { text: ['geist|wght-normal'], code: ['geist-mono|wght-normal'], textBytes: 29400, codeBytes: 23128 },
  glass: {
    text: ['inter|wght-normal'],
    code: ['jetbrains-mono|400-normal', 'jetbrains-mono|700-normal'],
    textBytes: 48256,
    codeBytes: 43076,
  },
  neumorphism: {
    text: ['nunito|wght-normal'],
    code: ['jetbrains-mono|400-normal', 'jetbrains-mono|700-normal'],
    textBytes: 39128,
    codeBytes: 43076,
  },
  retro: {
    text: ['public-sans|wght-normal'],
    code: ['jetbrains-mono|400-normal', 'jetbrains-mono|700-normal'],
    textBytes: 26832,
    codeBytes: 43076,
  },
  hud: {
    text: ['orbitron|wght-normal', 'public-sans|wght-normal'],
    code: ['cascadia-mono|wght-normal'],
    textBytes: 38632,
    codeBytes: 28812,
  },
  swiss: {
    text: ['hanken-grotesk|wght-normal'],
    code: ['jetbrains-mono|400-normal', 'jetbrains-mono|700-normal'],
    textBytes: 34704,
    codeBytes: 43076,
  },
  pixel: {
    text: ['inter|wght-normal', 'pixelify-sans|700-normal', 'press-start-2p|400-normal'],
    code: ['jetbrains-mono|400-normal', 'jetbrains-mono|700-normal'],
    textBytes: 68672,
    codeBytes: 43076,
  },
  briefing: {
    text: ['poppins|400-normal', 'poppins|500-normal', 'poppins|600-normal'],
    code: ['ibm-plex-mono|400-normal', 'ibm-plex-mono|700-normal'],
    textBytes: 23632,
    codeBytes: 29616,
  },
  genz: {
    text: ['bagel-fat-one|400-normal', 'bricolage-grotesque|wght-normal'],
    code: ['jetbrains-mono|400-normal', 'jetbrains-mono|700-normal'],
    textBytes: 65720,
    codeBytes: 43076,
  },
  exaggerated: {
    text: ['inter|wght-normal'],
    code: ['jetbrains-mono|400-normal', 'jetbrains-mono|700-normal'],
    textBytes: 48256,
    codeBytes: 43076,
  },
} as const;

describe('the font packs', () => {
  it('are one folder per family, with the licence text and every face file beside the pack', () => {
    expect(FONT_PACKS.length).toBe(18);
    for (const pack of FONT_PACKS) {
      expect(existsSync(join(fontsDir, pack.id, 'LICENSE.txt'))).toBe(true);
      expect(pack.licence).toBe('OFL-1.1');
      for (const face of pack.faces) expect(existsSync(join(fontsDir, pack.id, face.file))).toBe(true);
    }
  });

  it('declare every face in the generated stylesheet, and nothing is hand-declared beside it', () => {
    for (const pack of FONT_PACKS)
      for (const face of pack.faces) {
        expect(generatedCss).toContain(`font-family: '${pack.family}';`);
        expect(generatedCss).toContain(`/theme/packs/font/${pack.id}/${face.file.slice(2)}')`);
      }
    expect(existsSync(join(srcDir, 'styles/theme-fonts.css'))).toBe(false);
    expect(existsSync(join(srcDir, 'assets/fonts'))).toBe(false);
  });

  it('keep Nunito’s variable weight range as before the move (200 to 1000)', () => {
    const nunito = FONT_PACKS.find(pack => pack.id === 'nunito');
    expect(nunito?.faces.map(face => face.weight)).toEqual(['200 1000']);
    expect(generatedCss).toContain('font-weight: 200 1000;');
  });

  it('keep the built asset names: the same files, so the content-hashed URLs and the service worker cache do not change', () => {
    const names = FONT_PACKS.flatMap(pack => pack.faces.map(face => face.file.slice(2))).sort();
    const before = [
      'archivo-black|400-normal',
      'bagel-fat-one|400-normal',
      'barlow-condensed|400-normal',
      'barlow-condensed|600-normal',
      'bricolage-grotesque|wght-normal',
      'cascadia-mono|wght-normal',
      'geist|wght-normal',
      'geist-mono|wght-normal',
      'gelasio|wght-normal',
      'hanken-grotesk|wght-normal',
      'ibm-plex-mono|400-normal',
      'ibm-plex-mono|700-normal',
      'inter|wght-normal',
      'jetbrains-mono|400-normal',
      'jetbrains-mono|700-normal',
      'nunito|wght-normal',
      'orbitron|wght-normal',
      'pixelify-sans|700-normal',
      'poppins|400-normal',
      'poppins|500-normal',
      'poppins|600-normal',
      'press-start-2p|400-normal',
      'public-sans|wght-normal',
    ].map(file);
    expect(names).toEqual(before.sort());
  });
});

describe('the preload table', () => {
  it('only names styles the catalogue knows', () => {
    for (const style of Object.keys(STYLE_FONT_FILES)) expect(STYLE_IDS as readonly string[]).toContain(style);
  });

  it('gives each style the same files, in the same order, at the same byte cost as before the move', () => {
    expect(Object.keys(STYLE_FONT_FILES).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [style, expected] of Object.entries(EXPECTED)) {
      const row = STYLE_FONT_FILES[style as keyof typeof STYLE_FONT_FILES];
      const names = (urls: readonly string[] | undefined): string[] => (urls ?? []).map(url => basename(url));
      expect(names(row?.text)).toEqual(expected.text.map(file));
      expect(names(row?.code)).toEqual(expected.code.map(file));
      expect(names(row?.text).reduce((sum, name) => sum + sizeOf(name), 0)).toBe(expected.textBytes);
      expect(names(row?.code).reduce((sum, name) => sum + sizeOf(name), 0)).toBe(expected.codeBytes);
    }
  });

  it('a style whose stack leads with a bundled family has that family in its row (later names are fallbacks)', () => {
    for (const style of STYLE_IDS) {
      const row = STYLE_FONT_FILES[style];
      if (row === undefined) continue; // Contrast and Lucid draw with the device (a bundled name late in a stack is only a fallback)
      const files = [...row.text, ...row.code].map(url => basename(url));
      const stacks = [
        ...readStyleFile(`style/${style}.css`).matchAll(/--font-(?:body|display|ui|mono|code):\s*([^;]+);/gu),
      ];
      for (const [, stack] of stacks) {
        const named = [...(stack as string).matchAll(/['"]([^'"]+)['"]/gu)].map(match => match[1]);
        const lead = FONT_PACKS.find(
          pack => pack.family === named.find(name => FONT_PACKS.some(p => p.family === name)),
        );
        if (lead === undefined) continue;
        expect(lead.faces.every(face => files.includes(face.file.slice(2)))).toBe(true);
      }
    }
  });
});

describe('preloadThemeFonts', () => {
  const host = (): { readonly host: PreloadHost; readonly added: HTMLLinkElement[] } => {
    const added: HTMLLinkElement[] = [];
    return {
      added,
      host: {
        head: { append: (...nodes: (Node | string)[]) => void added.push(...(nodes as HTMLLinkElement[])) },
        createElement: () => ({}) as HTMLLinkElement,
      },
    };
  };

  it('hints a style’s text faces once, and nothing for an unknown or font-less style', () => {
    const page = host();
    preloadThemeFonts('geist', page.host);
    const first = page.added.length;
    expect(first).toBe(STYLE_FONT_FILES.geist?.text.length ?? -1);
    preloadThemeFonts('geist', page.host);
    expect(page.added.length).toBe(first);
    preloadThemeFonts('contrast', page.host);
    preloadThemeFonts('nope', page.host);
    preloadThemeFonts(undefined, page.host);
    expect(page.added.length).toBe(first);
    for (const link of page.added) expect(link).toMatchObject({ rel: 'preload', as: 'font', crossOrigin: 'anonymous' });
  });
});

describe('the Look picker preview stays cheap', () => {
  it('a Gen Z swatch draws its body in the device face, so Bricolage loads only when Gen Z is the active style', () => {
    const css = readStyleFile('style/genz.css');
    const rule = css.match(/\[data-swatch\]\[data-style='genz'\]:not\(:root\)\s*\{([^}]*)\}/u)?.[1] ?? '';
    expect(rule).toContain('--font-body: system-ui');
    expect(rule).not.toContain('Bricolage');
  });
});
