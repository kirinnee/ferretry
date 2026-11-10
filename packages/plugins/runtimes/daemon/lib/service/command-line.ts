/**
 * What Runtimes shows of a command line — a launch flag or an MCP argument — in the Resolved view
 * (`POST /v1/runtimes/profiles/preview`), a component's detail (`GET /v1/runtimes/components`) and the runtime list's
 * overridden flags (`GET /v1/runtimes`).
 *
 * The rule for which part of a word may show is NOT here: it is `@ferretry/std/credential-words`, ONE implementation
 * shared with the kernel's config read mask (`shownWord`, `shownWords`), and so is the write rule W (`findFlagSecrets`).
 * What is here is Runtimes' own: the etag an edit that keeps a hidden word sends back, and THE NET.
 *
 * THE NET (fail-closed). A cutter can be wrong; W is the rule a write is refused by. So every list of words Runtimes is
 * about to show is run through the cutter, then W is run on what the cutter SHOWS: a word W still refuses is WITHHELD,
 * with a plain sentence and never partial text. The same shape as the kernel's `unmaskable` withheld reason, so a word W
 * refuses is a word no Runtimes view shows, whatever the cutter learned or forgot.
 *
 * A text shown AS WRITTEN (an MCP server's `command` and `url`) is netted by {@link writtenWithheld}, and a value shown
 * under a name (an environment value, a settings value) is hidden when {@link valueRefused} says W refuses it: so every
 * field a Runtimes view shows is netted or is a name or a path (docs/secrets.md lists them).
 *
 * Pure.
 */
import { findFlagSecrets, findRawSecrets, type ShownWord, shownWord, shownWords } from '@ferretry/std/credential-words';
import { sha256Hex } from '../foreign.ts';

export { type ShownWord, shownWords } from '@ferretry/std/credential-words';

/**
 * The indexes of the words the write rule still refuses once the cutter has had its say. W judges a flag's value with
 * the word before it, so the list is judged as one command line, the way the kernel reads a list of strings.
 */
export function refusedIndexes(shown: readonly ShownWord[]): ReadonlySet<number> {
  const found = findFlagSecrets({ args: shown.map(word => word.text) });
  return new Set(found.map(finding => finding.path[1]).filter((at): at is number => typeof at === 'number'));
}

/** Whether the write rule refuses `text` as the value of a field called `name` (a token shape, a flag secret in it). */
export const valueRefused = (name: string, text: string): boolean =>
  findRawSecrets({ [name]: text }).length > 0 || findFlagSecrets({ [name]: text }).length > 0;

/**
 * Whether a text that would be shown AS WRITTEN must be withheld whole: the write rule refuses it, or the word cutter
 * would cut any part of it. A part is never shown. (The write rule reads a command and its arguments as two fields, so
 * the arguments are judged by their own net, not here.)
 */
export const writtenWithheld = (name: string, text: string): boolean =>
  valueRefused(name, text) || shownWord(text, undefined).hidden;

/** A command line as it may be shown: the cutter's words, and whether the net withheld the whole list. */
export interface ShownLine {
  readonly words: readonly ShownWord[];
  /** True when the write rule still refused a word the cutter showed: nothing in `words` may be shown. */
  readonly withheld: boolean;
}

/**
 * A whole list, cut and netted: `withheld` when W still refuses any of it. A list view that can show words one by one
 * asks {@link refusedIndexes} instead.
 */
export function shownLine(words: readonly string[], first?: string): ShownLine {
  const shown = shownWords(words, first);
  return { words: shown, withheld: refusedIndexes(shown).size > 0 };
}

/**
 * The etag of a list of words AS SHOWN: what an edit that keeps a hidden word by its position is checked against. It
 * is made of the shown words only, so it carries nothing the same read does not already show; it moves when a word is
 * added, removed, moved or changed where it can be seen. A hidden value retyped in place is kept as it now is, as an
 * environment `{ keep: true }` keeps the value the component has when the edit lands.
 */
export const shownWordsEtag = (shown: readonly ShownWord[]): string =>
  sha256Hex(JSON.stringify(shown.map(word => [word.text, word.hidden])));
