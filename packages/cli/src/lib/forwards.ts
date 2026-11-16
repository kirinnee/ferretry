/**
 * Verbs the shell hands on to another verb. `fy new --continue [words]` and `fy new --since <dur>` are `fy link
 * [words] [--since <dur>] [--harness <h>]` (owner ruling): continuing a conversation is Conversation's, Ferrets cannot
 * import it and no plugin may add an option to another's verb, so the shell, which sees every verb, runs the one verb
 * the person meant. It adds no behaviour of its own: exit codes, sentences and the request are `fy link`'s.
 * Pure: words in, words out.
 */
import { parseArgs } from './argv.ts';
import type { VerbEntry } from './verbs.ts';

/** The options of `fy new` that mean something to `fy link`; any other typed option has nowhere to go. */
const LINK_OPTIONS: ReadonlySet<string> = new Set(['continue', 'since', 'harness', 'json']);

export type Forward =
  | { readonly kind: 'forward'; readonly tokens: readonly string[] }
  | { readonly kind: 'refused'; readonly message: string };

/** Whether a typed word is the `--continue` switch itself (`--continue`, `--continue=true`), which `fy link` does not take. */
const isContinue = (token: string): boolean => token === '--continue' || token.startsWith('--continue=');

/**
 * What `fy new <rest>` becomes when it asks to continue a conversation: the tokens of `fy link …` with `--continue`
 * dropped, or a refusal naming an option that would otherwise be lost. `undefined`: this is no continue, `fy new` runs.
 */
export function forwardNewToLink(entry: VerbEntry, rest: readonly string[], binary: string): Forward | undefined {
  if (entry.owner !== 'ferrets' || entry.words.join(' ') !== 'new') return undefined;
  const { options } = parseArgs(rest);
  if (options.continue === undefined && options.since === undefined) return undefined;
  const lost = Object.keys(options)
    .filter(name => !LINK_OPTIONS.has(name))
    .map(name => `--${name}`);
  if (lost.length > 0)
    return {
      kind: 'refused',
      message: `${lost.join(', ')}: not taken with --continue or --since, which are \`${binary} link [words] [--harness <h>] [--since <n>d]\` (it continues a conversation; it starts no helper)`,
    };
  return { kind: 'forward', tokens: ['link', ...rest.filter(token => !isContinue(token))] };
}
