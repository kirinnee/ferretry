/**
 * r12 H5 — THE THEME FILE, READ AS TEXT (the browser proof is `tests/integration/app/hypermedia-theme.visual.test.ts`).
 *
 *  - NO LITERAL COLOUR in the hypermedia folder (the owner's theme audit scanned for them: the terminal window dots were the
 *    last): a hex, `rgb()`, `rgba()`, `hsl()`, `oklch()` or a named colour in a stylesheet or a component is a colour the
 *    palette cannot change.
 *  - EVERY COLOUR TOKEN DURIAN DEFINES IS SET BY `dh-theme.css`: a token it does not name would keep the package's own fixed
 *    value under every palette. A package bump that adds one fails here, naming it, instead of shipping a stray colour.
 *  - NO CYCLE: a token both sides name is never set to itself (`--surface: var(--surface)` is invalid CSS).
 *  - `look.ts` reads the style's shape and header keywords once per change of the root's theme attributes.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { RENDER_PALETTE_TOKENS, RENDER_STYLE_TOKENS } from '@ferretry/app';
import { ensureDom } from '@ferretry/app/testing';

ensureDom();
import { readLook, variantOf } from '../../../../app/hypermedia/look.ts';

const folder = join(import.meta.dir, '../../../../app/hypermedia');
const durian = dirname(
  createRequire(join(import.meta.dir, '../../../../package.json')).resolve('durian-hypermedia/package.json'),
);

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
const theme = withoutComments(readFileSync(join(folder, 'dh-theme.css'), 'utf8'));

/** The named CSS colours a stylesheet could use instead of a token (the system ones, `transparent` and `currentColor` are not hues). */
const NAMED =
  /(?<![\w-])(?:white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|maroon|navy|teal|aqua|lime|olive|fuchsia|brown|gold|indigo|violet|crimson|cyan|magenta)(?![\w-])/u;
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/u;

describe('the hypermedia folder draws no colour of its own', () => {
  const sources = readdirSync(folder).filter(name => /\.(?:css|tsx?)$/u.test(name));
  // `stage-colours.ts` writes the FORMAT `rgb(r, g, b)` around channels it reads from the page; it holds no colour. It is read below.
  const own = 'stage-colours.ts';
  it('has the files it is checking', () => {
    expect(sources).toContain('dh-theme.css');
    expect(sources).toContain('hypermedia.css');
  });
  it(`${own} holds no colour: no hex, hsl() or named colour, and its only rgb() is the template that writes one resolved`, () => {
    const lines = withoutComments(readFileSync(join(folder, own), 'utf8'))
      .split('\n')
      .filter(line => /:\s|['"`]/u.test(line))
      .filter(line => !line.includes('`rgb(${r}, ${g}, ${b})`'));
    expect(lines.filter(line => LITERAL.test(line))).toEqual([]);
  });
  for (const name of sources.filter(each => each !== own))
    it(`${name} has no hex, rgb(), hsl() or named colour`, () => {
      const text = withoutComments(readFileSync(join(folder, name), 'utf8'))
        // A `#anchor`, a CSS id selector or an entity is not a colour: only declarations and string literals are read.
        .split('\n')
        .filter(line => /:\s|['"`]/u.test(line));
      const found = text.filter(line => LITERAL.test(line) || (name.endsWith('.css') && NAMED.test(line)));
      expect(found).toEqual([]);
    });
});

describe('dh-theme.css names every colour Durian defines', () => {
  /** The custom properties of the package's `:root` rules whose value is a colour literal (light defaults; dark restates the same names). */
  const colourTokens = (file: string): string[] => {
    const css = withoutComments(readFileSync(join(durian, 'src/ui', file), 'utf8'));
    const names = new Set<string>();
    for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
      const value = (match[2] ?? '').trim();
      if (/^(?:#[0-9a-fA-F]{3,8}|rgba?\()/u.test(value)) names.add(match[1] as string);
    }
    return [...names];
  };
  const tokens = [...colourTokens('theme.css'), ...colourTokens('base.css'), ...colourTokens('parts.css')];

  it('finds the package tokens it is checking', () => {
    expect(tokens.length).toBeGreaterThan(80);
    expect(tokens).toContain('--acc');
    expect(tokens).toContain('--term');
  });

  // Tokens that are not a colour a part paints with: the page-level glow (set transparent) is named all the same. Nothing is exempt.
  const missing = tokens.filter(token => !new RegExp(`${token}\\s*:`, 'u').test(theme));
  it('sets every one of them', () => {
    expect(missing).toEqual([]);
  });
});

describe('dh-theme.css breaks no token into a cycle', () => {
  it('never sets a token to a var() of the same name', () => {
    const cycles = [...theme.matchAll(/(--[\w-]+)\s*:\s*var\(\s*(--[\w-]+)/gu)]
      .filter(match => match[1] === match[2])
      .map(match => match[1]);
    expect(cycles).toEqual([]);
  });

  it('reads the names both sides use through the wrapper copies', () => {
    for (const shared of ['surface', 'surface-2', 'surface-3', 'muted', 'faint', 'bg', 'warn'])
      expect(theme).toContain(`--${shared}: var(--fyhm-${shared})`);
  });
});

describe('look.ts', () => {
  const root = document.documentElement;
  const saved = ['data-style', 'data-palette', 'data-mode', 'data-theme'].map(
    name => [name, root.getAttribute(name)] as const,
  );
  afterEach(() => {
    root.style.removeProperty('--hm-shape');
    root.style.removeProperty('--hm-header');
    for (const [name, value] of saved) {
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
  });

  it('names no variant for the default shape and the keyword for the others', () => {
    expect(variantOf('shaped')).toBeUndefined();
    expect(['flat', 'ink', 'block'].map(shape => variantOf(shape as 'flat'))).toEqual(['flat', 'ink', 'block']);
  });

  it('reads the style keywords again when an axis of the theme changes, and not between', () => {
    root.setAttribute('data-style', 'studio');
    root.style.setProperty('--hm-shape', 'flat');
    root.style.setProperty('--hm-header', 'label');
    root.setAttribute('data-mode', 'light');
    const first = readLook();
    expect(first).toEqual({ mode: 'light', shape: 'flat', header: 'label' });
    expect(readLook()).toBe(first);

    root.style.setProperty('--hm-shape', 'block');
    expect(readLook(), 'nothing changed on the root: nothing is read').toBe(first);

    root.setAttribute('data-style', 'neo');
    expect(readLook()).toEqual({ mode: 'light', shape: 'block', header: 'label' });
    root.setAttribute('data-mode', 'dark');
    expect(readLook().mode).toBe('dark');
  });

  it('falls back to the default drawing for a keyword it does not know', () => {
    root.setAttribute('data-style', 'odd');
    root.style.setProperty('--hm-shape', 'wobbly');
    root.style.setProperty('--hm-header', 'huge');
    expect(readLook()).toMatchObject({ shape: 'shaped', header: 'band' });
  });
});

describe('the hypermedia stylesheets read the app only through the renderer contract', () => {
  const contract: ReadonlySet<string> = new Set([...RENDER_PALETTE_TOKENS, ...RENDER_STYLE_TOKENS]);
  const sheets = ['dh-theme.css', 'hypermedia.css'].map(name =>
    withoutComments(readFileSync(join(folder, name), 'utf8')),
  );
  const text = sheets.join('\n');
  /** Every custom property either stylesheet declares. The 3D stage's `--stage-<name>` values are set by `stage-colours.ts` from the recipes here. */
  const own = new Set([...text.matchAll(/(--[\w-]+)\s*:/gu)].map(match => (match[1] as string).slice(2)));
  const read = [...new Set([...text.matchAll(/var\(\s*--([\w-]+)/gu)].map(match => match[1] as string))];
  const foreign = read.filter(name => !own.has(name) && !name.startsWith('stage-'));

  it('finds what it is checking', () => {
    expect(read.length).toBeGreaterThan(100);
    expect(foreign.length).toBeGreaterThan(80);
  });

  it('reads no app token the theme is not required to resolve', () => {
    expect(foreign.filter(name => !contract.has(name))).toEqual([]);
  });

  it('copies only contract tokens onto the wrapper (`--fyhm-<x>: var(--<x>)`), which is how a name both sides use gets read', () => {
    const copied = [...text.matchAll(/--fyhm-[\w-]+\s*:\s*var\(\s*--([\w-]+)\s*\)/gu)].map(match => match[1] as string);
    expect(copied.length).toBeGreaterThan(10);
    expect(copied.filter(name => !contract.has(name))).toEqual([]);
  });
});
