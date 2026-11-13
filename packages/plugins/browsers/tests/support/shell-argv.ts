import type { SwallowedWord, VerbInvocation } from '@ferretry/kernel/manifest';

/**
 * The shell's `parseArgs` (`packages/cli/src/lib/argv.ts`), code for code, so a test types a verb the way `fy` hands it
 * over: `--name=value`, `--name value` (a value when it does not start with `-`, or is a negative number), a lone
 * `--name` is a switch, `--no-name` is off, a repeat is a list, `--` ends options, and every word an option took is
 * recorded in `swallowed`. A plugin's tests reach another package only through its contract, so the rule is copied
 * here; `packages/cli/tests/unit/browser-shell-argv-copy.test.ts` fails the moment this body and the shell's differ.
 */
type OptionValue = string | boolean | readonly string[];

/** A negative number (`-1`, `-0.5`, `-300,0`) is a word: an option's name never starts with a digit. */
const isWord = (token: string): boolean => !token.startsWith('-') || token === '-' || /^-\d/u.test(token);

export function parseArgs(tokens: readonly string[]): VerbInvocation {
  const args: string[] = [];
  const options: Record<string, OptionValue> = {};
  const swallowed: SwallowedWord[] = [];
  const put = (name: string, value: string | boolean): void => {
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
  return swallowed.length === 0 ? { args, options } : { args, options, swallowed };
}
