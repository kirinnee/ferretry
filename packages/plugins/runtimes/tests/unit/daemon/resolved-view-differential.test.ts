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
 * Every secret value here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { type ResolvedProfile, type ResolveInput, resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';
import { todayFlag, todayServerLine } from './resolved-view-today.ts';
import { HIDDEN, hidesAtLeast, lineHidesAtLeast, type Shown } from './command-line-family.ts';

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
  const word = (): string => {
    const roll = next();
    if (roll < 0.3) return pick(FLAGS);
    const quote = pick(QUOTES);
    const value = `${quote}${pick(VALUES)}${quote}`;
    if (roll < 0.6) return value;
    if (roll < 0.9) return `${pick(FLAGS)}${pick(SEPARATORS)}${value}`;
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

  it(`should hide every launch-flag byte today hides, and equal today off the tightened shapes (${String(CASES)} command lines)`, () => {
    // Arrange
    const lines = commandLines(SEED, CASES);
    const breaches: string[] = [];
    let members = 0;
    let differed = 0;

    // Act
    for (const words of lines) {
      const five = shownFlags(words);
      for (const [index, word] of words.entries()) {
        const today = todayFlag(word);
        const shown = five[index] ?? { value: '' };
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
    }

    // Assert
    should(breaches.slice(0, 10)).deepEqual([]);
    should(differed).be.above(0);
  });
});
