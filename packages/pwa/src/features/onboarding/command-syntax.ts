/**
 * A shell command, split into the parts that DIFFER between one command and the
 * next.
 *
 * Setup is four monospace blocks that look identical to each other, and a reader
 * who has to parse every character to find the one word that changed is being
 * asked to do the machine's job. Colour is the cheapest way to hand it back:
 * once the binary, the verb, the flags and the literals each have a tone, the
 * SHAPE of a command is legible before a single word is read.
 *
 * WHAT THIS IS NOT. It is not a shell parser and must never grow into one. It
 * makes exactly the distinctions a reader needs at a glance, on the handful of
 * commands this page ships, and it is total: any input yields tokens whose text
 * concatenates back to the input, so nothing a reader copies can differ from
 * what they were shown. That last property is the whole safety argument — a
 * highlighter that can drop a character is worse than no highlighter.
 */

/** The distinctions worth a colour. Anything finer is noise at a glance. */
export type CommandTokenKind = 'binary' | 'subcommand' | 'flag' | 'string' | 'url' | 'operator' | 'comment' | 'plain';

export interface CommandToken {
  readonly kind: CommandTokenKind;
  readonly text: string;
  /**
   * Character offset within the whole command.
   *
   * A rendering key that comes from the content rather than from an array
   * index, and the thing that makes the round-trip property checkable.
   */
  readonly start: number;
}

/** Words that hand the command straight to another binary. */
const OPERATORS: ReadonlySet<string> = new Set(['|', '&&', '||', ';', '&', '>', '>>']);

/**
 * Runners that prefix a real command rather than being one.
 *
 * `sudo apt install` has two binaries in a row, and colouring `apt` as an
 * argument would hide the thing the reader is actually running.
 */
const RUNNERS: ReadonlySet<string> = new Set(['sudo', 'env', 'command', 'exec']);

/**
 * How many words after the binary may read as its verb.
 *
 * Two, because every command this page ships tops out at a two-word verb phrase
 * (`daemon start`, `install fy`) and a third would start colouring file names.
 */
const MAX_VERB_WORDS = 2;

/** A word that is plainly data rather than a verb: a path, a URL, an assignment. */
const NOT_A_VERB = /[/.=]/;

const isUrl = (word: string): boolean => word.startsWith('https://') || word.startsWith('http://');

const isQuoted = (word: string): boolean => word.startsWith('"') || word.startsWith("'");

/**
 * The delimiter a heredoc opener names, or `undefined` if this is not one.
 *
 * `<<'EOF'`, `<<"EOF"` and `<<EOF` all mean the same thing to the shell, and the
 * lines that follow are literal data — not commands. Colouring that body word by
 * word would invent structure the reader does not have to think about.
 */
const heredocDelimiter = (word: string): string | undefined => {
  if (!word.startsWith('<<')) return undefined;
  const raw = word.slice(2).replace(/^-/, '');
  const unquoted = raw.replace(/^['"]|['"]$/g, '');
  return unquoted === '' ? undefined : unquoted;
};

/**
 * Split a line into words and the whitespace between them, keeping a quoted span
 * whole.
 *
 * A quote is why this is a scanner rather than a `split`: the apt route pipes a
 * quoted sources.list entry that contains spaces, and chopping it at those
 * spaces would paint one literal in four colours.
 */
const scan = (line: string): readonly { readonly text: string; readonly start: number; readonly word: boolean }[] => {
  const pieces: { text: string; start: number; word: boolean }[] = [];
  let index = 0;
  while (index < line.length) {
    const start = index;
    if (/\s/.test(line[index] ?? '')) {
      while (index < line.length && /\s/.test(line[index] ?? '')) index += 1;
      pieces.push({ text: line.slice(start, index), start, word: false });
      continue;
    }
    let quote: string | undefined;
    while (index < line.length) {
      const character = line[index] ?? '';
      if (quote === undefined && /\s/.test(character)) break;
      if (quote === undefined && (character === '"' || character === "'")) quote = character;
      else if (quote === character) quote = undefined;
      index += 1;
    }
    pieces.push({ text: line.slice(start, index), start, word: true });
  }
  return pieces;
};

/** Reading state carried across the words of one line, and across lines. */
interface Reading {
  /** The next word is the thing being run. */
  readonly expectBinary: boolean;
  /** How many more words may still read as the binary's verb. */
  readonly verbBudget: number;
  /** Set while inside a heredoc body, to the word that closes it. */
  readonly heredoc: string | undefined;
}

const START: Reading = { expectBinary: true, verbBudget: 0, heredoc: undefined };

/** Classify one word and say how the rest of the line should be read. */
const classify = (word: string, reading: Reading): { readonly kind: CommandTokenKind; readonly next: Reading } => {
  if (OPERATORS.has(word)) return { kind: 'operator', next: START };
  const rest: Reading = { ...reading, expectBinary: false, verbBudget: 0 };
  if (word.startsWith('<<')) {
    const delimiter = heredocDelimiter(word);
    // A `<<` that names no delimiter opens nothing, so nothing may be swallowed.
    if (delimiter === undefined) return { kind: 'plain', next: rest };
    return { kind: 'operator', next: { ...rest, heredoc: delimiter } };
  }
  if (isUrl(word)) return { kind: 'url', next: rest };
  if (isQuoted(word)) return { kind: 'string', next: rest };
  if (word.startsWith('-')) return { kind: 'flag', next: reading.expectBinary ? reading : rest };
  if (reading.expectBinary) {
    const runner = RUNNERS.has(word);
    return {
      kind: 'binary',
      next: { ...reading, expectBinary: runner, verbBudget: runner ? 0 : MAX_VERB_WORDS },
    };
  }
  if (reading.verbBudget > 0 && !NOT_A_VERB.test(word)) {
    return { kind: 'subcommand', next: { ...reading, verbBudget: reading.verbBudget - 1 } };
  }
  return { kind: 'plain', next: rest };
};

/** Tokenize one line, given how the previous lines left the reading. */
const tokenizeLine = (
  line: string,
  reading: Reading,
): { readonly tokens: readonly CommandToken[]; readonly next: Reading } => {
  if (reading.heredoc !== undefined) {
    const closes = line.trim() === reading.heredoc;
    return {
      tokens: [{ kind: closes ? 'operator' : 'string', text: line, start: 0 }],
      next: closes ? START : reading,
    };
  }
  const tokens: CommandToken[] = [];
  let carried = reading;
  for (const piece of scan(line)) {
    if (!piece.word) {
      tokens.push({ kind: 'plain', text: piece.text, start: piece.start });
      continue;
    }
    /*
     * A comment swallows the rest of the line, because that is what the shell
     * does with it — tokenizing inside one would colour words that never run.
     */
    if (piece.text.startsWith('#')) {
      tokens.push({ kind: 'comment', text: line.slice(piece.start), start: piece.start });
      return { tokens, next: START };
    }
    const { kind, next } = classify(piece.text, carried);
    tokens.push({ kind, text: piece.text, start: piece.start });
    carried = next;
  }
  return { tokens, next: carried.heredoc === undefined ? START : carried };
};

/**
 * A command as one flat run of coloured tokens, line breaks included.
 *
 * Flat rather than nested per line because a `<pre>` already renders `\n` as a
 * line break, and one array means one `map` with content-derived keys instead of
 * a nested map keyed by array index. The breaks are tokens like any other, so
 * the round-trip property covers them: joining every `text` reproduces the
 * command exactly, breaks and all.
 */
export const tokenizeCommand = (command: string): readonly CommandToken[] => {
  const tokens: CommandToken[] = [];
  let reading = START;
  let offset = 0;
  const lines = command.split('\n');
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      tokens.push({ kind: 'plain', text: '\n', start: offset });
      offset += 1;
    }
    const result = tokenizeLine(line, reading);
    for (const token of result.tokens) tokens.push({ ...token, start: offset + token.start });
    offset += line.length;
    reading = result.next;
  }
  return tokens;
};
