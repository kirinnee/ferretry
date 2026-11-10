/**
 * Generate command lines from the alphabet of flags, separators, quotes and values the flag leak (ruling #37) lives
 * in, and hold what the Resolved view says for each — as launch flags and as an MCP server's arguments — to today's
 * rule, frozen in `resolved-view-today.ts`.
 *
 * THE ORACLE IS A SUPERSET, not equality, and only on the words of the tightened shapes (ruling #37): today judges a
 * word whole under no name, so `--token=<value>`, `--token <value>`, `-H<token>`, `--header=Bearer <token>` and a
 * quoted token are all shown, and 5.0 hides their value. So on a word of such a shape — decided here from the words
 * alone ({@link tightened}), never from the code under test — 5.0 must hide at least every byte today hides (it may
 * hide more). Every other word must equal today's exactly. Nothing is carved out: every generated word is checked.
 *
 * TWO MORE ORACLES (ruling #40, review r1 F2/F4). Every word must also hide at least what ruling #37 hid, frozen in
 * `command-line-37.ts`, since the 4.291.5 floor never hid `-H<token> KEY=v` and so could not see #40 show it again.
 * And the generator builds COMPOUND words — a flag, a value glued or stuck to it, then a nested `KEY=v` (quoted or
 * not), then more — with a marker value it only ever puts under a secret-NAMED key: that marker must never be shown.
 *
 * Review r2 (r3 round) added three dimensions, so the generator, not a reviewer, finds the next shape: pointers
 * (`${secret:…}`) before a key, after its value (set apart by a space or `#`) and between keys (M1); a key stuck
 * straight to a one-letter flag, with a second cut after it (`-eAPI_KEY=v,token=w`, M2); and a key in a glued flag's
 * own part with a pointer and a second cut in the value (`--hdr,api_key=v;y=${secret:Z};token=w`, M3). And two more
 * oracles: every word must hide at least what the r2 rule hid (`command-line-r2.ts`, frozen), and a compound word
 * built only of harmless parts must be shown exactly as ruling #37 showed it — as written, unless #37's own name rule
 * reads its flag part as a secret name (`--name,LOG_LEVEL:$API_TOKEN,x=v` names TOKEN) — so #40 cuts nothing of it.
 *
 * Review r3 (r4 round) added a marked value that holds `=` or `:` itself (N1): base64 padding 0, 1 or 2, `Basic`
 * before it, `user:pass`, `user=pass`, crossed with every pointer position after it — set apart by a space or `#`,
 * or as a harmless key's value. A pointer BEFORE such a value (`API_KEY=${secret:X} <v>==`) shows it: a GAP
 * candidate of the r4 report, so that arrangement is generated only for values that hold no `=` or `:`. Harmless
 * values with padding and `user:pass` stand under harmless keys too, and must be shown exactly. And one more floor:
 * every word must hide at least what the r3 rule hid (`command-line-r3.ts`, frozen at 9a35f2d316).
 *
 * Every secret value here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { type ResolvedProfile, type ResolveInput, resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';
import { todayFlag, todayServerLine } from './resolved-view-today.ts';
import { HIDDEN, hidesAtLeast, hidesAtLeast37, lineHidesAtLeast, type Shown } from './command-line-family.ts';
import { flags37, serverLine37 } from './command-line-37.ts';
import { shownWordsR2 } from './command-line-r2.ts';
import { shownWordsR3 } from './command-line-r3.ts';
import { shownWordsR4 } from './command-line-r4.ts';

const resolved = (input: ResolveInput): ResolvedProfile => {
  const result = resolveProfile(input);
  if (!result.ok) throw new Error(`expected a resolution, got ${JSON.stringify(result.failure)}`);
  return result.resolved;
};

/** What 5.0's Resolved view says for these launch flags, in order. */
function shownFlags(flags: readonly string[]): readonly Shown[] {
  const model = parseAccountModel({
    version: 1,
    components: { settings: { base: { harness: 'claude', flags: [...flags] } } },
    profiles: { p: { layers: ['settings/base'] } },
  });
  return resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' }))
    .filter(entry => entry.field === 'flags')
    .map(entry => (entry.hidden === true ? { value: entry.value, hidden: true } : { value: entry.value }));
}

const COMMAND = 'run-server';

/** What 5.0's Resolved view says for an MCP server started as `run-server <args>`. */
function shownServer(args: readonly string[]): string {
  const model = parseAccountModel({
    version: 1,
    components: { mcp: { local: { command: COMMAND, args: [...args] } } },
    profiles: { p: { layers: ['mcp/local'] } },
  });
  const entry = resolvedEntries(resolved({ model, profile: 'p', harness: 'claude' })).find(
    candidate => candidate.field === 'mcp',
  );
  if (entry === undefined) throw new Error('expected an mcp entry');
  return entry.value;
}

/**
 * Whether a word is one of the shapes ruling #37 tightened, from the words alone: a flag with a value glued on by `=`
 * or a space, a one-letter flag with eight or more characters stuck to it, the word after a flag, or a word holding a
 * quote, a space or a separator (a quoted value, `Bearer <token>`, `key:<token>`).
 */
function tightened(word: string, before: string | undefined): boolean {
  if (/^-[^\s=]*[=\s]/u.test(word)) return true;
  if (/^-[A-Za-z][^-]/u.test(word) && word.length >= 10) return true;
  if (before?.startsWith('-') === true && !/[=\s]/u.test(before) && !word.startsWith('-')) return true;
  return /[\s"'`:,;=]/u.test(word);
}

// ── The generator ────────────────────────────────────────────────────────────────────────────────

const FLAGS = [
  '--token',
  '--TOKEN',
  '--api-key',
  '--x-api-key',
  '--auth',
  '--password',
  '-token',
  '-k',
  '-H',
  '-p',
  '--header',
  '--model',
  '--name',
  '--verbose',
  '-v',
  '---token',
  '-',
  '--',
  '-1',
];
const VALUES = [
  'not-a-real-secret-0000',
  'sk-not-a-real-key-0000',
  'ghp_notarealtoken0000',
  'AKIANOTAREALKEY00000',
  'eyJnotarealjwt0000',
  'ya29.notarealtoken',
  'xoxb-notarealtoken0',
  'Bearer ghp_notarealtoken0000',
  '$API_TOKEN',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  '${secret:API_TOKEN}',
  'short',
  'claude-opus-5-5',
  '/home/person/task-runner-default',
  'a:b',
  'KEY=sk-not-a-real-key-0000',
  'abc,sk-not-a-real-key-0000',
  '',
];
const SEPARATORS = ['=', ' ', '', '  ', '\t', ':', '=='];
const QUOTES = ['', "'", '"', '`'];
const SOUP = 'aZ09-_=:\'" \tskghpTOKEN$';

/**
 * The value the generator puts only under a secret-NAMED nested key, never anywhere else: a plain-text secret, so
 * whatever shows it has shown a secret-named key's value (ruling #40).
 */
const NESTED_SECRET = 'nested-fake-value-0000';
const NESTED_SECRET_KEYS = [
  'API_KEY',
  'api_key',
  'X-Api-Key',
  'Authorization',
  'mcp_servers.x.env.ACCESS_TOKEN',
  'password',
];
const NESTED_HARMLESS_KEYS = ['model', 'X-Request-Id', 'tokens', 'LOG_LEVEL'];
const NESTED_SEPARATORS = ['=', ':', ': ', ' = '];
/** What may stand between the parts of a compound word: nothing, a flag's separator, or a list's. */
const JOINS = ['', '=', ' ', ',', ';', '&', ':', '?', '  '];
/**
 * What stands right before a nested key, and right after its value: a key starts a run of name characters (a key
 * glued onto letters, `$TOKENapi_key`, is one name), and an unquoted value ends at a list's separator.
 */
const KEY_STARTS = ['=', ' ', ',', ';', '&', ':', '?', '  '];
const VALUE_ENDS = [',', ';', '&'];
// biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
const POINTERS = ['${secret:API_TOKEN}', '${secret:OTHER_TOKEN}'];
/**
 * What may stand before a nested key in the same word: any value, a pointer too (review r2 M1: a pointer in a value
 * hides nothing after it, `password=${secret:X}?password:v`).
 */
const HEAD_VALUES = [...VALUES, ...POINTERS];
/** One-letter flags a key may be stuck straight to (review r2 M2: `-eAPI_KEY=v`, `-HAuthorization: v`). */
const LETTER_FLAGS = ['-e', '-H', '-c', '-k', '-p'];
/** What sets a pointer apart from a value next to it, inside the same value: a space, or a URL's fragment mark. */
const POINTER_BREAKS = [' ', '#', '  '];
/** What ends a base64 value: no padding, one `=` or two (review r3 N1), or a `:` and more. */
const PADDINGS = ['', '=', '==', ':x', '=:'];

/** Whether the word before is a bare flag whose name says a credential, decided here from the text alone. */
const underSecretFlag = (before: string | undefined): boolean =>
  before !== undefined &&
  /^-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(before) &&
  /token|key|password|secret|auth/iu.test(before);

/** Secret-named flags a value may follow, as words (review r4 B1). */
const FLAG_NAMES = ['--token', '--TOKEN', '--api-key', '--x-api-key', '--password', '--client-secret', '-token'];

/**
 * Whether a value may stand after a pointer in the same value without being read as a key of its own: it holds no `:`
 * and no `=` but trailing padding. Decided here from the text alone.
 */
const afterPointerHides = (value: string): boolean => !/[:=]/u.test(value.replace(/=+$/u, ''));

// Harmless parts only: a compound word made of these holds no nested secret, so #40 must cut nothing of it.
const HARMLESS_FLAGS = ['--model', '--name', '--verbose', '--header', '-v', '-H', '-c', '-e'];
const HARMLESS_VALUES = [
  'not-a-real-secret-0000',
  'short',
  'claude-opus-5-5',
  '/home/person/task-runner-default',
  'a:b',
  '$API_TOKEN',
  ...POINTERS,
  'https://person@h.example.invalid/x?model=m',
  // A harmless key's value with padding, `user:pass` and a pointer after it: never cut (review r3 N1). No secret word
  // in it, or the `<value>=` before the padding is itself a secret-named key (`not-a-real-secret-0000=`).
  'harmless-value-0000==',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference is the literal text `${secret:NAME}`
  'Basic person:harmless-value-0000 ${secret:OTHER_TOKEN}',
];

/** A small, seeded, repeatable generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One generated command line: its words, and which of them were built of harmless parts only. */
interface CommandLine {
  readonly words: readonly string[];
  readonly harmless: readonly boolean[];
}

function commandLines(seed: number, count: number): readonly CommandLine[] {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const maybe = (text: () => string): string => (next() < 0.5 ? text() : '');
  /** A nested `KEY=v`: the marker only ever under a secret-named key, quoted or not, perhaps with a `,` in it. */
  const nested = (): string => {
    const named = next() < 0.6;
    const key = pick(named ? NESTED_SECRET_KEYS : NESTED_HARMLESS_KEYS);
    // A pointer may sit in the same value as the marker, set apart from it (review r2 M1): `v ${secret:X}`,
    // `v#${secret:X}`, `${secret:X} v`. Glued straight to it (`v${secret:X}`) the value is composed with the pointer,
    // and IS one, so it is never generated.
    // Or one that holds `=` or `:` itself (review r3 N1): base64 padding, `Basic` before it, `user:pass`.
    const padded = next() < 0.5;
    const marked = padded
      ? `${pick(['', 'Basic ', 'person:', 'person=', 'Basic person:', 'a='])}${NESTED_SECRET}${pick(PADDINGS)}`
      : pick([NESTED_SECRET, `Bearer ${NESTED_SECRET}`, `${NESTED_SECRET},${NESTED_SECRET}`, `a${NESTED_SECRET}`]);
    const value = named
      ? pick([
          marked,
          marked,
          `${marked}${pick(POINTER_BREAKS)}${pick(POINTERS)}`,
          `${marked}${pick(POINTER_BREAKS)}${pick(NESTED_HARMLESS_KEYS)}${pick(NESTED_SEPARATORS)}${pick(POINTERS)}`,
          // A pointer before a value with a `:` or a key-shaped `=` in it shows the value: the declared GAP G5b (a
          // `user:pass` there reads as `MODEL=gpt-4o-mini`), not generated. Padding alone, after a pointer, is B2.
          afterPointerHides(marked) ? `${pick(POINTERS)}${pick([' ', '  '])}${marked}` : marked,
        ])
      : pick(HEAD_VALUES);
    // A `,` inside a value is the value's only between a pair of quotes; unquoted it ends the value (a list).
    const quote = value.includes(',') ? pick(['"', "'"]) : pick(QUOTES);
    return `${key}${pick(NESTED_SEPARATORS)}${quote}${value}${quote}`;
  };
  /**
   * What follows a nested key, one or two parts: a plain value after a list separator; a second nested key after a
   * space or one; a pointer, alone or as a harmless key's value, between keys (review r2 M1, M3); a URL whose user's
   * password is the marker.
   */
  const tail = (): string =>
    Array.from({ length: 1 + Math.floor(next() * 2) }, () => {
      const roll = next();
      if (roll < 0.25) return `${pick(VALUE_ENDS)}${pick(VALUES)}`;
      if (roll < 0.55) return `${pick([...VALUE_ENDS, ' '])}${nested()}`;
      if (roll < 0.75) return `${pick([...VALUE_ENDS, ' '])}${pick(POINTERS)}`;
      if (roll < 0.92) return `${pick([...VALUE_ENDS, ' '])}${pick(NESTED_HARMLESS_KEYS)}=${pick(POINTERS)}`;
      return `${pick([...VALUE_ENDS, ' '])}https://person:${NESTED_SECRET}@h.example.invalid/x`;
    }).join('');
  /** A word of harmless parts only: a harmless flag, keys and values, glued or listed, pointers too. */
  const harmlessWord = (): string => {
    const part = (): string => `${pick(NESTED_HARMLESS_KEYS)}${pick(NESTED_SEPARATORS)}${pick(HARMLESS_VALUES)}`;
    const parts = Array.from({ length: 1 + Math.floor(next() * 3) }, part).join(pick([...VALUE_ENDS, ' ']));
    return `${maybe(() => `${pick(HARMLESS_FLAGS)}${pick(['=', ' ', ','])}`)}${parts}`;
  };
  const word = (): { text: string; harmless: boolean } => {
    const roll = next();
    const made = (text: string, harmless = false) => ({ text: text === '' ? 'x' : text, harmless });
    if (roll < 0.2) return made(pick(FLAGS));
    const quote = pick(QUOTES);
    const value = `${quote}${pick(VALUES)}${quote}`;
    if (roll < 0.36) return made(value);
    if (roll < 0.56) return made(`${pick(FLAGS)}${pick(SEPARATORS)}${value}`);
    if (roll < 0.76) {
      const head = `${maybe(() => pick(FLAGS))}${pick(JOINS)}${maybe(() => pick(HEAD_VALUES))}${pick(KEY_STARTS)}`;
      return made(`${head}${nested()}${maybe(tail)}`);
    }
    // A key stuck straight to a one-letter flag, and a second cut after it (review r2 M2).
    if (roll < 0.86) return made(`${pick(LETTER_FLAGS)}${nested()}${tail()}`);
    if (roll < 0.94) return made(harmlessWord(), true);
    return made(Array.from({ length: 1 + Math.floor(next() * 24) }, () => pick([...SOUP])).join(''));
  };
  /**
   * A flag and its value with a pointer on either side of it (review r4 B1): as two words or one glued by a space or
   * `=`. The marker only ever stands under a secret-named flag; a harmless flag gets a harmless value, shown as #37
   * showed it.
   */
  const flagPair = (): { text: string; harmless: boolean }[] => {
    const named = next() < 0.75;
    const base = named
      ? `${pick(['', 'Basic ', 'person:', 'Basic person:'])}${NESTED_SECRET}${pick(PADDINGS)}`
      : pick(HARMLESS_VALUES);
    const pointer = pick(POINTERS);
    const apart = pick(POINTER_BREAKS);
    const value = pick([
      `${base}${apart}${pointer}`,
      `short${apart}${base}${apart}${pointer}`,
      `${base}${apart}${pointer}${apart}short`,
      `${base}${apart}${pick(NESTED_HARMLESS_KEYS)}=${pointer}`,
      !named || afterPointerHides(base) ? `${pointer}${apart}${base}` : `${base}${apart}${pointer}`,
    ]);
    const flag = pick(named ? FLAG_NAMES : HARMLESS_FLAGS.filter(candidate => !/[=\s]/u.test(candidate)));
    const harmless = !named;
    return next() < 0.5
      ? [
          { text: flag, harmless: false },
          { text: value, harmless },
        ]
      : [{ text: `${flag}${pick([' ', '='])}${value}`, harmless }];
  };
  return Array.from({ length: count }, () => {
    const made = Array.from({ length: 1 + Math.floor(next() * 6) }, () =>
      next() < 0.1 ? flagPair() : [word()],
    ).flat();
    return { words: made.map(item => item.text), harmless: made.map(item => item.harmless) };
  });
}

const SEED = Number(process.env.FLAG_FUZZ_SEED ?? 0x5eed);
const CASES = Number(process.env.FLAG_FUZZ_CASES ?? 20_000);

describe('resolvedEntries — today differential for command lines (ruling #37)', () => {
  it('should mark only the tightened shapes, from the words alone', () => {
    // Assert — members.
    should(tightened('--token=x', undefined)).be.true();
    should(tightened('--token x', undefined)).be.true();
    should(tightened('-Hsk-abcdefgh', undefined)).be.true();
    should(tightened('value', '--token')).be.true();
    should(tightened("'sk-abcdefgh'", undefined)).be.true();
    should(tightened('key:value', undefined)).be.true();
    // Assert — not members.
    should(tightened('Bearer', undefined)).be.false();
    should(tightened('--token', '--auth')).be.false();
    should(tightened('sk-abcdefghij', undefined)).be.false();
    should(tightened('value', 'token')).be.false();
    should(tightened('value', '--token=x')).be.false();
    should(tightened('-Hshort', undefined)).be.false();
    should(tightened('--verbose', undefined)).be.false();
  });

  it('should judge the oracle itself: a kept word, a cut that only ends a word, and a cut that shows more', () => {
    // Assert
    should(hidesAtLeast('--token=abc', { value: '--token=abc' }, { value: '--token=abc' })).be.true();
    should(
      hidesAtLeast('--token=abc', { value: '--token=abc' }, { value: `--token=${HIDDEN}`, hidden: true }),
    ).be.true();
    should(hidesAtLeast('sk-abcdefgh', { value: HIDDEN, hidden: true }, { value: HIDDEN, hidden: true })).be.true();
    should(hidesAtLeast('sk-abcdefgh', { value: HIDDEN, hidden: true }, { value: 'sk-abcdefgh' })).be.false();
    should(hidesAtLeast('--token=abc', { value: '--token=abc' }, { value: '--token=abd' })).be.false();
    should(
      hidesAtLeast('--token=abc', { value: '--token=abc' }, { value: `--tokex=${HIDDEN}`, hidden: true }),
    ).be.false();
    should(hidesAtLeast('abc', { value: 'abc' }, { value: `abc${HIDDEN}`, hidden: true })).be.false();
    should(hidesAtLeast('abc', { value: 'abc' }, { value: 'abc-', hidden: true })).be.false();
    should(lineHidesAtLeast('a --token=abc b', `a --token=${HIDDEN} b`)).be.true();
    should(lineHidesAtLeast(`a ${HIDDEN} b`, `a ${HIDDEN} b`)).be.true();
    should(lineHidesAtLeast(`a ${HIDDEN} b`, 'a sk-abc b')).be.false();
    should(lineHidesAtLeast('a b', `x ${HIDDEN}`)).be.false();
    should(lineHidesAtLeast('a b', `a ${HIDDEN} c`)).be.false();
    should(lineHidesAtLeast('a b', `a b${HIDDEN}`)).be.false();
    should(lineHidesAtLeast('a xy b', `a ${HIDDEN} ${HIDDEN} b`)).be.false();
  });

  it('should judge the #37 floor itself, on the review r1 F2 shapes: -H<token> KEY=v and -H<token>=KEY=v stay -H‹hidden›', () => {
    // Arrange
    const token = 'sk-not-a-real-key-0000';
    const words = [`-H${token} API_KEY=${NESTED_SECRET}`, `-H${token}=API_KEY=${NESTED_SECRET}`];
    const ruled = flags37(words);

    // Assert — #37 hid both whole after -H.
    should(ruled).deepEqual([
      { value: `-H${HIDDEN}`, hidden: true },
      { value: `-H${HIDDEN}`, hidden: true },
    ]);
    // Assert — the oracle: as hidden, or a deeper cut, passes; r1's output (the token shown) and a shown word fail.
    should(hidesAtLeast37(ruled[0] as Shown, { value: `-H${HIDDEN}`, hidden: true })).be.true();
    should(
      hidesAtLeast37({ value: `--set=a,b=${HIDDEN}`, hidden: true }, { value: `--set=${HIDDEN}`, hidden: true }),
    ).be.true();
    should(hidesAtLeast37({ value: 'a,api_key=v' }, { value: `a,api_key=${HIDDEN}`, hidden: true })).be.true();
    should(hidesAtLeast37(ruled[0] as Shown, { value: `-H${token} API_KEY=${HIDDEN}`, hidden: true })).be.false();
    should(hidesAtLeast37(ruled[1] as Shown, { value: words[1] as string })).be.false();
    should(hidesAtLeast37({ value: 'abc' }, { value: 'abd' })).be.false();
    should(serverLine37('run', words)).equal(`run -H${HIDDEN} -H${HIDDEN}`);
    // Assert — the shapes as 5.0 shows them.
    should(shownFlags(words).every((shown, index) => hidesAtLeast37(ruled[index] as Shown, shown))).be.true();
  });

  it(`should hide every launch-flag byte today hides, and equal today off the tightened shapes (${String(CASES)} command lines)`, () => {
    // Arrange
    const lines = commandLines(SEED, CASES);
    const breaches: string[] = [];
    let members = 0;
    let differed = 0;
    let nestedMembers = 0;
    let harmlessMembers = 0;
    let asWritten = 0;

    // Act
    for (const { words, harmless } of lines) {
      const five = shownFlags(words);
      const ruled37 = flags37(words);
      const ruledR2 = shownWordsR2(words);
      const ruledR3 = shownWordsR3(words);
      const ruledR4 = shownWordsR4(words);
      for (const [index, word] of words.entries()) {
        const today = todayFlag(word);
        const shown = five[index] ?? { value: '' };
        const r2 = ruledR2[index];
        const r3 = ruledR3[index];
        const r4 = ruledR4[index];
        if (
          r4 !== undefined &&
          !hidesAtLeast37(r4.hidden ? { value: r4.text, hidden: true } : { value: r4.text }, shown)
        )
          breaches.push(`${JSON.stringify(words)} @${String(index)} (r4)`);
        if (!hidesAtLeast37(ruled37[index] ?? { value: '' }, shown))
          breaches.push(`${JSON.stringify(words)} @${String(index)} (#37)`);
        if (
          r2 !== undefined &&
          !hidesAtLeast37(r2.hidden ? { value: r2.text, hidden: true } : { value: r2.text }, shown)
        )
          breaches.push(`${JSON.stringify(words)} @${String(index)} (r2)`);
        if (
          r3 !== undefined &&
          !hidesAtLeast37(r3.hidden ? { value: r3.text, hidden: true } : { value: r3.text }, shown)
        )
          breaches.push(`${JSON.stringify(words)} @${String(index)} (r3)`);
        if (shown.value.includes(NESTED_SECRET)) breaches.push(`${JSON.stringify(words)} @${String(index)} (nested)`);
        if (word.includes(NESTED_SECRET)) nestedMembers += 1;
        if (harmless[index] === true) {
          harmlessMembers += 1;
          const ruled = ruled37[index] ?? { value: '' };
          // Under a secret-named flag a value with a pointer in it is the flag's own (review r4 B1): its parts may be
          // cut, as `--token=<value> ${secret:X}` always was. The floors above still hold it to #37, r2 and r3.
          if (!underSecretFlag(words[index - 1]) && (shown.value !== ruled.value || shown.hidden !== ruled.hidden))
            breaches.push(`${JSON.stringify(words)} @${String(index)} (harmless)`);
          if (ruled.hidden === undefined && shown.value === word) asWritten += 1;
        }
        if (!tightened(word, words[index - 1])) {
          if (shown.value !== today.value || shown.hidden !== today.hidden)
            breaches.push(`${JSON.stringify(words)} @${String(index)}`);
          continue;
        }
        members += 1;
        if (shown.value !== today.value) differed += 1;
        if (!hidesAtLeast(word, today, shown)) breaches.push(`${JSON.stringify(words)} @${String(index)} (tightened)`);
      }
    }

    // Assert
    should(breaches.slice(0, 10)).deepEqual([]);
    should(members).be.above(0);
    should(differed).be.above(0);
    should(nestedMembers).be.above(CASES / 10);
    should(harmlessMembers).be.above(CASES / 20);
    should(asWritten).be.above(harmlessMembers / 2);
  }, 120_000);

  it(`should hide every MCP-argument byte today hides, and equal today off the tightened shapes (${String(CASES)} command lines)`, () => {
    // Arrange
    const lines = commandLines(SEED + 1, CASES);
    const breaches: string[] = [];
    let differed = 0;
    let harmlessLines = 0;

    // Act
    for (const { words, harmless } of lines) {
      const five = shownServer(words);
      const today = todayServerLine({ command: COMMAND, args: words });
      const r2 = shownWordsR2([COMMAND, ...words])
        .map(word => word.text)
        .join(' ');
      const r3 = shownWordsR3([COMMAND, ...words])
        .map(word => word.text)
        .join(' ');
      const r4 = shownWordsR4([COMMAND, ...words])
        .map(word => word.text)
        .join(' ');
      const anyTightened = words.some((word, index) => tightened(word, index === 0 ? COMMAND : words[index - 1]));
      if (five !== today) differed += 1;
      if (anyTightened ? !lineHidesAtLeast(today, five) : five !== today) breaches.push(JSON.stringify(words));
      if (!lineHidesAtLeast(serverLine37(COMMAND, words), five)) breaches.push(`${JSON.stringify(words)} (#37)`);
      if (!lineHidesAtLeast(r2, five)) breaches.push(`${JSON.stringify(words)} (r2)`);
      if (!lineHidesAtLeast(r3, five)) breaches.push(`${JSON.stringify(words)} (r3)`);
      if (!lineHidesAtLeast(r4, five)) breaches.push(`${JSON.stringify(words)} (r4)`);
      if (five.includes(NESTED_SECRET)) breaches.push(`${JSON.stringify(words)} (nested)`);
      if (harmless.every(Boolean)) harmlessLines += 1;
      if (harmless.every(Boolean) && five !== serverLine37(COMMAND, words))
        breaches.push(`${JSON.stringify(words)} (harmless)`);
    }

    // Assert
    should(breaches.slice(0, 10)).deepEqual([]);
    should(differed).be.above(0);
    should(harmlessLines).be.above(0);
  }, 120_000);
});
