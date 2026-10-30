/**
 * EVERY THEME'S FONTS ARE REAL, LICENSED, AND SMALL.
 *
 * `themes.css` names faces per family; before this suite nothing declared them, so each stack fell
 * through to the system font and every theme drew the same letters. Three views of one fact now have
 * to agree — the stylesheet's stacks (`themes.css`), the declarations (`theme-fonts.css`) and the
 * preload table (`lib/theme-fonts.ts`) — and this suite is what makes disagreement a red build:
 *
 *   - every face a family's resolved stacks name is declared, and is in that family's table entry;
 *   - every declared file exists, and every file on disk is declared and has its licence recorded;
 *   - each family's files stay inside the byte budget;
 *   - the preload hint is one `<link>` per text face, once, never for code faces or an unknown family.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { THEME_FONT_FILES, familyOfThemeAttribute, preloadThemeFonts } from '../../src/lib/theme-fonts.ts';
import { THEME_FAMILIES } from '../../src/lib/theme-preferences.ts';
import '../support/dom.ts';

const SRC = join(import.meta.dir, '../../src');
const FONTS = join(SRC, 'assets/fonts');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

const BUDGET_BYTES = 150 * 1024;

/** `family → file basename`, from the `@font-face` blocks. */
function declaredFaces(): Map<string, string[]> {
  const faces = new Map<string, string[]>();
  for (const block of read('styles/theme-fonts.css').matchAll(/@font-face\s*\{([^}]*)\}/gu)) {
    const body = block[1] ?? '';
    const family = /font-family:\s*'([^']+)'/u.exec(body)?.[1];
    const file = /url\('\.\.\/assets\/fonts\/([^']+)'\)/u.exec(body)?.[1];
    if (family === undefined || file === undefined) throw new Error(`an undeclared shape: ${body}`);
    faces.set(family, [...(faces.get(family) ?? []), file]);
  }
  return faces;
}

const faces = declaredFaces();
const basename = (url: string): string => url.split('/').at(-1) ?? url;

/** The `--font-*` declarations of every rule whose selector mentions `needle`, as `token → value`. */
function fontTokens(css: string, selector: RegExp): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (!selector.test(rule[1] ?? '')) continue;
    for (const declaration of (rule[2] ?? '').matchAll(/--font-(body|display|mono|ui|prose):\s*([^;]+);/gu)) {
      tokens.set(declaration[1] ?? '', declaration[2] ?? '');
    }
  }
  return tokens;
}

/**
 * The declared faces a family's stacks reach once every `var(--font-x)` is expanded. A bundled face
 * always resolves, so it ends its stack: whatever a stack names after it can never be drawn.
 */
function reachedFaces(family: string): readonly string[] {
  const css = read('styles/themes.css').replace(/\/\*[\s\S]*?\*\//gu, '');
  const base = fontTokens(css, /^\s*:root,\s*\[data-swatch\]\s*$/u);
  const own = fontTokens(css, new RegExp(`:root\\[data-theme\\^='${family}-'\\]`, 'u'));
  const tokens = new Map([...base, ...own]);
  const expand = (value: string, depth = 0): string =>
    depth > 5
      ? value
      : value.replace(/var\(--font-(\w+)\)/gu, (_, name: string) => expand(tokens.get(name) ?? '', depth + 1));
  const names = new Set<string>();
  for (const value of tokens.values()) {
    const first = expand(value)
      .split(',')
      .map(part => part.trim().replace(/^['"]|['"]$/gu, ''))
      .find(name => faces.has(name));
    if (first !== undefined) names.add(first);
  }
  return [...names].sort();
}

const filesOfFamily = (id: string): readonly string[] => {
  const entry = THEME_FONT_FILES[id as keyof typeof THEME_FONT_FILES];
  return entry === undefined ? [] : [...entry.text, ...entry.code].map(basename);
};

describe('every family reaches exactly the faces it ships', () => {
  for (const { id } of THEME_FAMILIES) {
    it(`${id}: the faces its stacks name are the files its table lists`, () => {
      const fromStacks = reachedFaces(id).flatMap(name => faces.get(name) ?? []);
      expect([...fromStacks].sort()).toEqual([...filesOfFamily(id)].sort());
    });
  }

  it('ships a face for every family but Contrast, which draws with the device on purpose', () => {
    expect(THEME_FONT_FILES.contrast).toBeUndefined();
    for (const { id } of THEME_FAMILIES) if (id !== 'contrast') expect(filesOfFamily(id).length).toBeGreaterThan(0);
  });
});

describe('the files', () => {
  const onDisk = readdirSync(FONTS).filter(name => name.endsWith('.woff2'));
  const declared = [...faces.values()].flat();

  it('declares every file on disk and ships every file it declares', () => {
    expect([...declared].sort()).toEqual([...onDisk].sort());
  });

  it('records a licence for every face', () => {
    const ledger = readFileSync(join(FONTS, 'LICENSES.md'), 'utf8');
    const licences = new Set(readdirSync(join(FONTS, 'licenses')));
    for (const family of faces.keys()) expect(ledger).toContain(family);
    for (const link of ledger.matchAll(/\]\(licenses\/([^)]+)\)/gu)) expect(licences.has(link[1] ?? '')).toBe(true);
    for (const name of licences) {
      expect(ledger).toContain(`licenses/${name}`);
      expect(readFileSync(join(FONTS, 'licenses', name), 'utf8')).toContain('SIL Open Font License');
    }
  });

  it('declares every face swap-loaded, latin-ranged and woff2', () => {
    const css = read('styles/theme-fonts.css');
    const blocks = css.match(/@font-face\s*\{[^}]*\}/gu) ?? [];
    expect(blocks).toHaveLength(declared.length);
    for (const block of blocks) {
      expect(block).toContain('font-display: swap');
      expect(block).toContain("format('woff2')");
      expect(block).toContain('unicode-range');
    }
  });

  it('reaches no remote host', () => {
    expect(read('styles/theme-fonts.css').replace(/\/\*[\s\S]*?\*\//gu, '')).not.toContain('http');
  });
});

describe('the byte budget', () => {
  for (const { id } of THEME_FAMILIES) {
    it(`${id}: every file it may fetch fits inside 150 KB together`, () => {
      const bytes = filesOfFamily(id).reduce((sum, file) => sum + statSync(join(FONTS, file)).size, 0);
      expect(bytes).toBeLessThanOrEqual(BUDGET_BYTES);
    });
  }
});

describe('preloading the active family', () => {
  const host = () => {
    const links: Array<Record<string, string>> = [];
    return {
      links,
      head: { append: (link: unknown) => void links.push(link as Record<string, string>) },
      createElement: () => ({}) as HTMLLinkElement,
    };
  };

  it('hints each text face once, as a CORS font preload, and never a code face', () => {
    const page = host();
    preloadThemeFonts('geist', page);
    preloadThemeFonts('geist', page);
    expect(page.links).toHaveLength(1);
    expect(page.links[0]).toMatchObject({ rel: 'preload', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
    expect(basename(page.links[0]?.href ?? '')).toBe('geist-latin-wght-normal.woff2');
  });

  it('hints a second family on top of the first, sharing a file only once', () => {
    const page = host();
    preloadThemeFonts('studio', page);
    preloadThemeFonts('ma', page);
    expect(page.links.map(link => basename(link.href ?? ''))).toEqual([
      'inter-latin-wght-normal.woff2',
      'gelasio-latin-wght-normal.woff2',
    ]);
  });

  it('hints nothing for Contrast, an unknown family or no family', () => {
    const page = host();
    for (const family of ['contrast', 'ember', undefined]) preloadThemeFonts(family, page);
    expect(page.links).toEqual([]);
  });

  it('writes into the real document by default', () => {
    preloadThemeFonts('neo');
    const hinted = [...document.head.querySelectorAll('link[rel="preload"]')].map(link =>
      basename(link.getAttribute('href') ?? ''),
    );
    // The document is shared with the other suites, which may already have hinted their own families.
    expect(hinted).toContain('archivo-black-latin-400-normal.woff2');
    expect(hinted.filter(name => name === 'archivo-black-latin-400-normal.woff2')).toHaveLength(1);
  });

  it('reads the family out of data-theme', () => {
    expect(familyOfThemeAttribute('geist-dark')).toBe('geist');
    expect(familyOfThemeAttribute('light')).toBe('');
    expect(familyOfThemeAttribute(undefined)).toBeUndefined();
  });
});
