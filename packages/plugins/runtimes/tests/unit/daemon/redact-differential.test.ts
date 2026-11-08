/**
 * S26: generate text from the alphabet past reviews found leaks in, and hold what the edit screen is given for a
 * component's text (the components read, the one door that text leaves by) to today's `redactText`, frozen in
 * `redact-today.ts`.
 *
 * THE ORACLE IS A SUPERSET, not equality, and only for one shape (ruling #36): today leaks a block whose indicator
 * follows a separator on the line AFTER its name (`PASSWORD⏎= |⏎  value` shows `value`), and 5.0 hides it. So where
 * a text holds that shape, 5.0 must hide at least every byte today hides (it may hide more); everywhere else its
 * output must equal today's exactly. The shape is not carved out: every generated text is checked, that one only
 * against the weaker of the two oracles. Today's own S26 held today to hide at least what the older rule of main
 * hid, so 5.0 hiding at least what today hides keeps that floor too.
 *
 * Every secret value here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { redactTodayText } from './redact-today.ts';

const HIDDEN = '‹hidden›';
const MODEL = parseAccountModel({ version: 1, components: { instructions: { notes: { file: 'notes.md' } } } });

/** What the edit screen is given for an instructions file holding `text`. */
function shownFor(text: string): { text: string; redacted: boolean } {
  const catalog = componentCatalog(MODEL, {
    format: 'present',
    machineName: 'box',
    tools: { claude: undefined, codex: undefined },
    runningSessions: 0,
    userHome: '/home/person',
    acceptsAutoPermissionMode: true,
    instructionBodies: { notes: text },
  });
  const content = catalog.kinds[0]?.components[0]?.content;
  if (content?.form !== 'text') throw new Error('expected text content');
  return { text: content.text, redacted: content.redacted };
}

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

/**
 * The tightened shape (#36): a line that is only a separator and a block indicator (`= |`, `:>-`), after a line
 * that ends in a name, with only blank lines between them.
 */
const TIGHTENED =
  /[A-Za-z0-9_.-]["']?[ \t]*(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))*[ \t]*[:=][ \t]*[|>][-+0-9]*[ \t]*(?:\r\n|\r|\n|$)/u;

/**
 * Whether `wider` hides at least every byte `today` hides: it is `today` with more of its shown text cut out, so
 * each piece `wider` shows is shown by `today`, in order, and each cut of `wider` stands over a non-empty stretch of
 * `today` (shown text, a cut of today's, or both). Nothing generated holds `‹`, so a shown piece can never stand over
 * one of today's cuts. Matched leftmost, which is the match that leaves the most room for the pieces after it.
 */
function hidesAtLeast(today: string, wider: string): boolean {
  const pieces = wider.split(HIDDEN);
  const first = pieces[0] ?? '';
  if (!today.startsWith(first)) return false;
  let at = first.length;
  for (let index = 1; index < pieces.length - 1; index += 1) {
    const piece = pieces[index] ?? '';
    const found = today.indexOf(piece, at + 1);
    if (found < 0) return false;
    at = found + piece.length;
  }
  if (pieces.length === 1) return at === today.length;
  const last = pieces.at(-1) ?? '';
  return today.length - last.length >= at + 1 && today.endsWith(last);
}

/** Why 5.0's output for `text` breaks the oracle, or undefined when it holds. */
function breach(text: string): string | undefined {
  const today = redactTodayText(text);
  const shown = shownFor(text);
  if (shown.text === today.text && shown.redacted === today.redacted) return undefined;
  if (!TIGHTENED.test(text)) return 'differs from today outside the tightened shape';
  if (!hidesAtLeast(today.text, shown.text) || (today.redacted && !shown.redacted)) return 'shows what today hides';
  return undefined;
}

/** The smallest text that still breaks the oracle the same way: characters taken out one at a time while it does. */
function minimal(text: string, why: string): string {
  let smallest = text;
  for (let again = true; again; ) {
    again = false;
    for (let at = 0; at < smallest.length; at += 1) {
      const shorter = smallest.slice(0, at) + smallest.slice(at + 1);
      if (breach(shorter) !== why) continue;
      smallest = shorter;
      again = true;
      at -= 1;
    }
  }
  return smallest;
}

/** The first few texts of `cases` that break the oracle, each cut down, and how many held the tightened shape. */
function breaches(shape: (next: () => number) => string, seed: number, cases: number) {
  const next = seeded(seed);
  const failures: string[] = [];
  let tightened = 0;
  for (let count = 0; count < cases && failures.length < 5; count += 1) {
    const text = shape(next);
    if (TIGHTENED.test(text)) tightened += 1;
    const why = breach(text);
    if (why !== undefined) failures.push(`${why}: ${JSON.stringify(minimal(text, why))}`);
  }
  return { failures, tightened };
}

// A review can re-run either with another seed and a larger count: `REDACT_FUZZ_SEED=7 REDACT_FUZZ_CASES=100000`.
const SEED = Number(process.env.REDACT_FUZZ_SEED ?? 0x5eed);
const CASES = Number(process.env.REDACT_FUZZ_CASES ?? 20_000);

describe('component text redaction never hides less than today', () => {
  it('S26 should hide every byte today hides, and equal today outside the tightened shape, over structured texts', () => {
    // Act
    const result = breaches(generate, SEED, CASES);

    // Assert
    should(result.failures).deepEqual([]);
    should(result.tightened).be.above(0);
  });

  it('S26 should hide every byte today hides, and equal today outside the tightened shape, over unstructured texts', () => {
    // Assert
    should(breaches(soup, SEED ^ 0x50f7, CASES).failures).deepEqual([]);
  });

  it('S26 should take the tightened shape as hiding more than today, never as showing what today hides', () => {
    // Arrange
    const text = 'PASSWORD\n= |\n  fake-block-value-0000\nnext: ok';

    // Act
    const today = redactTodayText(text).text;
    const shown = shownFor(text).text;

    // Assert
    should(today).equal(text);
    should(shown).equal(`PASSWORD\n= |\n  ${HIDDEN}\nnext: ok`);
    should(breach(text)).be.undefined();
  });

  it('S26 should count a byte today hides and 5.0 shows as a breach of the superset', () => {
    // Assert
    should(hidesAtLeast(`a ${HIDDEN} b`, `a ${HIDDEN} b`)).be.true();
    should(hidesAtLeast(`a ${HIDDEN} b`, `${HIDDEN} b`)).be.true();
    should(hidesAtLeast(`a ${HIDDEN} b`, `a ${HIDDEN}`)).be.true();
    should(hidesAtLeast('a fake b', `a ${HIDDEN} b`)).be.true();
    should(hidesAtLeast(`a ${HIDDEN} b`, 'a fake b')).be.false();
    should(hidesAtLeast(`a ${HIDDEN} b`, `a ${HIDDEN} b c`)).be.false();
    should(hidesAtLeast(`a ${HIDDEN} b ${HIDDEN}`, `a ${HIDDEN} b fake`)).be.false();
    should(hidesAtLeast('a b', `a b${HIDDEN}`)).be.false();
    should(hidesAtLeast('ab', 'a')).be.false();
  });
});
