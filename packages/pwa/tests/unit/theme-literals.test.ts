/**
 * NOTHING OUTSIDE THE THEME SHEET MAY PAINT ITS OWN LOOK.
 *
 * A theme in this app is more than a palette: Neo is thick ink strokes, square corners and a hard
 * offset shadow; Studio is hairlines, soft radii and a blur. Both come from role tokens in
 * `styles/themes.css`, so a component that writes `border-radius: 12px`, `1px solid`, a `box-shadow`
 * of its own or a hex colour looks native in exactly the one theme it was drawn in and foreign in the
 * other twenty-one. That is how a run of new transcript cards came to render rounded, hairlined and
 * blurred inside a Neo transcript whose every other surface is square and inked.
 *
 * This suite reads every stylesheet and every TS/TSX file under `src/` and fails on:
 *
 *   - a literal colour (hex, `rgb()`/`hsl()` without a token inside, `white`/`black`), or a
 *     Tailwind palette colour or arbitrary `[#…]` value in a class string;
 *   - a corner radius, a border width or a box-shadow written as a length — `0` is not a look and
 *     stays legal, as do `%` radii (a circle is a shape, not a theme opinion);
 *   - a `font-family` that is not a token;
 *   - Tailwind's own `rounded-xl`/`shadow-2xl`-style ramp keys, which the config does NOT map to
 *     tokens, and arbitrary `rounded-[…px]` / `shadow-[…px…]` values.
 *
 * The theme sheet (`styles/themes.css`), the face declarations it names (`styles/theme-fonts.css`) and the
 * syntax mapping (`styles/highlight.css`) are where literals belong and are not scanned. A literal that
 * genuinely must not follow the theme — a QR code has to stay black on white to scan — carries
 * `theme-literal-ok: <why>` in a comment on its own line or the line above, so the exception is written
 * down where the next reader meets it.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const SRC = join(import.meta.dir, '../../src');

/** The token files: the only places in `src/` a literal look may be written. */
const TOKEN_FILES = new Set(['styles/themes.css', 'styles/theme-fonts.css', 'styles/highlight.css']);

const ESCAPE = 'theme-literal-ok';

interface Finding {
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

/** Blank every comment while keeping each character's line, so a finding's line number is the source's. */
const blankComments = (source: string, kind: 'css' | 'ts'): string => {
  const pattern = kind === 'css' ? /\/\*[\s\S]*?\*\//g : /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g;
  return source.replace(pattern, comment => comment.replace(/[^\n]/g, ' '));
};

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** A non-zero length written as a number: `1px`, `.5rem`, `12px`. `0px` and `0` are not a look. */
const LENGTH = /(?<![\w.])(?:\d*\.\d+|\d+)(?:px|rem|em)\b/g;
const nonZeroLengths = (value: string): string[] =>
  [...value.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ').matchAll(LENGTH)]
    .map(match => match[0])
    .filter(length => Number.parseFloat(length) !== 0);

const COLOUR_FUNCTION = /\b(?:rgba?|hsla?)\(\s*(?!var\()/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const NAMED = /(?<![\w-])(?:white|black)(?![\w-])/;

const BORDER_PROPERTY = /^border(?:-(?:top|right|bottom|left|block|inline)(?:-start|-end)?)?(?:-width)?$/;

/** Every finding in one stylesheet. */
const scanCss = (source: string): Finding[] => {
  const text = blankComments(source, 'css');
  const findings: Finding[] = [];
  const declaration = /(?<=[{;]\s*)(-{0,2}[a-zA-Z][\w-]*)\s*:\s*([^;{}]+)(?=[;}])/g;
  for (const match of text.matchAll(declaration)) {
    const property = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? '';
    const at = { line: lineOf(text, match.index ?? 0), text: `${property}: ${value.trim()}` };
    if (HEX.test(value) || COLOUR_FUNCTION.test(value) || NAMED.test(value)) findings.push({ ...at, rule: 'colour' });
    if (/^border(?:-[a-z-]+)?-radius$/.test(property) && nonZeroLengths(value).length > 0) {
      findings.push({ ...at, rule: 'radius' });
    }
    if (property === 'box-shadow' && nonZeroLengths(value).length > 0) findings.push({ ...at, rule: 'shadow' });
    if (BORDER_PROPERTY.test(property) && nonZeroLengths(value).length > 0) findings.push({ ...at, rule: 'border' });
    if (property === 'font-family' && !/^\s*(?:var\(|inherit\b)/.test(value)) findings.push({ ...at, rule: 'font' });
    if (
      property === 'font' &&
      /\b(?:serif|sans-serif|monospace|system-ui)\b/.test(value.replace(/var\([^)]*\)/g, ''))
    ) {
      findings.push({ ...at, rule: 'font' });
    }
  }
  return findings;
};

const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const UTILITY_COLOUR = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*(?:bg|text|border(?:-[trblxy])?|ring|fill|stroke|from|via|to|outline|decoration|divide|shadow|accent|caret)-(?:white|black|(?:${PALETTE})-\\d{2,3})(?:/\\d+)?(?![\\w-])`,
);
const TS_RULES: readonly (readonly [string, RegExp])[] = [
  ['colour', /['"`]#[0-9a-fA-F]{3,8}['"`]/],
  ['colour', /-\[(?:#|rgba?\(|hsla?\()/],
  ['colour', UTILITY_COLOUR],
  ['radius', /(?<![\w-])rounded(?:-[trblse]{1,2})?-(?:xl|2xl|3xl|\[[^\]]*\d(?:px|rem|em)[^\]]*\])(?![\w-])/],
  ['shadow', /(?<![\w-])shadow-(?:xl|2xl|inner|\[[^\]]*(?<![\w.])(?:\d*\.\d+|[1-9]\d*)(?:px|rem|em)[^\]]*\])(?![\w-])/],
  ['border', /(?<![\w-])border(?:-[trblxy])?-(?:[1-9]\d*|\[[^\]]*\d(?:px|rem|em)[^\]]*\])(?![\w-])/],
];

/** Every finding in one TS/TSX source. */
const scanTs = (source: string): Finding[] => {
  const lines = blankComments(source, 'ts').split('\n');
  return lines.flatMap((line, index) =>
    TS_RULES.filter(([, pattern]) => pattern.test(line)).map(([rule]) => ({
      line: index + 1,
      rule,
      text: line.trim(),
    })),
  );
};

/** Drop a finding whose line, or the line above it, says why the literal must stay. */
const unescaped = (source: string, findings: readonly Finding[]): Finding[] => {
  const lines = source.split('\n');
  return findings.filter(
    finding => !lines[finding.line - 1]?.includes(ESCAPE) && !lines[finding.line - 2]?.includes(ESCAPE),
  );
};

const scanFile = (path: string): string[] => {
  const source = readFileSync(join(SRC, path), 'utf8');
  const findings = path.endsWith('.css') ? scanCss(source) : scanTs(source);
  return unescaped(source, findings).map(finding => `${path}:${finding.line} [${finding.rule}] ${finding.text}`);
};

const files = (pattern: string): string[] =>
  [...new Glob(pattern).scanSync(SRC)].filter(path => !TOKEN_FILES.has(path));

describe('the scanner itself', () => {
  it('flags every literal look in a stylesheet', () => {
    const rules = scanCss(`.card {
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 12px 12px 12px 3px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  color: #b42318;
  background: white;
  font-family: system-ui, sans-serif;
  font: 14px/1.45 system-ui, sans-serif;
  border-top-width: 2px;
  box-shadow: inset 0 -2px 0 var(--accent);
}`).map(finding => finding.rule);
    expect(rules).toEqual([
      'border',
      'border',
      'radius',
      'colour',
      'shadow',
      'colour',
      'colour',
      'font',
      'font',
      'border',
      'shadow',
    ]);
  });

  it('passes a stylesheet that reads only role tokens', () => {
    expect(
      scanCss(`.card:hover,
.card[data-x='1'] {
  border: var(--card-stroke) solid var(--card-border);
  border-radius: var(--card-radius) var(--card-radius) var(--card-radius) var(--card-tail-radius);
  box-shadow: var(--card-shadow);
  background: color-mix(in oklab, var(--accent) 10%, var(--surface));
  color: rgb(var(--accent-rgb) / 50%);
  font-family: var(--font-mono);
  border-radius: 50%;
  border: 0;
  box-shadow: none;
  padding: 8px 12px;
}
@media (pointer: coarse) {
  .card { border-bottom: 0px solid transparent; }
}`),
    ).toEqual([]);
  });

  it('ignores a literal that only a comment mentions', () => {
    expect(scanCss('/* was border-radius: 12px; color: #fff; */ .a { color: var(--fg); }')).toEqual([]);
    expect(scanTs("// className='bg-white rounded-xl'\nconst a = 'text-fg';")).toEqual([]);
  });

  it('flags the class strings that bypass the token config', () => {
    const rules = (line: string) => scanTs(line).map(finding => finding.rule);
    expect(rules(`<div className="bg-white p-3" />`)).toEqual(['colour']);
    expect(rules(`<div className="hover:text-red-500" />`)).toEqual(['colour']);
    expect(rules(`<div className="bg-[#09090b]" />`)).toEqual(['colour']);
    expect(rules(`const c = '#3b82f6';`)).toEqual(['colour']);
    expect(rules(`<div className="rounded-2xl" />`)).toEqual(['radius']);
    expect(rules(`<div className="rounded-t-[3px]" />`)).toEqual(['radius']);
    expect(rules(`<div className="shadow-2xl" />`)).toEqual(['shadow']);
    expect(rules(`<div className="shadow-[0_-3px_0_0_var(--accent)]" />`)).toEqual(['shadow']);
    expect(rules(`<div className="border-l-2" />`)).toEqual(['border']);
  });

  it('passes token utilities, and a dot that is round in every theme', () => {
    expect(
      scanTs(
        `<div className="rounded-panel border border-border bg-surface text-fg shadow-popover rounded-full border-l-heavy shadow-[inset_0_0_0_var(--stroke)_var(--border-strong)]" />`,
      ),
    ).toEqual([]);
  });

  it('lets a literal stand only where its reason is written beside it', () => {
    const source = `const qr = (
  // theme-literal-ok: a QR code must stay dark-on-light to scan
  <rect fill="#ffffff" className="bg-white" />
);
const bad = <rect className="bg-white" />;`;
    expect(unescaped(source, scanTs(source)).map(finding => finding.line)).toEqual([5]);
  });
});

describe('every component reads its look from the theme', () => {
  it('stylesheets carry no literal colour, radius, stroke, shadow or typeface', () => {
    expect(files('**/*.css').flatMap(scanFile)).toEqual([]);
  });

  it('TS/TSX carries no literal colour, and no radius, stroke or shadow outside the token ramp', () => {
    expect(files('**/*.{ts,tsx}').flatMap(scanFile)).toEqual([]);
  });
});
