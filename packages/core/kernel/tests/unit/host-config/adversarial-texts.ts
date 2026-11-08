/**
 * Hostile configuration texts, each as large as a configuration file may be: the shapes every review round found a slow
 * path with, and the ones next to them. A test runs every door (boot, reload, `config_validate`, `config_write`) over
 * all of them with one hard time bound, so the next slow shape is found by a test rather than by a review.
 *
 * Fake only: the "key-shaped" texts are assembled from a prefix and a filler at run time, never a real credential.
 */

/** A word only these texts hold, so a message that repeated any of them would be caught. */
export const PRIVATE_WORD = 'zebraquartzprivate';

/** `unit` repeated to fill `cap` bytes after `head` and before `tail` (every text here is ASCII: a byte per character). */
function fill(cap: number, unit: string, head = '', tail = ''): string {
  const room = cap - head.length - tail.length;
  return head + unit.repeat(Math.max(0, Math.floor(room / unit.length))) + tail;
}

/** Lines from `line(index)` until `cap` bytes would be passed. */
function lines(cap: number, line: (index: number) => string, head = ''): string {
  const parts = [head];
  let size = head.length;
  for (let index = 0; ; index += 1) {
    const next = line(index);
    if (size + next.length > cap) break;
    parts.push(next);
    size += next.length;
  }
  return parts.join('');
}

/** A random-looking string of `length` characters, built so no shape repeats within it. */
function noise(length: number): string {
  const alphabet = 'q7Zk2PxV9mLw4TnR8sBdYc3HfJ6gU5aE';
  let text = '';
  for (let index = 0; index < length; index += 1) text += alphabet.charAt((index * 7 + (index >> 5)) % alphabet.length);
  return text;
}

/**
 * Every hostile shape, at `cap` bytes or just under. Labels name the shape; the texts are what a hand-written file or an
 * agent's `config_write` could hold.
 */
export function adversarialTexts(cap: number): readonly (readonly [label: string, text: string])[] {
  const longString = 'x'.repeat(Math.floor(cap / 2));
  const laughs = Array.from(
    { length: 10 },
    (_, level) =>
      `l${level}: &l${level} [${Array.from({ length: 9 }, () => (level === 0 ? PRIVATE_WORD : `*l${level - 1}`)).join(', ')}]\n`,
  ).join('');
  return [
    // Long runs of blanks: the line scan, and a value padded with them.
    ['one line of spaces', fill(cap, ' ')],
    ['one line of tabs and spaces', fill(cap, ' \t')],
    ['a value padded with spaces to the end', fill(cap, ' ', 'note: x', 'y')],
    ['a key padded with spaces before its colon', fill(cap, ' ', 'note', ': x')],
    ['a list dash then spaces', fill(cap, ' ', '- ', 'token: y')],
    ['quotes and colons with spaces between', fill(cap, '" : \' ')],
    ['many lines of trailing spaces', lines(cap, index => `k${index}: v${' '.repeat(100)}\n`)],
    // Deep nesting, three ways.
    ['block mappings nested as deep as indentation allows', lines(cap, index => `${' '.repeat(index)}k:\n`)],
    ['block lists nested on one line', fill(cap, '- ', '', 'x')],
    ['flow lists nested', `${'['.repeat(Math.floor(cap / 2) - 1)}${']'.repeat(Math.floor(cap / 2) - 1)}`],
    ['flow mappings nested', `${'{a: '.repeat(Math.floor(cap / 5))}${'}'.repeat(Math.floor(cap / 5))}`],
    // Anchors and aliases.
    [
      'one anchor aliased on every line, the last unresolved',
      fill(cap - 16, '  - *a\n', 'note: &a x\nl:\n', '  - *nope\n'),
    ],
    ['many distinct anchors, each aliased', lines(cap, index => `- &a${index} x\n- *a${index}\n`)],
    ['an anchor of an empty anchor, aliased many times', fill(cap, '  - *a\n', 'e: &e []\na: &a [*e]\nb:\n')],
    ['a billion laughs, padded', fill(cap, '# padding\n', laughs)],
    ['a long string aliased in a list', fill(cap, '  - *s\n', `s: &s ${longString}\nl:\n`)],
    ['a long string aliased in a mapping', lines(cap, index => `  k${index}: *s\n`, `s: &s ${longString}\nm:\n`)],
    ['a deep anchor aliased many times', fill(cap, '- *d\n', `d: &d ${'['.repeat(200)}1${']'.repeat(200)}\nl:\n`)],
    ['aliases as keys', lines(cap, index => `*k${index % 1} : ${index}\n`, 'a: &k0 key\nm:\n').replace('m:\n', '')],
    ['an alias loop at the end', fill(cap, '    - 1\n', 'note: &a\n  b:\n', '    - *a\n')],
    // Keys that are not plain strings.
    [
      'mappings and lists as keys, beside many anchors',
      lines(
        cap,
        () => '? [k]\n: 1\n',
        `a: [${Array.from({ length: 5_000 }, (_, index) => `&n${index} 1`).join(', ')}]\n`,
      ),
    ],
    ['a list alias as a key', lines(cap, index => `? *l\n: ${index}\n`, 'x: &l [1, 2]\n')],
    // Flat, wide documents.
    ['a flat mapping of many keys', lines(cap, index => `k${index}: v\n`)],
    ['a flow mapping of many keys', `{${lines(cap - 2, index => `k${index}: v, `)}}`],
    ['a flat list of many items', fill(cap, '- a\n')],
    ['the same key many times', fill(cap, 'k: v\n')],
    // Tags and directives.
    ['many local tags', fill(cap, '- !t x\n', 'l:\n')],
    ['many verbatim tags', fill(cap, '- !<tag:x> x\n', 'l:\n')],
    ['many undeclared tag handles', fill(cap, '- !h!t x\n', 'l:\n')],
    ['many directives', fill(cap - 8, '%YAML 1.2\n', '', '---\na: 1\n')],
    // YAML 1.1 tags the library would resolve inside the parse (its !!omap check is quadratic): never resolved.
    ['a flow !!omap of many short keys', `${lines(cap - 1, index => `${index.toString(36)}:,`, 'note: !!omap [')}]`],
    ['a top-level flow !!omap', `${lines(cap - 1, index => `${index.toString(36)}:,`, '!!omap [')}]`],
    ['a block !!omap of many short keys', lines(cap, index => `  - ${index.toString(36)}: 1\n`, 'note: !!omap\n')],
    ['a !!set of many keys', lines(cap, index => `  ? ${index.toString(36)}\n`, 'note: !!set\n')],
    ['a !!pairs of many keys', lines(cap, index => `  - ${index.toString(36)}: 1\n`, 'note: !!pairs\n')],
    // Comments and long scalars.
    ['one long comment', fill(cap, 'c', '# ')],
    ['many comment lines', fill(cap, `# ${'c'.repeat(100)}\n`)],
    ['one long plain scalar', fill(cap, 'x', 'note: ')],
    ['one long run of digits', fill(cap, '1', 'note: ', 'x')],
    ['one long number', fill(cap, '1', 'note: ')],
    ['one long double-quoted scalar of escapes', fill(cap, '\\x41', 'note: "', '"')],
    ['one long single-quoted scalar of quotes', fill(cap, "''", "note: '", "'")],
    ['one long folded block', fill(cap, '  x x\n', 'note: >\n')],
    // Things the raw-secret scan looks at.
    ['a run of key-shaped prefixes', fill(cap, 'sk-', 'note: ')],
    ['key-shaped prefixes split by spaces', fill(cap, 'sk-ant- ', '# ')],
    ['one long credential value', fill(cap, noise(64), 'token: ')],
    ['one long credential key', fill(cap, 'a', '', 'token: x')],
    ['many credential lines', lines(cap, index => `- token${index}: ${noise(40)}\n`)],
    ['many broken lines', fill(cap, '"\n')],
    ['many unclosed flows', fill(cap, '[\n')],
  ];
}
