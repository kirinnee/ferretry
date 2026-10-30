/**
 * NO LEFT ACCENT RAILS.
 *
 * A coloured bar down the left edge of a card, row, notice or selected list item is not part of this
 * app's look. State is said by a chip, an icon, a text colour or a background tint; a selected row
 * wears `bg-accent-soft`. This suite reads every stylesheet and TS/TSX file under `src/` and fails on
 * a new accent/status-coloured left border: `border-left` / `border-inline-start` (and their
 * `-color` longhands) drawn in an accent, status or `--card-edge` colour or reserved with
 * `transparent`, and the Tailwind `border-l-(accent|err|warn|ok|heavy)` family.
 *
 * A neutral divider between panes or columns, and a blockquote bar, are not rails: they are not listed
 * here because they are not coloured, except where a rule is shaped like one (see `ALLOWED`).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const SRC = join(import.meta.dir, '../../src');

interface Finding {
  readonly line: number;
  readonly text: string;
}

const RAIL_PROPERTY = /^\s*border-(?:left|inline-start)(?:-color)?\s*:\s*(?<value>[^;]*);?/;
const RAIL_COLOUR =
  /var\(--(?:fy-)?(?:accent|err|warn|ok)\b|var\(--card-edge\)|\bsolid\s+transparent\b|^\s*transparent\s*$/;
const RAIL_CLASS = /(?:^|[\s'"`:])border-[ls]-(?:accent|err|warn|ok|heavy)\b/;

const stripCssComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));

const scanCss = (source: string): Finding[] =>
  stripCssComments(source)
    .split('\n')
    .flatMap((text, index) => {
      const value = RAIL_PROPERTY.exec(text)?.groups?.value;
      return value !== undefined && RAIL_COLOUR.test(value) ? [{ line: index + 1, text: text.trim() }] : [];
    });

const scanTs = (source: string): Finding[] =>
  source.split('\n').flatMap((text, index) => {
    if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*')) return [];
    return RAIL_CLASS.test(text) ? [{ line: index + 1, text: text.trim() }] : [];
  });

/**
 * The only coloured left borders allowed, each matched by file and a fragment of the line.
 *
 * - A markdown / quote bar is a blockquote, not a rail on a card.
 * - The HUD bracket is the top-left CORNER of a bracket drawn with a top border, not a bar.
 * - The ferret message card's rail is removed by the peer-message change; its entry goes with it.
 */
const ALLOWED: readonly { readonly file: string; readonly includes: string; readonly why: string }[] = [
  {
    file: 'features/learning/lesson-row.tsx',
    includes: '<blockquote',
    why: 'a quotation bar',
  },
  {
    file: 'styles/index.css',
    includes: 'border-left: var(--stroke-heavy) solid var(--accent);',
    why: 'the top-left corner of the mission HUD bracket, paired with a top border',
  },
  {
    file: 'components/session-screens.css',
    includes: 'border-left: var(--card-edge) solid var(--fy-accent);',
    why: 'the ferret message card, whose rail is being removed in its own change',
  },
];

const allowed = (file: string, finding: Finding): boolean =>
  ALLOWED.some(entry => entry.file === file && finding.text.includes(entry.includes));

const scanFile = (file: string): string[] => {
  const source = readFileSync(join(SRC, file), 'utf8');
  const findings = file.endsWith('.css') ? scanCss(source) : scanTs(source);
  return findings.filter(finding => !allowed(file, finding)).map(finding => `${file}:${finding.line} ${finding.text}`);
};

const files = (pattern: string): string[] => [...new Glob(pattern).scanSync(SRC)];

describe('the rail scanner itself', () => {
  it('flags an accent, status or card-edge left border in a stylesheet', () => {
    expect(
      scanCss(`.a {
  border-left: var(--card-edge) solid var(--fy-accent);
}
.b { color: red; }
.c {
  border-inline-start: var(--stroke-heavy) solid var(--err);
  border-inline-start-color: var(--warn);
  border-left-color: var(--ok);
  border-inline-start: var(--stroke-heavy) solid transparent;
}`).map(finding => finding.line),
    ).toEqual([2, 6, 7, 8, 9]);
  });

  it('passes a neutral divider, a commented-out rail and the other three sides', () => {
    expect(
      scanCss(`.a { border-left: var(--divider-width) solid var(--border); }
.b { border-inline-start: var(--stroke) solid var(--border-soft); }
.c { border-left: 0; }
/* border-left: var(--stroke-heavy) solid var(--accent); */
.d { border-top: var(--stroke-heavy) solid var(--accent); }
.e { border-color: var(--err); }`),
    ).toEqual([]);
  });

  it('flags the Tailwind left-border rail classes, with or without a variant', () => {
    const hits = (line: string): number => scanTs(line).length;
    expect(hits(`<div className="border-l-heavy border-accent" />`)).toBe(1);
    expect(hits(`<div className="x border-l-err" />`)).toBe(1);
    expect(hits(`cn('a', active && 'border-l-accent bg-accent-soft')`)).toBe(1);
    expect(hits(`<div className="data-[active=true]:border-l-warn" />`)).toBe(1);
    expect(hits(`<div className="border-s-ok" />`)).toBe(1);
  });

  it('passes an accent background, a full border and a hairline divider', () => {
    expect(scanTs(`<div className="border border-err bg-accent-soft border-l border-border-soft" />`)).toEqual([]);
    expect(scanTs(`// border-l-accent is the old rail`)).toEqual([]);
  });
});

describe('the app draws no left accent rail', () => {
  it('stylesheets carry no accent, status or reserved left border', () => {
    expect(files('**/*.css').flatMap(scanFile)).toEqual([]);
  });

  it('TS/TSX carries no border-l accent, status or heavy class', () => {
    expect(files('**/*.{ts,tsx}').flatMap(scanFile)).toEqual([]);
  });
});
