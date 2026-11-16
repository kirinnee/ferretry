/** What a person typed after `fy job …`, read as pure functions (docs/jobs.md). */

/** One word, quoted so a POSIX shell reads it back as exactly that word. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The command a person typed after `--`. ONE word is a shell command line as written (pipes, `&&`, redirects work); several
 * words are an argv, each quoted so it reaches the program exactly as typed.
 */
export function commandFromWords(words: readonly string[]): string {
  if (words.length === 1) return words[0] ?? '';
  return words.map(shellQuote).join(' ');
}

/** `30`, `30s`, `5m`, `2h`, `1d` as milliseconds; a bare number is seconds. Undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/u.exec(text.trim());
  if (match === null) return undefined;
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? 's'] ?? 1_000;
  const value = Number(match[1]) * unit;
  return Number.isFinite(value) ? Math.round(value) : undefined;
}
