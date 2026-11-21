/**
 * THE ENDS OF A FALLBACK TITLE: a title made from the owner's first words must read as a task, so it never ends on a word that
 * only joins others (`the`, `to`, `between`, `is`, `my`, `why`…): a title that stops there was cut mid-phrase.
 *
 * Pure. `deriveTitle` (conversation-title.ts) is its one caller.
 */

/** Words that only join other words. A title never ends on one (the pronouns `me`, `you`, `it`, `us`, `them` can: `Hear Me`). */
const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  (
    'a an the to of in on at for and or with by between from into about over under as than but so then also just not ' +
    'is are was were am be been being do does did can could would should will shall ' +
    'my your our their his her its this that these those i we he she they ' +
    'why how what when where which who whom whether if'
  ).split(' '),
);

/** `title` without the joining words at its end, or `undefined` when nothing but joining words is left (`Why Is`). */
export function endOnContent(title: string): string | undefined {
  const words = title.split(' ').filter(word => word !== '');
  const last = words.at(-1);
  while (words.length > 0 && FUNCTION_WORDS.has((words.at(-1) ?? '').replaceAll(/[^\p{L}\p{N}']/gu, '').toLowerCase()))
    words.pop();
  if (last === undefined || words.length === 0) return undefined;
  return words.join(' ');
}
