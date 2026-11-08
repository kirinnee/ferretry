/**
 * S26: generate text from the alphabet past reviews found leaks in, and hold what the edit screen is given for a
 * component's text (the components read, the one door that text leaves by) to today's `redactText`, frozen in
 * `redact-today.ts`.
 *
 * THE ORACLE IS A SUPERSET, not equality, and only on the lines of one family of blocks (ruling #36): today leaks a
 * block under a name that announces a secret when its indicator is not on the name's own line, or carries a comment
 * (`PASSWORD⏎= |⏎  value`, `password:⏎  |⏎    value`, `PASSWORD⏎=⏎|⏎  value`, `password: | # note⏎  value`
 * all show `value`), and 5.0 hides it. So on the lines of such a block — from the line after its name (the name's own
 * line is never the block's) to the last line before the first one that stands no deeper than the name, computed
 * here from the text alone ({@link tightenedLines}), never from the code under test — 5.0 must hide at least every
 * byte today hides (it may hide more). On every other line,
 * and in every text without such a block, its output must equal today's exactly. Nothing is carved out: every
 * generated text is checked. Today's own S26 held today to hide at least what the older rule of main hid, so 5.0
 * hiding at least what today hides keeps that floor too.
 *
 * The family has a second dimension (#36, amendment 3): YAML node properties — a tag (`!vault`, `!!str`) and an
 * anchor (`&a`), one or both — standing where a value or a block indicator would (`password: !vault |⏎  value`,
 * `password: !!str value`, `password: &a⏎  value`). Today reads the properties as the value and shows what follows
 * them; 5.0 hides it. Those lines are tightened too ({@link tightenedLines}).
 *
 * And a third (#36, r5): a comment between such a name and its value (`password: # note⏎  value`,
 * `password:⏎  # note⏎  value`, `password: &a # note⏎  value`, `password: # note⏎  |⏎    value`). YAML reads the value
 * past the comment; today shows it, and 5.0 hides it. The lines read past the comment are tightened too.
 *
 * A private key's cut can take line breaks with it, so no generated text here holds one, and keys are held to the
 * floor on the whole text instead, over every shape of `redact-private-keys.ts` (#36, r5: escaped breaks, a body
 * line that starts the way a token does).
 *
 * Every secret value here is an obviously fake one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { looksSecret } from '../../../daemon/lib/account/import.ts';
import { redactTodayText } from './redact-today.ts';
import { privateKeyShapes } from './redact-private-keys.ts';

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
/** Indicators, with and without a comment; the last is a value today hides the first word of, its comment a pointer. */
const BLOCKS = [
  '',
  '',
  '',
  '',
  '|',
  '>-',
  '|+',
  '>2',
  '| # note',
  '>- #c',
  '>-1234567 # ${secret:API_KEY}',
  // A block opened inside another on its opener's line: an outer block must not swallow it when it runs past.
  '| # token: |',
];
/** YAML node properties before an indicator or a value (#36, amendment 3): tags, anchors, both in either order. */
const NODE_PROPERTIES = ['', '', '', '', '', '!!str ', '&a ', '!vault ', '!!binary ', '&a !!str ', '!!str &a ', '!\t'];
/**
 * A comment between a name and its value (#36, r5): after the separator or node properties, on lines of its own, both,
 * with blank lines, CRLF and tabs, glued to what stands before it (no comment), and a name inside one.
 */
const NOTES = [
  '',
  '',
  '',
  '',
  '',
  '',
  ' # note\n',
  ' # note\n  ',
  '\t#note\r\n\t',
  '\n# note\n',
  '\n  # note\n\n\t# more\r\n  ',
  ' # a\n  # b\n',
  '#glued\n',
  ' # see token:\n',
  '\n# password: # c\n',
];
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
  '!!str',
  '&a',
  '!vault',
  '!',
  ' # c',
  '\n# c\n',
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
    const separator = `${pick(GAPS)}${pick(MARKS)}${pick(GAPS)}${pick(NODE_PROPERTIES)}${pick(BLOCKS)}${pick(NOTES)}${pick(GAPS)}`;
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

const BREAK = /\r\n|\r|\n/u;
const KEPT_BREAK = /(\r\n|\r|\n)/u;
/** An indicator, with or without a comment after it: `|`, `>-`, `| # note`. */
const INDICATOR = '[|>][-+0-9]*(?:[ \\t]+#.*)?';
/** A line that ends in a name and its separator, the indicator of a block after them when there is one. */
const ENDS_IN_SEPARATOR = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*[:=][ \t]*([|>][-+0-9]*)?[ \t]*$/u;
const ENDS_IN_NAME = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*$/u;
const ENDS_IN_COMMENTED_BLOCK =
  /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*[:=][ \t]*[|>][-+0-9]*[ \t]+#.*$/u;
const SEPARATOR_ONLY = /^[ \t]*[:=][ \t]*$/u;
const SEPARATOR_AT_HEAD = /^[ \t]*[:=][ \t]*/u;
const SEPARATOR_AND_INDICATOR = new RegExp(`^[ \\t]*[:=][ \\t]*${INDICATOR}[ \\t]*$`, 'u');
const INDICATOR_ONLY = new RegExp(`^[ \\t]*${INDICATOR}[ \\t]*$`, 'u');
const announcesSecret = (name: string): boolean => looksSecret(name.replace(/^[0-9.-]+/u, ''), 'x'.repeat(8));
/** One YAML node property: a tag (`!`, `!!str`, `!vault`) or an anchor with a name (`&a`), with no space in it. */
const PROPERTY = '(?:!|&(?=\\S))\\S{0,128}';
const PROPERTIES = `${PROPERTY}(?:[ \\t]+${PROPERTY})?`;
/** A name, its separator and a node property after it, on one line (`password: !!str value`, `"auth": &a value`). */
const NAMED_PROPERTY = new RegExp(
  `(?<![A-Za-z0-9_.-])[0-9.-]*([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \\t]*[:=][ \\t]*["']?(?=${PROPERTY}[ \\t])`,
  'gu',
);
/** A line that ends in a name, its separator and node properties, an indicator after them or not, a comment or not. */
const ENDS_IN_PROPERTIES = new RegExp(
  `(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \\t]*[:=][ \\t]*(${PROPERTIES}(?:[ \\t]+[|>][-+0-9]*)?(?:[ \\t]+#.*)?)[ \\t]*$`,
  'u',
);
/** A line that is a comment and nothing else. */
const COMMENT_ONLY = /^[ \t]*#/u;
/** A line that ends in a name, its separator and a comment after a space or a tab (`password: # note`). */
const ENDS_IN_COMMENT = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*[:=][ \t]+#.*$/u;
/** A separator at the head of a line and a comment after a space or a tab (`= # note`). */
const SEPARATOR_AND_COMMENT = /^[ \t]*[:=][ \t]+#/u;
const STARTS_WITH_PROPERTIES = new RegExp(`^[ \\t]*${PROPERTIES}(?:[ \\t]+|$)`, 'u');

/**
 * Which lines of `text` (split at its line breaks) stand in a block of the tightened family (#36), read from the text
 * alone: a name that announces a secret and then, with only blank lines between,
 * - `NAME⏎= |` — a separator and an indicator on the line after a line that ends in the name;
 * - `NAME⏎=⏎|` — a separator alone on that line, and an indicator alone on the next;
 * - `name:⏎|` — a line that ends in the name and its separator, and an indicator alone on the next;
 * - `name: | # note` — an indicator with a comment on the name's own line, whatever the comment's last word is read
 *   as besides (`name: | # see note:`, `name: | # token⏎= x`);
 * - node properties before the indicator on any of those lines (`name: !vault |`, `NAME⏎= &a |`, `name:⏎!!str |`),
 *   or ending a line with the indicator on the next (`name: &a⏎|`);
 * and each block runs from the line after the name's — the name's line is never the block's, so it must equal today's
 * — to the last line before the first one, after the indicator's, that stands no deeper than the name. A same-line
 * block with no comment and no properties (`password: |`) is no member: today already reads it.
 *
 * And which lines hold a VALUE after node properties under such a name (amendment 3): the name's own line when a
 * property follows its separator (`password: !!str value`), the line a value is read on when it starts with
 * properties (`password:⏎!!str value`, `NAME⏎= &a value`), and the line after one that properties end
 * (`password: &a⏎value`, `NAME⏎= !!str⏎value`).
 *
 * And (r5) past a comment between such a name and its value — after its separator (`password: # note`, `NAME⏎= # note`),
 * after node properties (`password: &a # note`), or on lines of their own (`password:⏎# note`, `NAME⏎=⏎# note`) — the
 * first line after it that is neither blank nor a comment: the block opened there (from the name line + 1, as above),
 * the value after node properties there, or the value there (that line alone). From a line that is a comment itself,
 * nothing is read past comments (a name in it is no key), and a line that properties end looks only past blank lines
 * from there.
 *
 * One width by design: a line holding `secret: !x ` anywhere is tightened whole (`NAMED_PROPERTY`), so on that line
 * any extra hiding passes here, and its exactness rests on the generated families of `catalog-redaction.test.ts`.
 */
function tightenedLines(text: string): ReadonlySet<number> {
  const lines = text.split(BREAK);
  const after = (at: number): number => {
    let next = at + 1;
    while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1;
    return next;
  };
  /** The first line after `at` that is neither blank nor a comment. */
  const pastComments = (at: number): number => {
    let next = after(at);
    while (next < lines.length && COMMENT_ONLY.test(lines[next] ?? '')) next = after(next);
    return next;
  };
  const tightened = new Set<number>();
  /** Blocks of the family named on the line at `at`, each at the line its indicator stands on. */
  const indicatorLines = (at: number): number[] => {
    const line = lines[at] ?? '';
    const found: number[] = [];
    const inComment = COMMENT_ONLY.test(line);
    /** The line a value is read on after line `on`: a block opens there, or that line is tightened. */
    const below = (on: number): void => {
      const to = inComment ? after(on) : pastComments(on);
      if (INDICATOR_ONLY.test(lines[to] ?? '')) found.push(to);
      else tightened.add(to);
    };
    /** What node properties at the head of `content`, standing on line `on`, lead to. */
    const properties = (on: number, content: string): void => {
      const head = STARTS_WITH_PROPERTIES.exec(content);
      if (head === null) return;
      const rest = content.slice(head[0].length);
      if (INDICATOR_ONLY.test(rest)) found.push(on);
      else if (rest.trim() !== '' && !rest.trimStart().startsWith('#')) tightened.add(on);
      else below(on);
    };
    /** What is read past a comment that ends line `on` (r5). */
    const pastComment = (on: number): void => {
      if (inComment) return;
      properties(pastComments(on), lines[pastComments(on)] ?? '');
      below(on);
    };
    const noted = ENDS_IN_COMMENT.exec(line)?.[1];
    if (noted !== undefined && noted.replace(/^[0-9.-]+/u, '') !== '' && announcesSecret(noted)) pastComment(at);
    const commented = ENDS_IN_COMMENTED_BLOCK.exec(line)?.[1];
    if (commented !== undefined && announcesSecret(commented)) found.push(at);
    const tagged = ENDS_IN_PROPERTIES.exec(line);
    if (tagged?.[1] !== undefined && tagged[1].replace(/^[0-9.-]+/u, '') !== '' && announcesSecret(tagged[1])) {
      properties(at, tagged[2] ?? '');
    }
    const separator = ENDS_IN_SEPARATOR.exec(line);
    const next = after(at);
    if (separator?.[1] !== undefined && separator[1].replace(/^[0-9.-]+/u, '') !== '') {
      if (separator[2] === undefined && announcesSecret(separator[1])) {
        if (INDICATOR_ONLY.test(lines[next] ?? '')) found.push(next);
        properties(next, lines[next] ?? '');
        if (COMMENT_ONLY.test(lines[next] ?? '')) pastComment(next);
      }
      return found;
    }
    const name = ENDS_IN_NAME.exec(line)?.[1];
    if (name === undefined || name.replace(/^[0-9.-]+/u, '') === '' || !announcesSecret(name)) return found;
    const separated = SEPARATOR_AT_HEAD.exec(lines[next] ?? '');
    if (SEPARATOR_AND_INDICATOR.test(lines[next] ?? '')) found.push(next);
    else if (SEPARATOR_ONLY.test(lines[next] ?? '')) {
      if (INDICATOR_ONLY.test(lines[after(next)] ?? '')) found.push(after(next));
      properties(after(next), lines[after(next)] ?? '');
      if (COMMENT_ONLY.test(lines[after(next)] ?? '')) pastComment(after(next));
    } else if (separated !== null) {
      properties(next, (lines[next] ?? '').slice(separated[0].length));
      if (SEPARATOR_AND_COMMENT.test(lines[next] ?? '')) pastComment(next);
    }
    return found;
  };
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    for (const named of line.matchAll(NAMED_PROPERTY)) {
      if (announcesSecret(named[1] ?? '')) tightened.add(at);
    }
    const indent = line.length - line.trimStart().length;
    for (const opens of indicatorLines(at)) {
      let end = opens;
      for (let next = opens + 1; next < lines.length; next += 1) {
        const line = lines[next] ?? '';
        if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
        end = next;
      }
      for (let line = at + 1; line <= end; line += 1) tightened.add(line);
    }
  }
  return tightened;
}

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

/**
 * Why 5.0's output for `text` breaks the oracle, or undefined when it holds: line by line (nothing generated holds a
 * private-key header, the one cut that can take a line break with it, so the breaks of the two outputs line up), equal
 * to today's off the tightened lines and hiding at least what today hides on them, and redacted exactly when today is
 * or a tightened line differs.
 */
function breach(text: string): string | undefined {
  const today = redactTodayText(text);
  const shown = shownFor(text);
  if (shown.text === today.text && shown.redacted === today.redacted) return undefined;
  const tightened = tightenedLines(text);
  const todays = today.text.split(KEPT_BREAK);
  const shownParts = shown.text.split(KEPT_BREAK);
  if (todays.length !== shownParts.length) return 'breaks its lines apart from today';
  let differs = false;
  for (let part = 0; part < todays.length; part += 1) {
    const was = todays[part] ?? '';
    const is = shownParts[part] ?? '';
    if (was === is) continue;
    if (part % 2 === 1 || !tightened.has(part / 2)) return 'differs from today outside the tightened lines';
    if (!hidesAtLeast(was, is)) return 'shows what today hides';
    differs = true;
  }
  return shown.redacted === (today.redacted || differs)
    ? undefined
    : 'says it hid something when it hid what today did';
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

/**
 * The first few texts of `cases` that break the oracle, each cut down; how many held a tightened line, and how many
 * of those 5.0 shows differently from today (so the superset branch was taken, not only reached).
 */
function breaches(shape: (next: () => number) => string, seed: number, cases: number) {
  const next = seeded(seed);
  const failures: string[] = [];
  let tightened = 0;
  let differed = 0;
  for (let count = 0; count < cases && failures.length < 5; count += 1) {
    const text = shape(next);
    if (tightenedLines(text).size > 0) {
      tightened += 1;
      if (shownFor(text).text !== redactTodayText(text).text) differed += 1;
    }
    const why = breach(text);
    if (why !== undefined) failures.push(`${why}: ${JSON.stringify(minimal(text, why))}`);
  }
  return { failures, tightened, differed };
}

// A review can re-run either with another seed and a larger count: `REDACT_FUZZ_SEED=7 REDACT_FUZZ_CASES=100000`.
const SEED = Number(process.env.REDACT_FUZZ_SEED ?? 0x5eed);
const CASES = Number(process.env.REDACT_FUZZ_CASES ?? 20_000);
// A run takes a few seconds per 20,000 texts, past bun's 5 s per-test default at a larger count: each run is given
// a minute per 20,000, so a review at `REDACT_FUZZ_CASES=100000` never reads a timeout as a breach.
const FUZZ_TIMEOUT = Math.max(60_000, Math.ceil(CASES / 20_000) * 60_000);

describe('component text redaction never hides less than today', () => {
  it(
    'S26 should hide every byte today hides, and equal today off the tightened lines, over structured texts',
    () => {
      // Act
      const result = breaches(generate, SEED, CASES);

      // Assert
      should(result.failures).deepEqual([]);
      should(result.tightened).be.above(0);
      should(result.differed).be.above(0);
    },
    FUZZ_TIMEOUT,
  );

  it(
    'S26 should hide every byte today hides, and equal today off the tightened lines, over unstructured texts',
    () => {
      // Assert
      should(breaches(soup, SEED ^ 0x50f7, CASES).failures).deepEqual([]);
    },
    FUZZ_TIMEOUT,
  );

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

  it('S26 should mark only the lines of a tightened block, from the line after its name to the last line deeper than it', () => {
    // Assert
    should([...tightenedLines('a: 1\nPASSWORD\n= |\n  v\n\n  w\nnext: x\n  y')]).deepEqual([2, 3, 4, 5]);
    should([...tightenedLines('token:\r\n  | # c\r\n    v\r\ntail')]).deepEqual([1, 2]);
    should([...tightenedLines('PASSWORD\n=\n|\n  v')]).deepEqual([1, 2, 3]);
    should([...tightenedLines('secret: >- # c\n\tv\nend')]).deepEqual([1]);
    should([...tightenedLines('PASSWORD\n= |')]).deepEqual([1]);
    // A comment whose last word is a name and its separator: the commented block is a member all the same.
    should([...tightenedLines('password: | # see note:\n  v\nend')]).deepEqual([1]);
    // Inside an outer block, its indicator shallower than its name: the inner block is a member of its own.
    should([...tightenedLines('password: |\n  PASSWORD\n= |\n    v\nend')]).deepEqual([2, 3]);
    // No member: a same-line block today reads, a name that announces no secret, a separator with a value, a
    // commented block that a separator line at its name's indent ends at once, and no indicator at all.
    should(tightenedLines('password: |\n  v').size).equal(0);
    should(tightenedLines('mode\n= |\n  v').size).equal(0);
    should(tightenedLines('PASSWORD\n= x\n  v').size).equal(0);
    should(tightenedLines('PASSWORD:\n  x\n  v').size).equal(0);
    should(tightenedLines('password: | # note\n= x').size).equal(0);
    should(tightenedLines('9:\n|\n  v').size).equal(0);
    should(tightenedLines('PASSWORD\n=\nx').size).equal(0);
  });

  it('S26 should mark the line read past a comment between a name and its value, and a block opened there', () => {
    // Assert: a value line alone, and a block from the name line + 1.
    should([...tightenedLines('password: # c\n  # d\n\n  v\nend')]).deepEqual([3]);
    should([...tightenedLines('password:\n  # c\n  v')]).deepEqual([2]);
    should([...tightenedLines('password: &a # c\n  v')]).deepEqual([0, 1]);
    should([...tightenedLines('PASSWORD\n= # c\n  v')]).deepEqual([2]);
    should([...tightenedLines('PASSWORD\n=\n# c\nv')]).deepEqual([3]);
    should([...tightenedLines('password: # c\n  &a v')]).deepEqual([1]);
    should([...tightenedLines('password: # c\n  |\n    v\nend')]).deepEqual([1, 2]);
    // No member: a name that announces no secret, a name inside a comment line, a # glued to its separator.
    should(tightenedLines('mode: # c\n  v').size).equal(0);
    should(tightenedLines('# password: # c\n  v').size).equal(0);
    should(tightenedLines('password:# c\n  v').size).equal(0);
    should(tightenedLines('PASSWORD\n=# c\n  v').size).equal(0);
  });

  it(`S26 should hide every byte today hides of every private key shape (${privateKeyShapes().length} shapes)`, () => {
    // Act
    const breaches = privateKeyShapes().flatMap(({ shape, text }) => {
      const today = redactTodayText(text);
      const shown = shownFor(text);
      return hidesAtLeast(today.text, shown.text) && (shown.redacted || !today.redacted)
        ? []
        : [`${shape}: ${JSON.stringify(today.text)} -> ${JSON.stringify(shown.text)}`];
    });

    // Assert
    should(breaches).deepEqual([]);
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
