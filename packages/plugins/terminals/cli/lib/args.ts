import type { VerbInvocation } from '@ferretry/kernel/manifest';

/**
 * Reading a verb's words. The shell parses every verb the same way and knows no verb's options, so a short alias
 * (`-n`) arrives under its own letter and a switch written before a word takes that word as its value
 * (`--exit dev`). These helpers read an option under each of its names, and hand a switch's stray word back as
 * an argument, so the verbs read as they did under commander.
 */

/** A refusal of what was typed, in words: the verb prints it and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const EXIT_USAGE = 2;

type Value = VerbInvocation['options'][string];

const values = (value: Value | undefined): readonly string[] => {
  if (value === undefined || typeof value === 'boolean') return [];
  return typeof value === 'string' ? [value] : value;
};

/** One verb's words, read under the names each option goes by. */
export class Words {
  readonly #strays: string[] = [];

  constructor(private readonly invocation: VerbInvocation) {}

  /** The positional words, with any word a switch swallowed put back first. */
  get args(): readonly string[] {
    return [...this.#strays, ...this.invocation.args];
  }

  /** The last value given under any of `names`, if any. */
  text(...names: readonly string[]): string | undefined {
    for (const name of names) {
      const given = values(this.invocation.options[name]);
      if (given.length > 0) return given[given.length - 1];
    }
    return undefined;
  }

  /** Every value given under any of `names`, comma lists split (`-k enter -k tab`, `--key enter,tab`). */
  list(...names: readonly string[]): readonly string[] {
    return names
      .flatMap(name => values(this.invocation.options[name]))
      .flatMap(value => value.split(','))
      .map(part => part.trim())
      .filter(part => part !== '');
  }

  /** Whether a switch is on. A word it swallowed (`--exit dev`) goes back to the arguments. */
  on(...names: readonly string[]): boolean {
    let on = false;
    for (const name of names) {
      const value = this.invocation.options[name];
      if (value === true || value === 'true') on = true;
      else if (typeof value === 'string' && value !== 'false') {
        on = true;
        this.#strays.push(value);
      }
    }
    return on;
  }

  /** An option that may be a switch or carry a word: `--ask` alone, or `--ask "type the code"`. */
  switchOrText(...names: readonly string[]): true | string | undefined {
    for (const name of names) {
      const value = this.invocation.options[name];
      if (value === true || value === 'true') return true;
      const given = values(value);
      if (given.length > 0) return given[given.length - 1];
    }
    return undefined;
  }
}

/** A whole number from the command line, or a plain refusal naming the option. */
export function wholeNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(parsed))
    throw new UsageError(`${option} must be a whole number, not "${value}"`);
  return parsed;
}

/** Text given as several words on the command line, as one string; absent when none was given. */
export const joined = (words: readonly string[]): string | undefined =>
  words.length === 0 ? undefined : words.join(' ');
