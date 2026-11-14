import type { VerbInvocation } from '@ferretry/kernel/manifest';

/**
 * Reading a verb's words, once, for every browser verb.
 *
 * The shell parses every verb the same way and knows no verb's options (`parseArgs`): a short alias (`-s`) arrives
 * under its own letter, a switch written before a word takes that word as its value (`--double dev`), and anything
 * written `--name` arrives whether or not the verb has such an option. So each verb DECLARES its shape here and this
 * reads the words against it:
 *
 * - an option the verb does not declare is refused by name (never ignored, never silently dropped);
 * - a switch that swallowed the next word hands it back as an argument, IN THE PLACE it was written
 *   (`page click app --double '#go'` is the words `app`, `#go`): the shell records where each swallowed word stood
 *   (`VerbInvocation.swallowed`). A switch given a value with `=` (`--double=yes`) is refused;
 * - every option is read under each of its names (`--timeout`, `-t`), as the number or text it is.
 *
 * Pure: no IO, no globals.
 */

/** A refusal of what was typed, in words: the verb prints it and exits {@link EXIT_USAGE}. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Mistyped: an unknown verb or option, a missing or surplus argument, a value that is not what it must be. */
export const EXIT_USAGE = 2;

/** What an option carries. `either` is `--ask` alone or `--ask "say this"`. */
export type FlagKind = 'switch' | 'text' | 'list' | 'whole' | 'number' | 'either';

export interface FlagSpec {
  readonly kind: FlagKind;
  /** Every name it goes by, written without dashes; the first is the one help and refusals use. */
  readonly names: readonly string[];
}

const flagOf =
  (kind: FlagKind) =>
  (...names: readonly [string, ...string[]]): FlagSpec => ({ kind, names });

/** The five shapes an option takes. */
export const flag = {
  /** On or off: `--double`. */
  on: flagOf('switch'),
  /** One word: `--level error`. */
  text: flagOf('text'),
  /** Repeatable and comma-separated: `--type xhr,fetch --type script`. */
  list: flagOf('list'),
  /** A whole number: `--steps 5`. */
  whole: flagOf('whole'),
  /** A number that may be negative or fractional: `--pages=-1`. */
  number: flagOf('number'),
  /** A switch that may carry a word: `--ask` or `--ask "type the code"`. */
  either: flagOf('either'),
} as const;

/** One positional word: required unless `optional`; the last may take the rest (`rest`). */
export interface ArgSpec {
  readonly name: string;
  readonly optional?: true;
  readonly rest?: true;
}

/** A verb's words: its arguments and its options, each option under the key a builder reads it by. */
export interface VerbShape {
  readonly args: readonly ArgSpec[];
  readonly flags: Readonly<Record<string, FlagSpec>>;
}

type FlagValue = true | string | number | readonly string[];

/** A verb's words as the builder reads them. */
export class Parsed {
  constructor(
    /** The positional words, in order. */
    readonly args: readonly string[],
    private readonly values: ReadonlyMap<string, FlagValue>,
  ) {}

  /** The argument at `index`, or `undefined` when it was left out. */
  arg(index: number): string | undefined {
    return this.args[index];
  }

  /** The argument at `index`; it was declared required, so it is there. */
  need(index: number): string {
    const word = this.args[index];
    if (word === undefined) throw new UsageError('a word this verb needs is missing');
    return word;
  }

  /** Every word from `index` on, joined by spaces (`page type dev '#q' hello world`); absent when none. */
  words(index: number): string | undefined {
    const rest = this.args.slice(index);
    return rest.length === 0 ? undefined : rest.join(' ');
  }

  /** Every word from `index` on, as given. */
  from(index: number): readonly string[] {
    return this.args.slice(index);
  }

  on(key: string): boolean {
    return this.values.get(key) === true;
  }

  text(key: string): string | undefined {
    const value = this.values.get(key);
    return typeof value === 'string' ? value : undefined;
  }

  list(key: string): readonly string[] | undefined {
    const value = this.values.get(key);
    return Array.isArray(value) ? (value as readonly string[]) : undefined;
  }

  num(key: string): number | undefined {
    const value = this.values.get(key);
    return typeof value === 'number' ? value : undefined;
  }

  /** `true` for `--ask`, the word for `--ask "…"`, `undefined` when absent. */
  either(key: string): true | string | undefined {
    const value = this.values.get(key);
    return value === true || typeof value === 'string' ? value : undefined;
  }
}

/** How an option is written in a sentence. */
const dashed = (name: string): string => (name.length === 1 ? `-${name}` : `--${name}`);

const stringsOf = (value: VerbInvocation['options'][string] | undefined): readonly string[] =>
  value === undefined || typeof value === 'boolean' ? [] : typeof value === 'string' ? [value] : value;

/** A whole number from the command line, or a plain refusal naming the option. */
export function wholeNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(parsed))
    throw new UsageError(`${option} must be a whole number, not "${value}"`);
  return parsed;
}

/** A decimal number (negative or fractional allowed), or a plain refusal naming the option. */
export function decimal(value: string, option: string): number {
  const parsed = Number(value);
  if (value.trim() === '' || !Number.isFinite(parsed))
    throw new UsageError(`${option} must be a number, not "${value}"`);
  return parsed;
}

/** `a,b` and `a b` lists as their parts. */
const splitList = (given: readonly string[]): readonly string[] =>
  given
    .flatMap(word => word.split(','))
    .map(part => part.trim())
    .filter(part => part !== '');

/**
 * Reads `invocation` against `shape`. `verb` is the line a person typed (`browser page click`), for the sentences.
 * Throws {@link UsageError}; never returns a half-read result.
 */
export function parseVerb(verb: string, shape: VerbShape, invocation: VerbInvocation): Parsed {
  const byName = new Map<string, { readonly key: string; readonly spec: FlagSpec }>();
  for (const [key, spec] of Object.entries(shape.flags)) for (const name of spec.names) byName.set(name, { key, spec });

  const values = new Map<string, FlagValue>();
  /** The names under which a switch was written: the words they swallowed go back among the arguments. */
  const switches = new Set<string>();
  // A flag written under two of its names takes the value of the one written LAST. The shell says the order of every
  // occurrence when a name repeats (`written`); with no repeat, the options map is already in the order written.
  const order = invocation.written ?? Object.keys(invocation.options);
  const lastAt = new Map<string, number>();
  for (const [at, name] of order.entries()) lastAt.set(name, at);
  const winner = new Map<string, string>();
  for (const name of Object.keys(invocation.options)) {
    const known = byName.get(name);
    if (known === undefined) continue;
    const held = winner.get(known.key);
    if (held === undefined || (lastAt.get(name) ?? -1) > (lastAt.get(held) ?? -1)) winner.set(known.key, name);
  }
  for (const [name, given] of Object.entries(invocation.options)) {
    const known = byName.get(name);
    if (known === undefined) throw new UsageError(unknownOption(verb, name, shape));
    const { key, spec } = known;
    const label = dashed(spec.names[0] as string);
    // Only the name written last speaks for a flag that takes a value; a switch's names all say the same thing.
    if (spec.kind !== 'switch' && winner.get(key) !== name) continue;
    if (given === false) continue;
    switch (spec.kind) {
      case 'switch': {
        // `--double dev`: the word it took is an argument again, where it stood; `--double=yes` is refused.
        const words = stringsOf(given).filter(word => word !== 'true');
        const taken = (invocation.swallowed ?? []).filter(entry => entry.option === name).length;
        if (words.length > taken) throw new UsageError(`${label} is a switch and takes no value`);
        switches.add(name);
        values.set(key, true);
        break;
      }
      case 'either': {
        const words = stringsOf(given);
        values.set(key, words.length === 0 ? true : (words[words.length - 1] as string));
        break;
      }
      case 'text': {
        const words = stringsOf(given);
        if (words.length === 0) throw new UsageError(`${label} needs a value`);
        values.set(key, words[words.length - 1] as string);
        break;
      }
      case 'list': {
        const words = splitList(stringsOf(given));
        if (words.length === 0) throw new UsageError(`${label} needs a value`);
        values.set(key, words);
        break;
      }
      case 'whole':
      case 'number': {
        const words = stringsOf(given);
        if (words.length === 0) throw new UsageError(`${label} needs a number`);
        const word = words[words.length - 1] as string;
        values.set(key, spec.kind === 'whole' ? wholeNumber(word, label) : decimal(word, label));
        break;
      }
    }
  }

  const args = [...invocation.args];
  const restored = (invocation.swallowed ?? []).filter(entry => switches.has(entry.option));
  for (const [done, entry] of restored.entries()) args.splice(Math.min(entry.at + done, args.length), 0, entry.word);
  checkArguments(verb, shape.args, args);
  return new Parsed(args, values);
}

function checkArguments(verb: string, declared: readonly ArgSpec[], args: readonly string[]): void {
  const required = declared.filter(arg => arg.optional !== true);
  for (const [index, arg] of required.entries())
    if (args[index] === undefined)
      throw new UsageError(`${verb} needs ${arg.rest === true ? 'at least one ' : 'the '}${arg.name}`);
  const last = declared[declared.length - 1];
  if (last?.rest !== true && args.length > declared.length)
    throw new UsageError(
      `${verb} takes ${declared.length === 0 ? 'no words' : `at most ${String(declared.length)} (${declared.map(arg => arg.name).join(', ')})`}, not "${args[declared.length] as string}"`,
    );
}

function unknownOption(verb: string, name: string, shape: VerbShape): string {
  const own = Object.values(shape.flags).map(spec => dashed(spec.names[0] as string));
  return `${verb} has no option ${dashed(name)}${own.length === 0 ? '' : `; it takes ${own.join(', ')}`}`;
}
