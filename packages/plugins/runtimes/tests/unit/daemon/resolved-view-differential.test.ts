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
/**
 * What may stand before a nested key in the same word, or in a value after one with no list separator between: any
 * value but a pointer. GAP candidates (review r2), both from `looksSecret`'s rule that a value with a pointer anywhere
 * in it holds none: a key glued into the value of a secret-named key that is a pointer is passed over with it
 * (`password=${secret:X}?password:v`; reading into it would make the scan quadratic), and a pointer after a secret in
 * the same value makes the whole value a pointer (`Authorization: v LOG_LEVEL=${secret:X}`).
 */
const HEAD_VALUES = VALUES.filter(value => !value.startsWith('$'));

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

function commandLines(seed: number, count: number): readonly (readonly string[])[] {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const maybe = (text: () => string): string => (next() < 0.5 ? text() : '');
  /** A nested `KEY=v`: the marker only ever under a secret-named key, quoted or not, perhaps with a `,` in it. */
  const nested = (): string => {
    const named = next() < 0.6;
    const key = pick(named ? NESTED_SECRET_KEYS : NESTED_HARMLESS_KEYS);
    const value = named
      ? pick([NESTED_SECRET, `Bearer ${NESTED_SECRET}`, `${NESTED_SECRET},${NESTED_SECRET}`, `a${NESTED_SECRET}`])
      : pick(HEAD_VALUES);
    // A `,` inside a value is the value's only between a pair of quotes; unquoted it ends the value (a list).
    const quote = value.includes(',') ? pick(['"', "'"]) : pick(QUOTES);
    return `${key}${pick(NESTED_SEPARATORS)}${quote}${value}${quote}`;
  };
  const word = (): string => {
    const roll = next();
    if (roll < 0.25) return pick(FLAGS);
    const quote = pick(QUOTES);
    const value = `${quote}${pick(VALUES)}${quote}`;
    if (roll < 0.45) return value;
    if (roll < 0.7) return `${pick(FLAGS)}${pick(SEPARATORS)}${value}`;
    if (roll < 0.92) {
      const head = `${maybe(() => pick(FLAGS))}${pick(JOINS)}${maybe(() => pick(HEAD_VALUES))}${pick(KEY_STARTS)}`;
      // Then perhaps more: a plain value after a list separator, or a second nested key after a space or one — with no
      // pointer in it, since a pointer anywhere after a key makes its whole value a pointer (GAP candidate, above).
      const tail = maybe(() =>
        next() < 0.5 ? `${pick(VALUE_ENDS)}${pick(VALUES)}` : `${pick([...VALUE_ENDS, ' '])}${nested()}`,
      );
      return `${head}${nested()}${tail}`;
    }
    return Array.from({ length: 1 + Math.floor(next() * 24) }, () => pick([...SOUP])).join('');
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(next() * 6) }, word).map(text => (text === '' ? 'x' : text)),
  );
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

    // Act
    for (const words of lines) {
      const five = shownFlags(words);
      const ruled37 = flags37(words);
      for (const [index, word] of words.entries()) {
        const today = todayFlag(word);
        const shown = five[index] ?? { value: '' };
        if (!hidesAtLeast37(ruled37[index] ?? { value: '' }, shown))
          breaches.push(`${JSON.stringify(words)} @${String(index)} (#37)`);
        if (shown.value.includes(NESTED_SECRET)) breaches.push(`${JSON.stringify(words)} @${String(index)} (nested)`);
        if (word.includes(NESTED_SECRET)) nestedMembers += 1;
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
  });

  it(`should hide every MCP-argument byte today hides, and equal today off the tightened shapes (${String(CASES)} command lines)`, () => {
    // Arrange
    const lines = commandLines(SEED + 1, CASES);
    const breaches: string[] = [];
    let differed = 0;

    // Act
    for (const words of lines) {
      const five = shownServer(words);
      const today = todayServerLine({ command: COMMAND, args: words });
      const anyTightened = words.some((word, index) => tightened(word, index === 0 ? COMMAND : words[index - 1]));
      if (five !== today) differed += 1;
      if (anyTightened ? !lineHidesAtLeast(today, five) : five !== today) breaches.push(JSON.stringify(words));
      if (!lineHidesAtLeast(serverLine37(COMMAND, words), five)) breaches.push(`${JSON.stringify(words)} (#37)`);
      if (five.includes(NESTED_SECRET)) breaches.push(`${JSON.stringify(words)} (nested)`);
    }

    // Assert
    should(breaches.slice(0, 10)).deepEqual([]);
    should(differed).be.above(0);
  });
});
