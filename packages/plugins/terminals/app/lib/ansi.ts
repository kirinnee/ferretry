/**
 * A small SGR reader for process output. Text in, lines of styled spans out — there is no HTML anywhere
 * in it: a span is a string and a handful of flags, and the renderer puts the string in a text node, so
 * a process that prints `<img onerror=…>` shows those characters and nothing else.
 *
 * What it understands: the SGR attributes (bold, dim, italic, underline, strike, inverse and their
 * resets), the 16 palette colours, the 256-colour cube and 24-bit colour. Every other escape — cursor
 * moves, erases, OSC titles and hyperlinks, charset switches — is consumed and dropped, never shown as
 * stray characters. A lone carriage return rewinds the line (a progress bar redraws itself), `\r\n` is a
 * newline, and other C0 controls are dropped.
 */

/** A palette index (0–15) the theme paints, or a literal `rgb(…)` this module computed from numbers. */
export type AnsiColor = { readonly palette: number } | { readonly rgb: string };

export interface AnsiStyle {
  readonly fg?: AnsiColor;
  readonly bg?: AnsiColor;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly inverse: boolean;
}

interface AnsiSpan {
  readonly text: string;
  readonly style: AnsiStyle;
}

export type AnsiLine = readonly AnsiSpan[];

const PLAIN_STYLE: AnsiStyle = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
};

const byte = (value: number | undefined): number => Math.max(0, Math.min(255, Math.trunc(value ?? 0)));

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

const indexed = (index: number): AnsiColor => {
  const n = byte(index);
  if (n < 16) return { palette: n };
  if (n >= 232) {
    const level = 8 + (n - 232) * 10;
    return { rgb: `rgb(${String(level)},${String(level)},${String(level)})` };
  }
  const cube = n - 16;
  const r = CUBE_LEVELS[Math.floor(cube / 36) % 6] ?? 0;
  const g = CUBE_LEVELS[Math.floor(cube / 6) % 6] ?? 0;
  const b = CUBE_LEVELS[cube % 6] ?? 0;
  return { rgb: `rgb(${String(r)},${String(g)},${String(b)})` };
};

/** Applies one SGR parameter list to a style. Unknown parameters change nothing. */
const applySgr = (style: AnsiStyle, parameters: readonly number[]): AnsiStyle => {
  let next: AnsiStyle = style;
  const list = parameters.length === 0 ? [0] : parameters;
  for (let i = 0; i < list.length; i += 1) {
    const code = list[i] ?? 0;
    if (code === 0) next = PLAIN_STYLE;
    else if (code === 1) next = { ...next, bold: true };
    else if (code === 2) next = { ...next, dim: true };
    else if (code === 3) next = { ...next, italic: true };
    else if (code === 4) next = { ...next, underline: true };
    else if (code === 7) next = { ...next, inverse: true };
    else if (code === 9) next = { ...next, strike: true };
    else if (code === 22) next = { ...next, bold: false, dim: false };
    else if (code === 23) next = { ...next, italic: false };
    else if (code === 24) next = { ...next, underline: false };
    else if (code === 27) next = { ...next, inverse: false };
    else if (code === 29) next = { ...next, strike: false };
    else if (code >= 30 && code <= 37) next = { ...next, fg: { palette: code - 30 } };
    else if (code >= 90 && code <= 97) next = { ...next, fg: { palette: code - 90 + 8 } };
    else if (code >= 40 && code <= 47) next = { ...next, bg: { palette: code - 40 } };
    else if (code >= 100 && code <= 107) next = { ...next, bg: { palette: code - 100 + 8 } };
    else if (code === 39) next = { ...next, fg: undefined };
    else if (code === 49) next = { ...next, bg: undefined };
    else if (code === 38 || code === 48) {
      const mode = list[i + 1];
      let color: AnsiColor | undefined;
      if (mode === 5) {
        color = indexed(list[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        color = { rgb: `rgb(${String(byte(list[i + 2]))},${String(byte(list[i + 3]))},${String(byte(list[i + 4]))})` };
        i += 4;
      } else {
        i += 1;
      }
      if (color !== undefined) next = code === 38 ? { ...next, fg: color } : { ...next, bg: color };
    }
  }
  return next;
};

const same = (a: AnsiStyle, b: AnsiStyle): boolean =>
  a === b ||
  (JSON.stringify(a.fg) === JSON.stringify(b.fg) &&
    JSON.stringify(a.bg) === JSON.stringify(b.bg) &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.inverse === b.inverse);

const ESC = '\u001b';

/**
 * Reads text into lines. The style at the end of one line carries into the next, as a terminal's does.
 * An empty input is no lines; a trailing newline does not make a trailing empty line.
 */
export const parseAnsi = (text: string): readonly AnsiLine[] => {
  const lines: AnsiSpan[][] = [];
  let line: AnsiSpan[] = [];
  let style: AnsiStyle = PLAIN_STYLE;
  let buffer = '';
  const flush = (): void => {
    if (buffer === '') return;
    const last = line[line.length - 1];
    if (last !== undefined && same(last.style, style)) line[line.length - 1] = { text: last.text + buffer, style };
    else line.push({ text: buffer, style });
    buffer = '';
  };
  const endLine = (): void => {
    flush();
    lines.push(line);
    line = [];
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === ESC) {
      const kind = text[i + 1];
      if (kind === '[') {
        let j = i + 2;
        while (j < text.length && /[0-?]/u.test(text[j] as string)) j += 1;
        while (j < text.length && /[ -/]/u.test(text[j] as string)) j += 1;
        const final = text[j];
        if (final === undefined) {
          i = text.length;
          continue;
        }
        if (final === 'm') {
          const raw = text.slice(i + 2, j);
          if (/^[0-9;:]*$/u.test(raw)) {
            flush();
            style = applySgr(
              style,
              raw === '' ? [] : raw.split(/[;:]/u).map(part => (part === '' ? 0 : Number.parseInt(part, 10))),
            );
          }
        }
        i = j + 1;
      } else if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
        let j = i + 2;
        while (j < text.length && text[j] !== '\u0007' && !(text[j] === ESC && text[j + 1] === '\\')) j += 1;
        i = text[j] === ESC ? j + 2 : j + 1;
      } else if (kind === '(' || kind === ')' || kind === '*' || kind === '+' || kind === '#') {
        i += 3;
      } else {
        i += 2;
      }
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1;
        continue;
      }
      buffer = '';
      line = [];
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endLine();
      i += 1;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (ch !== '\t' && (code < 0x20 || code === 0x7f)) {
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  if (buffer !== '' || line.length > 0) endLine();
  return lines;
};

export const lineText = (line: AnsiLine): string => line.map(span => span.text).join('');

/** One match of a search in the whole text: a line and a half-open range of UTF-16 offsets in it. */
export interface TextMatch {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** Every case-insensitive, non-overlapping match of `needle`, in reading order. An empty needle matches nothing. */
export const findMatches = (lines: readonly AnsiLine[], needle: string): readonly TextMatch[] => {
  if (needle === '') return [];
  const wanted = needle.toLowerCase();
  const matches: TextMatch[] = [];
  lines.forEach((line, index) => {
    const haystack = lineText(line).toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(wanted, from);
      if (at < 0) break;
      matches.push({ line: index, start: at, end: at + wanted.length });
      from = at + wanted.length;
    }
  });
  return matches;
};

/** A piece of one line: some text, how it is styled, and which match it belongs to when it is highlighted. */
export interface AnsiSegment {
  readonly text: string;
  readonly style: AnsiStyle;
  readonly match?: number;
}

/**
 * Cuts one line at the edges of its matches. `matches` are this line's, each with the index it has in the
 * whole list (so the caller can tell the current one apart).
 */
export const segmentLine = (
  line: AnsiLine,
  matches: readonly { readonly start: number; readonly end: number; readonly index: number }[],
): readonly AnsiSegment[] => {
  if (matches.length === 0) return line.map(span => ({ text: span.text, style: span.style }));
  const segments: AnsiSegment[] = [];
  let offset = 0;
  for (const span of line) {
    const spanEnd = offset + span.text.length;
    let cursor = offset;
    for (const match of matches) {
      if (match.end <= cursor || match.start >= spanEnd) continue;
      const from = Math.max(match.start, cursor);
      const to = Math.min(match.end, spanEnd);
      if (from > cursor) segments.push({ text: span.text.slice(cursor - offset, from - offset), style: span.style });
      segments.push({ text: span.text.slice(from - offset, to - offset), style: span.style, match: match.index });
      cursor = to;
    }
    if (cursor < spanEnd) segments.push({ text: span.text.slice(cursor - offset), style: span.style });
    offset = spanEnd;
  }
  return segments;
};
