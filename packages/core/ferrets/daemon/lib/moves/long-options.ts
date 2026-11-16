/**
 * ONE reading of GNU-style long options for every argument-aware rule of the command classifier.
 *
 * A rule that watches `--output` with a regex misses `--output=FILE` unless it remembers the `=`, and misses `--out`
 * unless it remembers that GNU programs (`sort`, `sed`, `uniq`, `git`) accept any unambiguous prefix of a long option.
 * Doing that per tool is how `fd --exec=rm` and `sort --out=FILE` were judged read-only. So the rules do not look at
 * option spellings at all: they hand the words and the options they WATCH (the ones that write a file or run a
 * command) to {@link normalizeLongOptions}, and read the result.
 *
 * FAIL CLOSED: a `--word` is taken for a watched option when it is that option or ANY prefix of it, so an
 * abbreviation a given program would reject, or find ambiguous, still counts as the watched option (never the other
 * way round). A word that is not a prefix of any watched option is passed through untouched.
 */

/** The longest part of a long option that is its name: everything before the first `=`. */
function optionName(word: string): string {
  const equals = word.indexOf('=');
  return equals === -1 ? word : word.slice(0, equals);
}

/**
 * Rewrites every long option that names (or abbreviates) a watched one to the watched option's full spelling, and
 * splits an attached `=value` into its own word after it, so `--exec=rm` reads `--exec rm` and `--out=f` reads
 * `--output f`. Words after a bare `--` are operands and are left alone.
 *
 * `watched` entries are full long options with their dashes (`--output`). When a prefix could be several of them, the
 * first listed is used, so a caller lists options that share one meaning (or reads the result with that in mind).
 */
export function normalizeLongOptions(words: readonly string[], watched: readonly string[]): readonly string[] {
  const result: string[] = [];
  let operandsOnly = false;
  for (const word of words) {
    if (operandsOnly || !word.startsWith('--')) {
      result.push(word);
      continue;
    }
    if (word === '--') {
      operandsOnly = true;
      result.push(word);
      continue;
    }
    const name = optionName(word);
    const matched = watched.find(option => option === name) ?? watched.find(option => option.startsWith(name));
    if (matched === undefined) {
      result.push(word);
      continue;
    }
    result.push(matched);
    const value = word.slice(name.length + 1);
    if (word.length > name.length && value !== '') result.push(value);
  }
  return result;
}

/** Whether the words, once normalised, name any of the watched long options before a bare `--` ends the options. */
export function namesLongOption(words: readonly string[], watched: readonly string[]): boolean {
  const options = normalizeLongOptions(words, watched);
  const end = options.indexOf('--');
  return (end === -1 ? options : options.slice(0, end)).some(word => watched.includes(word));
}
