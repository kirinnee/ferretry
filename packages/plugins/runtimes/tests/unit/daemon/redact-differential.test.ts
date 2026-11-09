import { describe, it } from 'bun:test';
import should from 'should';
import { referenceRedactText } from './redact-reference.ts';
import { shownFor } from './redact-support.ts';

/** The real `redactText`, reached through the components read (the one door a component's text leaves by). */
const redactText = (text: string): { readonly text: string } => shownFor(text);

// The loop this ends: every review found one more way a line break, a separator or a lead character hid a value
// from the new rules that the old `redactText` had hidden. Instead of waiting for the next one, generate text from
// the alphabet those findings came from and hold the new rules to the old one: a secret value the reference
// (main's `redactText`) hid must not survive `redactText`. The one thing the new rule may leave where the old one hid
// it is a TRUE pointer (`$NAME`, `${NAME}`, `${secret:NAME}`): it holds no secret, so it is no value of the alphabet
// and can never count as a leak. A `${NAME-default}` is no pointer: its default is a value, and is in the alphabet.

const SECRET_VALUES = [
  'hunter2hunter2xyz',
  'c2VjcmV0cGFzc3dvcmQ=',
  'aHVudGVyMmh1bnRlcjI==',
  'ghp_abcdefghijklmnop',
  'sk-qrstuvwxyz012345',
  'Zm9vYmFyYmF6cXV4cXV1',
  'tok3nvalue99',
];
const NAMES = [
  'password',
  'PASSWORD',
  'api_token',
  'API_KEY',
  'TOKEN',
  'TOKEN_',
  'GITHUB_TOKEN',
  'db_pass',
  'secret',
  'auth',
  'x-api-key',
  '1API_KEY',
  '9TOKEN',
  'mode',
  'user_name',
  'login_page',
];
const LEADS = [
  '',
  ' ',
  '  ',
  '\t',
  '/',
  '$',
  'export ',
  '|',
  '- ',
  '"',
  "'",
  '(',
  '[',
  '{',
  '>',
  ',',
  ';',
  'see ',
  'set the ',
  '-=',
  '.=',
  '--',
  '\n',
  '\n  ',
  '\r\n    ',
];
const GAPS = ['', '', ' ', '  ', '\t', '\n', '\r', '\r\n', '\n  ', '\n\n', '\r\r', ' \n '];
const MARKS = [':', '=', ':', '=', ':='];
const BLOCKS = ['', '', '', '', '|', '>-', '|+', '>2'];
const PARENTS = ['db', 'auth', 'env', 'mcp.servers', 'x'];
const QUOTES = ['', '"', "'"];
/** True pointers, which may stay, and `${NAME<op>default}` forms whose default is a value (`%` is the value). */
const POINTERS = ['$HOME', '${TOKEN}', '${secret:API_KEY}', '${GITHUB_TOKEN}', '$API_KEY'];
const EXPANSIONS = [
  '${TOKEN:-%}',
  '${API_KEY-%}',
  '${secret:-%}',
  '${auth:=%}',
  '${TOKEN=%}',
  '${PASSWORD:+%}',
  '${TOKEN+%}',
  '${db_pass:?%}',
  '${x-api-key?%}',
  '${mode:-%}',
];
const BREAKS = ['\n', '\r\n', '\r', '\n  ', '\n\n', ' ', '\n\t', '\n    '];
/** What can stick one value to the next without a space (the review that found them cut a secret behind each). */
const GLUES = ['<', '>', '{', '&', '?', '&amp;', '=', ':', '/', '|', '$', '@', ';', '"', "'"];
/** The widest alphabet of the review's own unstructured fuzz: names, separators, quotes, breaks, indicators, glue. */
const SOUP = [
  ...NAMES,
  ...SECRET_VALUES,
  ...SECRET_VALUES,
  ':',
  '=',
  ':=',
  ' ',
  '  ',
  '\t',
  '"',
  "'",
  '`',
  '\n',
  '\r\n',
  '\r',
  '(',
  ')',
  '[',
  '{',
  '}',
  ',',
  ';',
  '/',
  '$',
  '#',
  '|',
  '>-',
  '|+',
  '>2',
  '-',
  '?',
  '&',
  '@',
  '<',
  '>',
  '&amp;',
  ...POINTERS,
  ...EXPANSIONS.map(form => form.replace('%', 'hunter2hunter2xyz')),
];

/** mulberry32: a small seeded generator, so a run is the same run everywhere and nothing flakes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(next: () => number): string {
  const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)] as T;
  const entries = 1 + Math.floor(next() * 5);
  let text = '';
  for (let at = 0; at < entries; at += 1) {
    const quote = pick(QUOTES);
    if (next() < 0.25) text += `${pick(PARENTS)}:${pick(BREAKS)}`;
    const separator = `${pick(GAPS)}${pick(MARKS)}${pick(GAPS)}${pick(BLOCKS)}${pick(GAPS)}`;
    const value = pick(SECRET_VALUES);
    const shape = next();
    const written = shape < 0.15 ? pick(EXPANSIONS).replace('%', value) : shape < 0.25 ? pick(POINTERS) : value;
    text += pick(LEADS) + pick(NAMES) + pick(QUOTES) + separator + quote + written + quote;
    if (next() < 0.3) text += pick(NAMES);
    if (next() < 0.3) text += pick(GLUES) + pick(SECRET_VALUES);
    text += pick(BREAKS);
    if (next() < 0.15)
      text += `${pick(LEADS)}${pick(SECRET_VALUES)}${pick(BREAKS)}${pick(GLUES)}${pick(SECRET_VALUES)}${pick(BREAKS)}`;
  }
  return text;
}

/** No structure at all: pieces of the alphabet, in any order. */
function soup(next: () => number): string {
  const length = 3 + Math.floor(next() * 18);
  let text = '';
  for (let at = 0; at < length; at += 1) text += SOUP[Math.floor(next() * SOUP.length)] ?? '';
  return text;
}

const occurrences = (text: string, value: string): number => text.split(value).length - 1;

/** Which of the rules lets a value the reference hid through, or undefined when none does. */
function leak(text: string): string | undefined {
  const reference = referenceRedactText(text).text;
  const current = redactText(text).text;
  for (const value of SECRET_VALUES) {
    const hidden = occurrences(text, value) > occurrences(reference, value) ? occurrences(reference, value) : undefined;
    if (hidden === undefined) continue;
    if (occurrences(current, value) > hidden) return `redactText shows ${value}`;
  }
  return undefined;
}

/** The smallest text that still leaks: characters taken out one at a time while it does. */
function minimal(text: string, why: string): string {
  let smallest = text;
  for (let again = true; again; ) {
    again = false;
    for (let at = 0; at < smallest.length; at += 1) {
      const shorter = smallest.slice(0, at) + smallest.slice(at + 1);
      if (leak(shorter) !== why) continue;
      smallest = shorter;
      again = true;
      at -= 1;
    }
  }
  return smallest;
}

/** The first few texts of `cases` that leak, each cut down to what leaks. */
function leaks(shape: (next: () => number) => string, seed: number, cases: number): string[] {
  const next = seeded(seed);
  const failures: string[] = [];
  for (let count = 0; count < cases && failures.length < 5; count += 1) {
    const text = shape(next);
    const why = leak(text);
    if (why !== undefined) failures.push(`${why}: ${JSON.stringify(minimal(text, why))}`);
  }
  return failures;
}

// A review can re-run either with another seed and a larger count: `REDACT_FUZZ_SEED=7 REDACT_FUZZ_CASES=100000`.
const SEED = Number(process.env.REDACT_FUZZ_SEED ?? 0x5eed);
const CASES = Number(process.env.REDACT_FUZZ_CASES ?? 20_000);

describe('redactText never hides less than the text rules of 4.291.5', () => {
  it('S26 should hide every secret value the reference hid, over 20,000 generated structured texts', () => {
    should(CASES).be.aboveOrEqual(20_000);
    should(leaks(generate, SEED, CASES)).deepEqual([]);
  });

  it('S26 should hide every secret value the reference hid, over 20,000 generated texts with no structure', () => {
    should(leaks(soup, SEED ^ 0x50f7, CASES)).deepEqual([]);
  });
});
