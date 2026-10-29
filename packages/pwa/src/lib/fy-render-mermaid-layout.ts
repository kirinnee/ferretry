/**
 * HOW A COMPILED MERMAID DIAGRAM IS LAID OUT ON A PHONE — pure functions, no DOM.
 *
 * A diagram is compiled once at Mermaid's natural size (16px text) and shown as an `<img>`. Left to the
 * stylesheet, that image is shrunk to the message column, so a wide left-to-right flowchart on a 390px
 * phone ended up with 8–10px text. Two decisions fix that, and both live here so the component and the
 * tests read one definition:
 *
 *   1. {@link verticalizeMermaid}: on a narrow column a left-to-right flowchart is declared top-to-bottom
 *      BEFORE it is compiled — a column is tall and narrow, a left-to-right graph is the opposite.
 *   2. {@link mermaidDisplayWidth}: the image is shown at (about) its natural size, shrunk to fit the
 *      column only while the text stays readable, and scrolls sideways in its own box beyond that.
 */

/** Mermaid's default text size: what a compiled diagram's text measures at scale 1. */
const MERMAID_TEXT_PX = 16;

/** A column narrower than this is a phone's. Wider is a tablet in landscape or a desktop. */
export const MERMAID_NARROW_COLUMN_PX = 520;

/** The smallest text an inline diagram is ever shrunk to, whatever the column. */
const MERMAID_MIN_TEXT_PX = 12;

/** Inline text never exceeds this multiple of the body size; fullscreen may enlarge up to {@link MERMAID_FULLSCREEN_MAX_SCALE}. */
const MERMAID_MAX_BODY_RATIO = 1.25;

const MERMAID_FULLSCREEN_MAX_SCALE = 2;

const SHARE_OF_BODY_KEPT = 0.85;

const HEADER = /^(\s*(?:graph|flowchart)\s+)(LR|RL)(?=[\s;]|$)/iu;

const FLIPPED: Readonly<Record<string, string>> = { LR: 'TB', RL: 'BT' };

/**
 * The index of the first line of source that is the diagram itself, past what Mermaid allows before it:
 * blank lines, `%%` comments, a `%%{ … }%%` directive (which may span lines) and a leading `---` front
 * matter block. Returns `-1` when nothing but those is there.
 */
function headerLineIndex(lines: readonly string[]): number {
  let at = 0;
  const skip = (): boolean => {
    const line = (lines[at] ?? '').trim();
    if (line === '') return true;
    if (line.startsWith('%%{') && !line.includes('}%%')) {
      while (at + 1 < lines.length && !(lines[at] ?? '').includes('}%%')) at += 1;
      return true;
    }
    return line.startsWith('%%');
  };
  while (at < lines.length && skip()) at += 1;
  if (at < lines.length && (lines[at] ?? '').trim() === '---') {
    let close = at + 1;
    while (close < lines.length && (lines[close] ?? '').trim() !== '---') close += 1;
    if (close >= lines.length) return -1;
    at = close + 1;
    while (at < lines.length && skip()) at += 1;
  }
  return at < lines.length ? at : -1;
}

/**
 * Rewrites a `flowchart`/`graph` declared `LR` or `RL` to `TB` or `BT`. ONLY the direction token on the
 * diagram's own header line is touched: a node label that spells `flowchart LR`, a subgraph's local
 * `direction LR`, and every other kind of diagram are returned byte for byte. Anything that does not
 * match is returned unchanged, so a caller can compare the result to the input to learn whether it did
 * anything.
 */
export function verticalizeMermaid(source: string): string {
  const lines = source.split('\n');
  const at = headerLineIndex(lines);
  if (at < 0) return source;
  const line = lines[at] ?? '';
  const flipped = line.replace(
    HEADER,
    (_whole, lead: string, direction: string) => `${lead}${FLIPPED[direction.toUpperCase()]}`,
  );
  if (flipped === line) return source;
  lines[at] = flipped;
  return lines.join('\n');
}

/** Whether a column is a phone's. A column that could not be measured (0) is treated as wide. */
export function isNarrowColumn(columnPx: number): boolean {
  return columnPx > 0 && columnPx < MERMAID_NARROW_COLUMN_PX;
}

const VIEW_BOX = /^\s*<svg\b[^>]*?\sviewBox\s*=\s*"\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/iu;

/** The compiled diagram's natural size, from its root `viewBox`, or `null` when it declares none. */
export function mermaidNaturalSize(svg: string): { readonly width: number; readonly height: number } | null {
  const found = VIEW_BOX.exec(svg);
  if (found === null) return null;
  const width = Number(found[3]);
  const height = Number(found[4]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { height, width } : null;
}

export interface MermaidDisplay {
  /** The width, in CSS px, to give the image. */
  readonly width: number;
  /** True when that is wider than the column, so the diagram must scroll sideways in its own box. */
  readonly scrolls: boolean;
}

/**
 * The width to show a diagram at.
 *
 * Scale 1 is Mermaid's own size (16px text), which is already at or above the body text, so the diagram
 * is shown there when the column allows. A wider diagram is shrunk to fit only while its text stays at
 * 85% of the body size (never under 12px); past that it keeps that size and scrolls sideways, because a
 * legible diagram that pans beats a whole one nobody can read. Inline, text never exceeds 1.25× the body
 * size; `fullscreen` has the whole screen to spend and may enlarge a small diagram up to twice its size.
 */
export function mermaidDisplayWidth(input: {
  readonly naturalWidth: number;
  readonly columnPx: number;
  readonly bodyPx: number;
  readonly fullscreen?: boolean;
}): MermaidDisplay {
  const { naturalWidth, columnPx, bodyPx } = input;
  const ceiling =
    input.fullscreen === true
      ? MERMAID_FULLSCREEN_MAX_SCALE
      : Math.min(1, (bodyPx * MERMAID_MAX_BODY_RATIO) / MERMAID_TEXT_PX);
  const floorPx = Math.min(MERMAID_TEXT_PX, Math.max(MERMAID_MIN_TEXT_PX, bodyPx * SHARE_OF_BODY_KEPT));
  const floor = Math.min(ceiling, floorPx / MERMAID_TEXT_PX);
  const fit = columnPx > 0 ? columnPx / naturalWidth : ceiling;
  const scale = Math.max(floor, Math.min(ceiling, fit));
  const width = Math.round(naturalWidth * scale);
  return { scrolls: columnPx > 0 && width > columnPx + 0.5, width };
}
