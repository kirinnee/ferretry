/** Plain-text shaping for tool results that are read aloud. Pure. */

/** "just now", "5 min ago", "3 h ago", "2 days ago"; "unknown" when the instant is absent or unreadable. */
export function ago(nowMs: number, instant: string | undefined): string {
  if (instant === undefined) return 'unknown';
  const then = Date.parse(instant);
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export interface TailResult {
  readonly text: string;
  readonly linesShown: number;
  readonly truncated: boolean;
}

/**
 * The last `lines` lines of `text`, then the last `maxChars` characters of THAT (the tail is kept — it is the
 * newest). `truncated` says either bound cut something, so the caller can say so aloud.
 */
export function tailText(text: string, lines: number, maxChars: number): TailResult {
  const all = text.replace(/\s+$/u, '').split('\n');
  const byLines = all.slice(-lines);
  let truncated = byLines.length < all.length;
  let joined = byLines.join('\n');
  if (joined.length > maxChars) {
    joined = joined.slice(joined.length - maxChars);
    const firstBreak = joined.indexOf('\n');
    // Start on a line boundary when one is near, so the first line is not a stub.
    if (firstBreak >= 0 && firstBreak < 200) joined = joined.slice(firstBreak + 1);
    truncated = true;
  }
  return { text: joined, linesShown: joined === '' ? 0 : joined.split('\n').length, truncated };
}

/** Cuts to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** One line: whitespace folded. */
export function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
