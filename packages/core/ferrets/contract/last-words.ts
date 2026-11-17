import type { FerretEndCause } from './ids.ts';

/** The most lines of a dead harness's stored last screen a reader shows. */
export const LAST_WORDS_LINES = 8;
/** The most characters of them a reader shows, counted from the end. */
export const LAST_WORDS_CHARS = 600;

/**
 * Whether a ferret's end is one whose last screen is worth reading: the agent was ended by a signal, exited, or its
 * pane died without a record of how. The screen itself is never on the cause: it is read through the gated, re-masked
 * `FerretsApi.lastSnapshot` (the snapshot route's stored read) and only then shortened by {@link lastWordsOf}.
 */
export function endHasLastWords(cause: FerretEndCause | undefined): boolean {
  return (
    cause !== undefined &&
    (cause.kind === 'signal' ||
      cause.kind === 'agent_crashed' ||
      cause.kind === 'clean_exit' ||
      cause.kind === 'terminal_gone')
  );
}

/**
 * The closing words of an ALREADY MASKED stored last screen: its last non-empty lines, at most {@link LAST_WORDS_LINES}
 * lines and {@link LAST_WORDS_CHARS} characters (code points, never half of a surrogate pair), counted from the end.
 * `undefined` when the screen shows nothing.
 */
export function lastWordsOf(masked: string): string | undefined {
  const lines = masked
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .slice(-LAST_WORDS_LINES)
    .join('\n');
  const points = Array.from(lines);
  const bounded = points.length > LAST_WORDS_CHARS ? points.slice(-LAST_WORDS_CHARS).join('') : lines;
  const words = bounded.trim();
  return words === '' ? undefined : words;
}
