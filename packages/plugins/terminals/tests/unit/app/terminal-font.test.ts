import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTerminalFont, terminalFontLoader } from '../../../app/components/terminal-font-loader.ts';
import { TERMINAL_FONT_FACE, terminalFontFamily } from '../../../app/lib/terminal-font.ts';
import { THEME_FAMILIES } from '@ferretry/app';
import '@ferretry/app/testing';

/**
 * WHY A TERMINAL DREW `b u n  d e v`, AND THE TWO THINGS THAT STOP IT.
 *
 * xterm sizes a cell from one `W` and pads every glyph to that cell. When a theme's `--font-mono` named
 * no face the host had, the generic `monospace` answered — a proportional face on a box with only
 * DejaVu Sans — and every narrow letter was spread across a `W`-wide cell. Typography inherited into
 * the emulator (a theme's tracking, an uppercase transform) is the same defect by another road. The
 * pixel proof is the harness's terminal geometry pass; these are the two rules it rests on.
 */

const here = dirname(fileURLToPath(import.meta.url));
const shellStyles = join(here, '../../../../../app/src/styles');
const themes = readFileSync(join(shellStyles, 'themes.css'), 'utf8');
const fontFaces = readFileSync(join(shellStyles, 'theme-fonts.css'), 'utf8');
const terminals = readFileSync(join(here, '../../../app/components/web-terminals.css'), 'utf8');

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

describe('the bundled face is the shell’s', () => {
  it('is declared once by the shell’s stylesheet, in both weights the emulator draws', () => {
    const faces = [...fontFaces.matchAll(/font-family: '([^']+)';[^}]*?font-weight: (\d+) (\d+);/gu)].filter(
      match => match[1] === TERMINAL_FONT_FACE,
    );
    expect(faces.map(face => [face[2], face[3]])).toEqual([
      ['100', '500'],
      ['600', '900'],
    ]);
  });
});

describe('loading the bundled face', () => {
  const environment = (asked: string[], failing = false) => ({
    fonts: {
      load: async (face: string) => {
        if (failing) throw new Error('the font could not be fetched');
        asked.push(face);
        return [];
      },
    },
  });

  it('asks the document for the regular and bold faces once, however many terminals ask', async () => {
    const asked: string[] = [];
    const load = terminalFontLoader(() => environment(asked));
    await Promise.all([load(), load()]);
    await load();
    expect(asked).toEqual([`400 12.5px "${TERMINAL_FONT_FACE}"`, `700 12.5px "${TERMINAL_FONT_FACE}"`]);
  });

  it('never fails the terminal: no font API, or a face that will not load, leaves the theme stack', async () => {
    await terminalFontLoader(() => ({ fonts: undefined }))();
    await terminalFontLoader(() => environment([], true))();
    // And the page's own loader resolves whatever this DOM offers.
    await loadTerminalFont();
  });
});
