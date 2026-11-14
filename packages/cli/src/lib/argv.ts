/**
 * Splits the words after the verb into positional arguments and options.
 *
 * The manifest declares a verb's words and nothing finer (`verb('card move')`), so the shell cannot know
 * which option takes a value. The rule is therefore fixed and small:
 *
 * - `--name=value` is a value. `--name value` is a value when `value` does not start with `-`.
 * - `--name` followed by another option, by `--` or by nothing is a switch (`true`). `--no-name` is `false`.
 * - A negative number (`-1`, `-0.5`, `-300,0`) is a word, never an option: `--pages -1` has the value `-1`.
 * - A repeated option becomes a list, in the order given.
 * - `--` ends options; everything after it is positional.
 * - Write positionals before options, or end options with `--`, when a switch is followed by a positional. A verb that
 *   declares an option a switch still gets that word back where it was written (`swallowed`).
 *
 * Pure: no IO, no globals.
 */
import type { SwallowedWord, VerbInvocation } from '@ferretry/kernel/manifest';

type OptionValue = string | boolean | readonly string[];

/** A negative number (`-1`, `-0.5`, `-300,0`) is a word: an option's name never starts with a digit. */
const isWord = (token: string): boolean => !token.startsWith('-') || token === '-' || /^-\d/u.test(token);

export function parseArgs(tokens: readonly string[]): VerbInvocation {
  const args: string[] = [];
  const options: Record<string, OptionValue> = {};
  const swallowed: SwallowedWord[] = [];
  const written: string[] = [];
  const put = (name: string, value: string | boolean): void => {
    written.push(name);
    const known = options[name];
    if (known === undefined) options[name] = value;
    else if (typeof value === 'boolean' || typeof known === 'boolean') options[name] = value;
    else options[name] = Array.isArray(known) ? [...known, value] : [String(known), value];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === '--') {
      args.push(...tokens.slice(index + 1));
      break;
    }
    if (isWord(token)) {
      args.push(token);
      continue;
    }
    const body = token.replace(/^-{1,2}/u, '');
    const equals = body.indexOf('=');
    if (equals >= 0) {
      put(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (body.startsWith('no-') && body.length > 3) {
      put(body.slice(3), false);
      continue;
    }
    const next = tokens[index + 1];
    if (next !== undefined && isWord(next)) {
      put(body, next);
      swallowed.push({ option: body, word: next, at: args.length });
      index += 1;
    } else put(body, true);
  }
  const repeated = new Set(written).size < written.length;
  return {
    args,
    options,
    raw: tokens,
    ...(swallowed.length === 0 ? {} : { swallowed }),
    ...(repeated ? { written } : {}),
  };
}

/** The first string value of an option, if it has one. */
export function optionText(invocation: VerbInvocation, name: string): string | undefined {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1] as string | undefined;
  return undefined;
}

/** Whether a switch is on (`--name`, `--name=true`); `--no-name` and absence are off. */
export function optionOn(invocation: VerbInvocation, name: string): boolean {
  const value = invocation.options[name];
  return value === true || value === 'true';
}
