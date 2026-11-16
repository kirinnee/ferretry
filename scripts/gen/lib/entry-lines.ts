/**
 * The merge-safe list shape every registry shares ("A registry is merge-safe by construction"). The generator writes it, a
 * person may write it by hand, and `--check` reads it back, so one file owns the shape:
 *
 * 1. One entry per line, and nothing else on that line.
 * 2. Entries are in the order the generator emits them (sorted by file name or id), so two new entries land in different places.
 * 3. Every entry ends with its own separator (a comma, or a bare import line): no shared closing line is ever edited. The
 *    opener and the closer (`export default [` / `] as const;`) are lines of their own that no add touches.
 */

/** Each entry on its own line, ending in its own comma. */
export const entryLines = (entries: readonly string[], indent = '  '): readonly string[] =>
  entries.map(entry => `${indent}${entry},`);

/** `<open>` / one entry per line / `<close>`: an array or object literal in the merge-safe shape. */
export const entryList = (
  open: string,
  entries: readonly string[],
  close: string,
  indent = '  ',
): readonly string[] => [open, ...entryLines(entries, indent), close];

const quote = (line: string): string => `\`${line.trim()}\``;

/**
 * Why a file on disk differs from a fresh generation, in sentences that say where the line goes. Generation is optional (a
 * person may add the entry's line by hand), so the only question is whether the line is where the generator would write it:
 *
 * - the same lines in another order → "<line> is out of order: it goes after <previous line>";
 * - a line the generator would not write → "<line> is not an entry the generator would write";
 * - a line the generator would write → "<line> is missing: it goes after <previous line>".
 *
 * Empty when the two texts are equal.
 */
export function explainStale(disk: string, fresh: string): readonly string[] {
  if (disk === fresh) return [];
  const have = disk.split('\n');
  const want = fresh.split('\n');
  const haveSet = new Set(have);
  const wantSet = new Set(want);
  const after = (index: number): string => {
    const previous = want
      .slice(0, index)
      .reverse()
      .find(line => line.trim() !== '');
    return previous === undefined ? 'at the top of the file' : `after ${quote(previous)}`;
  };
  const sentences: string[] = [];
  for (const line of have)
    if (line.trim() !== '' && !wantSet.has(line))
      sentences.push(`${quote(line)} is not an entry the generator would write`);
  want.forEach((line, index) => {
    if (line.trim() !== '' && !haveSet.has(line)) sentences.push(`${quote(line)} is missing: it goes ${after(index)}`);
  });
  if (sentences.length > 0) return sentences;
  // The same lines everywhere: the order is what differs. Report the first line that is not where the generator puts it.
  const at = want.findIndex((line, index) => have[index] !== line);
  const line = want[at] ?? '';
  return [`${quote(line)} is out of order: it goes ${after(at)}`];
}
