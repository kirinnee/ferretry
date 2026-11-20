/**
 * WHICH FONT FILES EACH STYLE DRAWS WITH, in its three places: `theme/fonts.ts` (the preload table), `styles/theme-fonts.css`
 * (the faces) and `styles/style/<id>.css` (the stacks that name them). Type is a style decision, so the table is keyed by
 * style; this suite fails when the three stop agreeing.
 */
import { describe, expect, it } from 'bun:test';
import { basename } from 'node:path';
import { STYLE_IDS } from '../../src/theme/catalog.ts';
import { preloadThemeFonts, STYLE_FONT_FILES, type PreloadHost } from '../../src/theme/fonts.ts';
import { readStyleFile } from '../../src/testing/theme-css.ts';

const faces = readStyleFile('theme-fonts.css');
const declaredFiles = new Set(
  [...faces.matchAll(/url\(['"]?([^'")]+\.woff2)/gu)].map(match => basename(match[1] as string)),
);

describe('the preload table', () => {
  it('only names styles the catalogue knows', () => {
    for (const style of Object.keys(STYLE_FONT_FILES)) expect(STYLE_IDS as readonly string[]).toContain(style);
  });

  it('only lists files the stylesheet declares a face for', () => {
    for (const files of Object.values(STYLE_FONT_FILES)) {
      for (const file of [...(files?.text ?? []), ...(files?.code ?? [])])
        expect(declaredFiles.has(basename(file))).toBe(true);
    }
  });

  it('a style that names a bundled face in its stacks has a table row; Contrast uses the device’s own', () => {
    for (const style of STYLE_IDS) {
      const stack = readStyleFile(`style/${style}.css`).match(/--font-(?:body|display|ui):\s*([^;]+);/u)?.[1] ?? '';
      if (style === 'contrast') expect(STYLE_FONT_FILES[style]).toBeUndefined();
      else if (/Inter|Public Sans|Geist|Archivo|Cascadia|Nunito|Orbitron|Hanken|Pixelify|Poppins/u.test(stack))
        expect(STYLE_FONT_FILES[style]).toBeDefined();
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
