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
  isShellPointer,
  looksSecret,
  type ShownWord,
  SHOWN_TESTS,
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
  const refused = new Set(found.map(finding => finding.path[1]).filter((at): at is number => typeof at === 'number'));
  args.forEach((word, index) => {
    if (
      valueOfNonPointerCredentialFlag(args[index - 1], word) ||
      valueOfCredentialHeader(args[index - 2], args[index - 1], word, args[index - 3])
    )
      refused.add(index);
  });
  return refused;
}

/** A header whose value is a credential by its name, though the name may not say so to a flag test. */
const CREDENTIAL_HEADER = /^(?:proxy-)?authorization$|^(?:set-)?cookie$/iu;

/** A header's name, and nothing else (`Authorization`, `X-Auth-Token`). */
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/** A header glued to its value in one word: `Authorization:/V`, `Cookie:session=v`, `Authorization:Bearer`. */
const GLUED_HEADER = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(\S[\s\S]*)$/u;

/**
 * What the write rule accepts as a "place" under a credential name: a path, or a URL. Used only for a header glued to its
 * value in ONE word, where a value that is no place is left to the cutter (a pointer with a low-entropy part is shown).
 */
const ANY_PLACE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])/iu;

/** The word that says how a credential header's value is meant: it is followed by the value. */
const SCHEME_WORD = /^(?:bearer|basic|token)$/iu;

/** A word without the quote marks around it: `"Authorization:` is `Authorization:`. */
const unquoted = (word: string): string => word.replace(/^["'`]+|["'`]+$/gu, '');

const isCredentialHeader = (name: string): boolean => CREDENTIAL_HEADER.test(name) || SHOWN_TESTS.namesSecret(name);

/** A word as a header test reads it: unquoted, and with the flag it is glued to by `=` taken off (`--header=Cookie:`). */
const headerWord = (word: string | undefined): string => unquoted(word ?? '').replace(/^-{1,2}[A-Za-z][\w-]*=/u, '');

/**
 * Whether `word` is the value of a credential header, or of a scheme word (`Bearer`, `Basic`, `Token`) that follows one:
 * what follows is a value whatever it looks like (a path, a URL, quoted, in parentheses, after `=` or `@`), because a header
 * names no place and no scheme is followed by one. The header is read in the three ways a line holds it: the word before is
 * `Header:`, the two before are `Header` and `:`, or the word itself holds the pair (`Authorization:/V`, `Authorization`
 * then `:/V`). A scheme word counts ONLY right after such a header (`Header: Bearer`, `Header : Bearer`, `Header:Bearer`):
 * a bare `token` or `Bearer` elsewhere is an ordinary word. A flag glued to the header by `=` is taken off first
 * (`--header=Cookie:`). `before` is the word before `word`, `beforeThat` the one before it, `beforeThatThat` the one
 * before that. The same rule as the one-string form's: it fails closed.
 */
function valueOfCredentialHeader(
  beforeThat: string | undefined,
  before: string | undefined,
  word: string,
  beforeThatThat?: string,
): boolean {
  const previous = headerWord(before);
  const earlier = headerWord(beforeThat);
  const previousName = previous.endsWith(':') ? previous.slice(0, -1) : '';
  const gluedBefore = GLUED_HEADER.exec(previous);
  const gluedWord = GLUED_HEADER.exec(unquoted(word));
  const header = (name: string): boolean => HEADER_NAME.test(name) && isCredentialHeader(name);
  // the word before a scheme word must be the header: `Header:`, `Header` `:`, or the scheme glued to it (`Header:Scheme`)
  const schemeAfterHeader =
    SCHEME_WORD.test(previous) &&
    ((earlier.endsWith(':') && header(earlier.slice(0, -1))) ||
      (earlier === ':' && header(headerWord(beforeThatThat))));
  const gluedScheme = gluedBefore !== null && header(gluedBefore[1] ?? '') && SCHEME_WORD.test(gluedBefore[2] ?? '');
  return (
    // `Header:` then the value
    header(previousName) ||
    // `Header`, `:`, then the value
    (previous === ':' && header(earlier)) ||
    // `Header` then `:value`
    (/^:[ \t]*\S/u.test(unquoted(word)) && header(previous)) ||
    // the pair in the word itself, its value a path or a URL
    (gluedWord !== null && header(gluedWord[1] ?? '') && ANY_PLACE.test(unquoted(gluedWord[2] ?? ''))) ||
    // a scheme word, only right after the header that it belongs to, then the value
    schemeAfterHeader ||
    gluedScheme
  );
}
/**
 * Whether `word` is a path-looking value given to a credential-named flag that is NOT a pointer flag (`--token ./V`,
 * `--password /a/b`, `--api-key /tmp/V`, `--auth-token=./V`): the write rule accepts a path under a credential name, but
 * only a pointer flag (`--token-file`, `--key`, `--config`) names a place, so under any other the word is a value and is
 * never shown. `before` is the word before `word`; a flag glued to its value with `=` is read from `word` itself.
 */
function valueOfNonPointerCredentialFlag(before: string | undefined, word: string): boolean {
  const glued = /^(-{1,2}[A-Za-z][A-Za-z0-9_-]*)=(.*)$/su.exec(word);
  const flag = glued === null ? before : glued[1];
  const value = glued === null ? word : (glued[2] ?? '');
  return (
    flag !== undefined &&
    FLAG_NAME.test(flag) &&
    !POINTER_FLAG.test(flag) &&
    PLACE.test(value) &&
    (SHOWN_TESTS.namesSecret(flag) || /^-{1,2}auth/iu.test(flag))
  );
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

/** A pair of quotes around a word, or none. */
const QUOTED = /^(["'])([\s\S]*)\1$/u;

/**
 * A pointer to a value, not a value: `$NAME`, `${NAME}`, `${secret:NAME}`, with a pair of quotes around it or not. The
 * std rule's own reading ({@link isShellPointer}): a default (`${X:-v}`) carries a literal and is a value, whatever
 * its NAME.
 */
const isPointer = (word: string): boolean => isShellPointer(QUOTED.exec(word)?.[2] ?? word);

/**
 * A plain word of a command: lowercase letters, dots, slashes and hyphens (`srv`, `npx`, `--stdio`, `bin/run.js`),
 * and a package's scope mark (`@scope/pkg`).
 */
const PLAIN_WORD = /^-{0,2}@?[a-z][a-z._/-]*$/u;

/** A real path: `~/…`, `./…`, `../…` and a first `/` with at least a second segment (`/a/b`), never a bare `/x`. */
const PLACE = /^(?:(?:~|\.|\.\.)\/[^/]|\/[^/]+\/[^/])/u;

/** A mark a value has and a place has not: a pointer, a query, a fragment, a user, a scheme or a pair. */
const NOT_IN_A_PLACE = /[\s${}#?@:=]/u;

/** A plain flag name and nothing else (`--token`, `--api-key`, `-k`): letters, digits, `_` and `-`, never a pair or a header. */
const FLAG_NAME = /^-{1,2}[A-Za-z][A-Za-z0-9_-]*$/u;

/** A flag word on its own (`--token-file`, `-k`): no `=`, so its value is the word AFTER it. */
const FLAG_ONLY = /^-{1,2}[A-Za-z0-9][^=\s]*$/u;

/**
 * A flag that names WHERE a thing is kept, not the thing: a `-file` / `-path` / `-dir` suffix (`--token-file`,
 * `--key-file`, `--cert-path`), or the two bare names that are paths by convention (`--key <path>`, `--config`). Under any
 * other flag the cutter cut (`--token`, `--password`, `--api-key`, `--secret`, `--auth*`) the next word is a value, even
 * when it looks like a path: it is never a place. An unknown flag is not a pointer flag (fail closed).
 */
const POINTER_FLAG = /^-{1,2}(?:key|config|[A-Za-z0-9][A-Za-z0-9_.-]*[-_.](?:files?|paths?|dirs?))$/iu;

/**
 * Whether a part the cutter cut is one path and nothing else (`--token-file ~/.config/tool/token`,
 * `--key /home/u/.ssh/id_ed25519`): where a credential is kept, which the write rule accepts under a credential name.
 * It is a place only as the word right after a POINTER flag word (never after `--token`, `KEY=` or `Header:`), only a real
 * path of more than one segment (never `/x` or `~x`), with no pointer, query, fragment, user, scheme or pair in it, and no
 * segment the token test refuses on its own: a segment that is a value is a value. A URL is never a place.
 */
function isPlace(part: string, flagBefore: string | undefined): boolean {
  return (
    flagBefore !== undefined &&
    FLAG_ONLY.test(flagBefore) &&
    POINTER_FLAG.test(flagBefore) &&
    PLACE.test(part) &&
    !NOT_IN_A_PLACE.test(part) &&
    !part.split('/').some(segment => looksSecret('', segment)) &&
    !shownWord(part, undefined).hidden
  );
}

/** The word right before `at` in `text` when a blank is between them, or `before` when `at` is the start. */
function wordBefore(text: string, at: number, before: string | undefined): string | undefined {
  if (at === 0) return before;
  return /\s/u.test(text[at - 1] ?? '') ? text.slice(0, at).trimEnd().split(/\s+/u).at(-1) : undefined;
}

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
    (isPointer(pointer) && rest.every(word => PLAIN_WORD.test(word) && !looksSecret('', word)))
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
    const part = text.slice(at, end);
    if (!pointerThenPlainWords(part) && !isPlace(part, wordBefore(text, at, before))) return true;
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
    words.some((word, index) => cutsAValue(word, words[index - 1])) ||
    // And a JSON document as ONE piece, from the word that starts it: it holds blanks, so word by word never reads it
    // whole (`--settings {"API_KEY": "v"}`), as the args form, where it is one argument, does.
    documentsWithheld(command)
  );
};

/** The most places a document may start in one command before it is withheld whole: each is read to the command's end. */
const MAX_DOCUMENT_STARTS = 16;

/** Whether any JSON document in `command`, read as one piece, has a cut that is a value. Many starts: withheld (bounded). */
function documentsWithheld(command: string): boolean {
  const documents = documentsIn(command);
  return documents.length > MAX_DOCUMENT_STARTS || documents.some(([document, before]) => cutsAValue(document, before));
}

/** A word that starts a JSON document: `{`, `[`, a quote and `{`, or a flag glued to either (`--settings={`). */
const DOCUMENT_START = /^(?:[^\s=]*=)?(["']?)[{[]/u;

/**
 * Each place a JSON document starts in `command`: the text from the word that starts it to the end of the command (and,
 * when a quote opens it, to that quote's last mark too), with the word before it.
 */
function documentsIn(command: string): readonly (readonly [string, string | undefined])[] {
  const found: (readonly [string, string | undefined])[] = [];
  let before: string | undefined;
  for (const word of command.matchAll(/\S+/gu)) {
    if (found.length > MAX_DOCUMENT_STARTS) break;
    const start = DOCUMENT_START.exec(word[0]);
    if (start !== null) {
      const rest = command.slice(word.index);
      found.push([rest, before]);
      const quote = start[1] ?? '';
      const quoted = quote === '' ? -1 : rest.lastIndexOf(quote);
      if (quoted > start[0].length) found.push([rest.slice(0, quoted + 1), before]);
    }
    before = word[0];
  }
  return found;
}

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
