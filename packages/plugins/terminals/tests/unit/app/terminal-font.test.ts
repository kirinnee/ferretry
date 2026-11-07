import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTerminalFont, terminalFontLoader } from '../../src/components/terminal-font-loader.ts';
import { TERMINAL_FONT_FACE, terminalFontFamily } from '../../src/lib/terminal-font.ts';
import { THEME_FAMILIES } from '../../src/lib/theme-preferences.ts';
import '../support/dom.ts';

/**
 * WHY A TERMINAL DREW `b u n  d e v`, AND THE TWO THINGS THAT STOP IT.
 *
 * xterm sizes a cell from one `W` and pads every glyph to that cell. When a theme's `--font-mono` named
 * no face the host had, the generic `monospace` answered — a proportional face on a box with only
 * DejaVu Sans — and every narrow letter was spread across a `W`-wide cell. Typography inherited into
 * the emulator (a theme's tracking, an uppercase transform) is the same defect by another road. The
 * pixel proof is the harness's terminal geometry pass; these are the two rules it rests on.
 */

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const themes = readFileSync(join(srcDir, 'styles/themes.css'), 'utf8');
const terminals = readFileSync(join(srcDir, 'components/web-terminals.css'), 'utf8');

/** Every `--font-mono` a theme declares, base included. */
const monoStacks = [...themes.matchAll(/--font-mono:\s*([^;]+);/gu)].map(match => (match[1] as string).trim());

describe('the terminal font stack', () => {
  it('puts the bundled face before the generic in every theme family’s monospace stack', () => {
    // Every family must declare a stack, or inherit one — the base stack is the first.
    expect(monoStacks.length).toBeGreaterThan(0);
    expect(themes).toContain(`--font-mono`);
    expect(THEME_FAMILIES.length).toBe(11);
    for (const stack of monoStacks) {
      const family = terminalFontFamily(stack);
      expect(family.endsWith(`"${TERMINAL_FONT_FACE}", monospace`)).toBe(true);
      // The theme's own faces still come first, so a theme keeps its look wherever they are installed.
      const first = stack.split(',')[0]?.trim() as string;
      expect(family.startsWith(first)).toBe(true);
    }
  });

  it('moves any listed generic to the end, keeps quoted names whole, and drops empty entries', () => {
    expect(terminalFontFamily("'A, B', monospace, Menlo,")).toBe(`'A, B', Menlo, "${TERMINAL_FONT_FACE}", monospace`);
    expect(terminalFontFamily('"Mono X", MONOSPACE')).toBe(`"Mono X", "${TERMINAL_FONT_FACE}", monospace`);
    expect(terminalFontFamily('')).toBe(`"${TERMINAL_FONT_FACE}", monospace`);
  });
});

describe('the emulator’s own typography', () => {
  // Every rule written for exactly this selector — it also appears in a shared flex group above.
  const block = [...terminals.matchAll(/^\.kt-webterm__xterm \{([^}]*)\}/gmu)].map(match => match[1]).join('');

  it('resets every inherited spacing, transform and ligature on the element xterm measures inside', () => {
    for (const declaration of [
      'letter-spacing: normal;',
      'word-spacing: normal;',
      'text-transform: none;',
      'font-kerning: none;',
      'font-variant-ligatures: none;',
      'font-feature-settings: normal;',
    ])
      expect(block).toContain(declaration);
  });
});

describe('loading the bundled face', () => {
  const environment = (loaded: string[], added: unknown[], failing = false) => ({
    fonts: { add: (face: FontFace) => (added.push(face), undefined as never) },
    createFace: (family: string, source: string, weight: string) => ({
      load: async () => {
        if (failing) throw new Error('the font could not be fetched');
        loaded.push(`${family} ${weight} ${source.split('/').at(-1)}`);
        return { family, weight } as unknown as FontFace;
      },
    }),
  });

  it('loads the regular and bold faces once, however many terminals ask', async () => {
    const loaded: string[] = [];
    const added: unknown[] = [];
    const load = terminalFontLoader(() => environment(loaded, added));
    await Promise.all([load(), load()]);
    await load();
    expect(loaded).toEqual([
      `${TERMINAL_FONT_FACE} 400 jetbrains-mono-latin-400-normal.woff2`,
      `${TERMINAL_FONT_FACE} 700 jetbrains-mono-latin-700-normal.woff2`,
    ]);
    expect(added).toHaveLength(2);
  });

  it('never fails the terminal: no font API, or a face that will not load, leaves the theme stack', async () => {
    const added: unknown[] = [];
    await terminalFontLoader(() => ({ fonts: undefined, createFace: undefined }))();
    await terminalFontLoader(() => environment([], added, true))();
    expect(added).toEqual([]);
    // And the page's own loader resolves whatever this DOM offers.
    await loadTerminalFont();
  });
});

describe('loading the bundled face in a browser', () => {
  it('builds each face from the page’s own FontFace and adds the loaded face to the document', async () => {
    const constructed: Array<{ readonly family: string; readonly source: string; readonly descriptors: unknown }> = [];
    const added: unknown[] = [];
    const scope = globalThis as unknown as { FontFace?: unknown };
    const realFontFace = scope.FontFace;
    const realFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    class FakeFontFace {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly descriptors: unknown,
      ) {
        constructed.push({ family, source, descriptors });
      }
      async load(): Promise<FakeFontFace> {
        return this;
      }
    }
    scope.FontFace = FakeFontFace;
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { add: (face: unknown) => added.push(face) },
    });
    try {
      // A fresh copy of the module: the shipped loader is one load per page and may already have run.
      const freshModule = '../../src/components/terminal-font-loader.ts?browser-face';
      const fresh = (await import(freshModule)) as {
        loadTerminalFont: () => Promise<void>;
      };
      await fresh.loadTerminalFont();
    } finally {
      scope.FontFace = realFontFace;
      if (realFonts) Object.defineProperty(document, 'fonts', realFonts);
      else Reflect.deleteProperty(document, 'fonts');
    }

    expect(constructed.map(face => face.family)).toEqual([TERMINAL_FONT_FACE, TERMINAL_FONT_FACE]);
    expect(constructed.map(face => face.descriptors)).toEqual([
      { weight: '400', style: 'normal' },
      { weight: '700', style: 'normal' },
    ]);
    expect(constructed.every(face => /^url\(".+\.woff2"\)$/u.test(face.source))).toBe(true);
    expect(added).toHaveLength(2);
  });
});
