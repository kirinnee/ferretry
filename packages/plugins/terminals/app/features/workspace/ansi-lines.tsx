/**
 * Parsed process output, drawn. Every piece of text goes into a React text node and every colour is
 * either a theme variable named by a palette index or an `rgb(…)` the parser computed from numbers, so
 * nothing a process prints can become markup or a style rule of its own.
 */

import { type CSSProperties, memo } from 'react';
import { type AnsiColor, type AnsiLine, type AnsiSegment, type AnsiStyle, segmentLine } from '../../lib/ansi.ts';

export interface LineMatch {
  readonly start: number;
  readonly end: number;
  readonly index: number;
}

const cssColor = (color: AnsiColor): string =>
  'palette' in color ? `var(--fy-ansi-${String(color.palette)})` : color.rgb;

/** The inline style of a span: colours only. Weight, slant and rules are classes. */
const ansiSpanStyle = (style: AnsiStyle): CSSProperties | undefined => {
  const fg = style.inverse
    ? style.bg === undefined
      ? 'var(--code-bg)'
      : cssColor(style.bg)
    : style.fg && cssColor(style.fg);
  const bg = style.inverse
    ? style.fg === undefined
      ? 'var(--code-fg)'
      : cssColor(style.fg)
    : style.bg && cssColor(style.bg);
  if (!fg && !bg) return undefined;
  return { ...(fg ? { color: fg } : {}), ...(bg ? { backgroundColor: bg } : {}) };
};

const ansiSpanClass = (segment: AnsiSegment, current: boolean): string | undefined => {
  const { style } = segment;
  const names = [
    style.bold ? 'fy-ansi-bold' : '',
    style.dim ? 'fy-ansi-dim' : '',
    style.italic ? 'fy-ansi-italic' : '',
    style.underline ? 'fy-ansi-underline' : '',
    style.strike ? 'fy-ansi-strike' : '',
    segment.match === undefined ? '' : current ? 'fy-proc-match fy-proc-match--current' : 'fy-proc-match',
  ].filter(name => name !== '');
  return names.length === 0 ? undefined : names.join(' ');
};

interface AnsiLinesProps {
  readonly lines: readonly AnsiLine[];
  /** Matches by line number, each carrying its index in the whole list. */
  readonly matches: ReadonlyMap<number, readonly LineMatch[]>;
  readonly currentMatch: number;
}

function AnsiLinesView({ lines, matches, currentMatch }: AnsiLinesProps) {
  return (
    <>
      {lines.map((line, number) => {
        const own = matches.get(number);
        const segments: readonly AnsiSegment[] = own === undefined ? line : segmentLine(line, own);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: output lines have no identity but their position
          <div className="fy-proc-line" key={number}>
            {segments.map((segment, at) => {
              const isCurrent = segment.match !== undefined && segment.match === currentMatch;
              return (
                <span
                  className={ansiSpanClass(segment, isCurrent)}
                  data-current-match={isCurrent ? '' : undefined}
                  data-match={segment.match === undefined ? undefined : ''}
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments of one line are positional
                  key={at}
                  style={ansiSpanStyle(segment.style)}
                >
                  {segment.text}
                </span>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export const AnsiLines = memo(AnsiLinesView);
