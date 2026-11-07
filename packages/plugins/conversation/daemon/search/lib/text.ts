/**
 * How work search reads text: one tokenizer for what is indexed and what is asked, so a word means the
 * same on both sides (docs/work-search.md § Matching).
 *
 * A token is a run of letters or digits, lower-cased and stripped of accents, with a plural `s` taken
 * off ("cards" finds "card"). Nothing smarter: a stemmer that guesses wrong makes a search look broken in
 * ways a reader cannot predict, and the last word of a query already matches as a prefix.
 */

const WORD = /[\p{L}\p{N}]+/gu;
const MARKS = /\p{M}+/gu;

/** Words too common to say anything about which card is which. Used by the related check only. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be but by can could do does for from has have how i if in into is it its me my no not of ' +
    'on or our so than that the their them then there these they this to too up us was we were what when where ' +
    'which who why will with would you your also just make get all any some should need needs one only own via ' +
    'still now new use using every each more most out over same yes tmp md http https www com github read brief ' +
    'says exactly file claude'
  ).split(' '),
);

/** One word as both sides compare it. */
const normalizeToken = (word: string): string => {
  const plain = word.normalize('NFKD').replace(MARKS, '').toLowerCase();
  // Plural `s`, but not `ss` ("access") and not a short word ("is", "gas").
  return plain.length > 3 && plain.endsWith('s') && !plain.endsWith('ss') ? plain.slice(0, -1) : plain;
};

/** Every token of a text, in order, repeats kept. */
export const tokensOf = (text: string): readonly string[] => {
  const tokens: string[] = [];
  for (const match of text.matchAll(WORD)) tokens.push(normalizeToken(match[0]));
  return tokens;
};

/** The distinct tokens of a text that carry meaning: no stop words, no single letters. */
export const meaningfulTokens = (text: string): readonly string[] => [
  ...new Set(tokensOf(text).filter(token => token.length > 1 && !/^[0-9]+$/u.test(token) && !STOP_WORDS.has(token))),
];

/** Collapses whitespace, for comparing two titles as wholes. */
export const normalizePhrase = (text: string): string => tokensOf(text).join(' ');

/** How long a returned match line may be. */
const MATCH_LINE_LENGTH = 140;

/**
 * The line of `text` that holds the first word beginning with one of `tokens`, cut to
 * {@link MATCH_LINE_LENGTH} around it: what a result row shows under its title. `undefined` when no line
 * holds one, so the caller can try the next field.
 */
export const matchLine = (text: string, tokens: readonly string[]): string | undefined => {
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const hit = [...line.matchAll(WORD)].find(word => tokens.some(token => normalizeToken(word[0]).startsWith(token)));
    if (hit !== undefined) return around(line, hit.index ?? 0);
  }
  return undefined;
};

const around = (line: string, at: number): string => {
  if (line.length <= MATCH_LINE_LENGTH) return line;
  const start = Math.max(0, Math.min(at - 40, line.length - MATCH_LINE_LENGTH));
  const cut = line.slice(start, start + MATCH_LINE_LENGTH).trim();
  return `${start > 0 ? '…' : ''}${cut}${start + MATCH_LINE_LENGTH < line.length ? '…' : ''}`;
};
