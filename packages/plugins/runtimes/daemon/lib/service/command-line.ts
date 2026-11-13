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
import {
  findFlagSecrets,
  findRawSecrets,
  HIDDEN_VALUE_TEXT,
  looksSecret,
  type ShownWord,
  shownWord,
  shownWords,
} from '@ferretry/std/credential-words';
import { sha256Hex } from '../foreign.ts';

export { type ShownWord, shownWords } from '@ferretry/std/credential-words';

/**
 * The indexes of the words the write rule still refuses once the cutter has had its say. W judges a flag's value with
 * the word before it, so the list is judged as one command line, the way the kernel reads a list of strings.
 */
export function refusedIndexes(shown: readonly ShownWord[]): ReadonlySet<number> {
  const args = shown.map(word => word.text);
  const found = [...findFlagSecrets({ args }), ...findRawSecrets({ args })];
  return new Set(found.map(finding => finding.path[1]).filter((at): at is number => typeof at === 'number'));
}

/**
 * Whether the write rule refuses `value` as the value of a field called `name` (a token shape, a flag secret in it).
 * The PARSED value is judged, never its JSON text: a list or a nested document is read by the list and nested-key rules.
 */
const valueRefused = (name: string, value: unknown): boolean =>
  findRawSecrets({ [name]: value }).length > 0 || findFlagSecrets({ [name]: value }).length > 0;

/** What stands in a sentence in place of a value the write rule refuses. */
export const NOT_SHOWN_VALUE = '(a value that is not shown)';

/**
 * Whether a value shown under a settings key (`permissions.defaultMode`, `env.API_KEY`) is one the write rule refuses:
 * judged under the key as written and under its last part, the name the document holds it under. The ONE rule for every
 * place a value of any shape is shown beside its name (a detail, the Resolved view, a conflict sentence, a fixed row).
 */
export const valueWithheld = (key: string, value: unknown): boolean => {
  const name = key.slice(key.lastIndexOf('.') + 1);
  return valueRefused(key, value) || (name !== key && valueRefused(name, value));
};

/** A value in words, as a string or as its JSON text; `NOT_SHOWN_VALUE` when {@link valueWithheld}. */
export const valueSaid = (key: string, value: unknown): string =>
  valueWithheld(key, value) ? NOT_SHOWN_VALUE : typeof value === 'string' ? value : JSON.stringify(value);

/** A command split at its blanks: the words the write rule reads, so `srv --token` is two words and not one. */
export const commandWordsOf = (command: string): readonly string[] => command.split(/\s+/u).filter(word => word !== '');

/**
 * Whether a text that would be shown AS WRITTEN must be withheld whole: the write rule refuses it, or the word cutter
 * would cut any part of it. A part is never shown. (The write rule reads a command and its arguments as two fields, so
 * the arguments are judged by their own net, not here.)
 */
export const writtenWithheld = (name: string, text: string): boolean =>
  valueRefused(name, text) || shownWord(text, undefined).hidden;

/** A pointer to a value, not a value: `$NAME`, `${NAME}`, `${secret:NAME}`, with a pair of quotes around it or not. */
const POINTER = /^(["']?)\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)\1$/u;

/** A plain word of a command: lowercase letters, dots, slashes and hyphens (`srv`, `npx`, `--stdio`, `bin/run.js`). */
const PLAIN_WORD = /^-{0,2}[a-z][a-z._/-]*$/u;

/**
 * Whether a part the cutter cut is a pointer and nothing else: its first word is a pointer, and the words the cutter
 * took with it (it cuts to the end of the command: `API_KEY=$API_KEY srv` is cut after the `=`) are plain words of a
 * command, with no digit, case, `=` or `:` in them that a value would have. A part that starts with anything else is
 * a value.
 */
function pointerThenPlainWords(part: string): boolean {
  const [pointer = '', ...rest] = part.trim().split(/\s+/u);
  return (
    pointer === HIDDEN_VALUE_TEXT ||
    (POINTER.test(pointer) && rest.every(word => PLAIN_WORD.test(word) && !looksSecret('', word)))
  );
}

/**
 * Whether the word cutter, run on `text` AS ONE STRING, cuts a part that is not a pointer: the cut parts are read back
 * from the text (the shown pieces between the cuts are matched in order), and a part that is not a pointer or already
 * hidden is a value. A cut that cannot be read back is a value (fail closed).
 */
function cutsAValue(text: string, before?: string): boolean {
  const shown = shownWord(text, before);
  if (!shown.hidden) return false;
  const pieces = shown.text.split(HIDDEN_VALUE_TEXT);
  const first = pieces[0] ?? '';
  if (!text.startsWith(first)) return true;
  let at = first.length;
  for (let index = 1; index < pieces.length; index += 1) {
    const piece = pieces[index] ?? '';
    const last = index === pieces.length - 1;
    const end = last ? text.length - piece.length : text.indexOf(piece, at + 1);
    if (end < at + 1 || (last && !text.endsWith(piece))) return true;
    if (!pointerThenPlainWords(text.slice(at, end))) return true;
    at = end + piece.length;
  }
  return false;
}

/**
 * Whether an MCP server's `command` must be withheld, in EVERY view that shows it (the detail, the Resolved line, the
 * warning): the write rule refuses it, as one string or as the words it splits into (so `srv --token` and a first
 * argument make one pair), or the word cutter, run on the command as one string or word by word, cuts a part that is
 * a VALUE (`curl -H "Authorization: Bearer v"`). A pointer is not a value: `env API_KEY=$API_KEY srv` is shown as written.
 */
export const commandWithheld = (command: string): boolean => {
  const words = commandWordsOf(command);
  return (
    valueRefused('command', command) ||
    refusedIndexes(words.map(word => ({ text: word, hidden: false }))).size > 0 ||
    cutsAValue(command) ||
    // Read word by word too, as a list of arguments is: each word with the one before it.
    words.some((word, index) => cutsAValue(word, words[index - 1]))
  );
};

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
