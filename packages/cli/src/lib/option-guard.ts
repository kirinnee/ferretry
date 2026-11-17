/**
 * The shell refuses an option the resolved verb does not declare, before the verb runs and before any daemon call.
 *
 * `parseArgs` reads ANY `--name`, and each verb reads only the names it knows, so an undeclared flag used to be dropped
 * without a word: `fy restart --outdated --dry-run` restarted for real. A verb's manifest `options` is now the whole
 * list of what it accepts: an option its code reads is declared (listed, or `hidden: true` for a synonym, a former name
 * or a flag it reads only to refuse). `tests/unit/verb-option-audit.test.ts` proves it for every verb in the real
 * generated registry.
 *
 * Pure: no IO, no globals.
 */
import type { VerbInvocation, VerbOptionDecl } from '@ferretry/kernel/manifest';
import { flagNames } from './argv.ts';

/**
 * What every verb accepts without declaring it. `--help` / `-h` are answered before the options are read at all; they
 * are listed so a `--help` that reaches the check (a value-taking spelling) is never called unknown. `--as-owner` is the
 * root flag of today's `fy` (v4 listed it as inherited by every command).
 */
export const SHELL_WIDE_OPTIONS: readonly string[] = ['help', 'h', 'as-owner'];

/**
 * The verbs that read their own options by walking every one the person typed, and refuse what their own table does not
 * hold (commander's `error: unknown option '--x'`, or a sentence naming the verb's flags): the names are theirs to
 * know, so the shell leaves them to them. It is the one opt-out list: a plugin (every verb it declares) and, for a
 * plugin that also has verbs that read by name, the verb lines that are NOT opted out (the shell checks those).
 * `tests/unit/verb-option-audit.test.ts` proves each opted-out verb refuses an undeclared flag itself, naming it, with
 * nothing sent; a verb joins this list only with that proof.
 */
const SELF_VALIDATING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['access', new Set<string>()], // `readInvocation` / `parseVerb` walk `invocation.options` against the verb's shape
  [
    'accounts', // `readInvocation` against each verb's shape (`copy …`, `plan …`, `account …`) …
    new Set(['rules ls', 'rules add', 'rules resume', 'rules renew', 'rules widen', 'rules narrow', 'rules rm']), // … but `rules` reads by name
  ],
  ['agenda', new Set(['notify'])], // `readVerb` re-reads the raw words against each verb's grammar; `notify` reads by name
  ['browsers', new Set<string>()], // `parseVerb` against each verb's flag table
  ['vault', new Set<string>()], // `secret …` reads its options against each verb's shape
]);

/** Whether the verb refuses its own undeclared options, so the shell does not check it. */
export const isSelfValidating = (owner: string, line: string): boolean =>
  SELF_VALIDATING.has(owner) && !SELF_VALIDATING.get(owner)?.has(line);

/** Every name a verb's declared options answer to: `-s, --session <id>` is `s` and `session`; `--no-x` also answers to `x`. */
export function declaredOptionNames(options: readonly Pick<VerbOptionDecl, 'flag'>[] | undefined): ReadonlySet<string> {
  const names = new Set<string>(SHELL_WIDE_OPTIONS);
  for (const { flag } of options ?? [])
    for (const name of flagNames(flag)) {
      names.add(name);
      // The parser reads `--no-x` as `x` set off, so a verb that declares only `--no-x` accepts that spelling.
      if (name.startsWith('no-') && name.length > 3) names.add(name.slice(3));
    }
  return names;
}

/** How the person typed an option: `-y` for a one-letter flag, `--no-x` for a negation, `--name` otherwise. */
function typedSpelling(name: string, value: VerbInvocation['options'][string] | undefined): string {
  const shown = name.length > 40 ? `${name.slice(0, 40)}…` : name;
  if (value === false) return `--no-${shown}`;
  return name.length === 1 ? `-${shown}` : `--${shown}`;
}

/**
 * The first option typed (in the order typed) that the verb does not declare, as the person wrote it; undefined when
 * every option is declared or the verb is left to refuse its own.
 */
export function undeclaredOption(
  owner: string,
  line: string,
  options: readonly Pick<VerbOptionDecl, 'flag'>[] | undefined,
  invocation: Pick<VerbInvocation, 'options'>,
): string | undefined {
  if (isSelfValidating(owner, line)) return undefined;
  const known = declaredOptionNames(options);
  const name = Object.keys(invocation.options).find(each => !known.has(each));
  return name === undefined ? undefined : typedSpelling(name, invocation.options[name]);
}
