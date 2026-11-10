/**
 * What a read of a configuration file SHOWS (cfg-leak, CFG-LEAK-R, S6 "no route, command or API returns a secret
 * value"). Both doors that return a file's text — `GET /v1/config/file` and the agent's `config_read` — ask this one
 * function, so the same text is shown to every caller: a ferret's token, a `--limited` device, the owner's paired
 * device and the host admin alike. WHO may read a file is Gate's answer; WHAT a read shows is the kernel's, and it has
 * no "raw" class: the owner at the machine reads the raw file with their editor.
 *
 * - A text that holds a raw secret, or is over the cap, or that no mask can prove safe, is WITHHELD whole.
 * - Any other text is shown with each value that a credential name or a token shape marks cut to `‹hidden›`: per part,
 *   value only (a flag's spelling, a key's name, a URL's user and host stay). The words are cut by the kernel's copy of
 *   runtimes' word cutter ({@link shownWord}); the rest of the text is rebuilt by `editConfigText`, which sets only the
 *   scalars that changed: every comment, the key order and the block layout stay, and the YAML library's round trip
 *   normalises the spacing of a flow list and before a trailing comment. A text with nothing to hide is returned as it
 *   is, byte for byte.
 * - The mask is never written back: a write that holds more `‹hidden›` than the file on disk is refused
 *   (`judgeWrite` in `service.ts`).
 *
 * Pure.
 */
import { configTextTooLarge, editConfigText, readConfigText } from '@ferretry/std/yaml';
import { checkConfigText, type ConfigIssue, MAX_CONFIG_ISSUES, moreIssues } from './check.ts';
import type { AnyConfigDef as ConfigDef } from './claims.ts';
import { HIDDEN_VALUE_TEXT, looksSecret, shownWord, shownWords } from './secret-words.ts';
import { rawTextHoldsSecret } from './secrets.ts';

/** Why a text is not shown at all. */
export type WithheldReason = 'raw_secret' | 'too_large' | 'unmaskable';

export type ShownConfigText =
  /** The text as it may be shown; `hidden` is where a value was cut (the line in the SHOWN text), one per scalar. */
  | { readonly kind: 'shown'; readonly text: string; readonly hidden: readonly { readonly line: number }[] }
  | { readonly kind: 'withheld'; readonly reason: WithheldReason };

/** Why, as the half sentence both doors say after "its text is not shown because". */
export const WITHHELD_WORDS: Readonly<Record<WithheldReason, string>> = {
  raw_secret: 'it holds a raw secret, which the owner must move into the secret store',
  too_large: 'it is larger than a configuration file may be',
  unmaskable: 'a value in it could not be hidden safely',
};

/** What `config_read` adds to its summary when it hid values: how many, and that they stay unless the edit changes them. */
export const hiddenCountWords = (count: number): string =>
  count === 1
    ? `1 value in it is hidden (${HIDDEN_VALUE_TEXT}) and stays as it is unless your edit changes it`
    : `${String(count)} values in it are hidden (${HIDDEN_VALUE_TEXT}) and stay as they are unless your edit changes them`;

/** What the route answers in place of a withheld text: one comment line, so a save of it is refused and never wipes the file. */
export const withheldComment = (reason: WithheldReason): string =>
  `# ${HIDDEN_VALUE_TEXT}: the text of this file is not shown because ${WITHHELD_WORDS[reason]}; edit it at the machine\n`;

/** The one error issue that says the same, beside a withheld text. */
export const withheldIssue = (path: string, reason: WithheldReason): ConfigIssue => ({
  path,
  severity: 'error',
  message: `the text of this file is not shown because ${WITHHELD_WORDS[reason]}`,
  fix: 'edit the file at the machine',
});

/**
 * One warning per hidden value, at its line, capped like every answer's problems (the rest counted in one sentence).
 * Never the value, and never anything from around it.
 */
export function hiddenValueIssues(
  path: string,
  hidden: readonly { readonly line: number }[],
  binary: string,
): readonly ConfigIssue[] {
  const listed = hidden.slice(0, MAX_CONFIG_ISSUES).map(
    ({ line }): ConfigIssue => ({
      path,
      line,
      column: 1,
      severity: 'warning',
      message: `a value on this line is hidden from every device and agent (${HIDDEN_VALUE_TEXT}); it is kept as it is unless you change it here`,
      fix: `${binary} secret set NAME, then write \${secret:NAME} in its place — or edit the file at the machine`,
    }),
  );
  return hidden.length > listed.length ? [...listed, moreIssues(path, hidden.length - listed.length)] : listed;
}

/** A value whose name is the name of a secret (`GITHUB_TOKEN` names one; it does not hold one). */
const SECRET_NAME_GRAMMAR = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** A string that holds white space. */
const HAS_BLANK = /\s/u;

/** A run of white space, kept by a split. */
const BLANK_RUN = /(\s+)/u;

/** The shortest cut part searched for in the shown text: a shorter one would match everywhere. */
const MIN_SEARCHED_LENGTH = 8;

/** The most distinct cut parts searched for; more than this is withheld, so the search stays bounded. */
const MAX_SEARCHED_PARTS = 100;

/** A cut scalar: where it is, what it was and what it is shown as. */
interface Cut {
  readonly path: readonly (string | number)[];
  readonly original: string;
  readonly shown: string;
}

/** A string outside a list: cut whole under a secret name, else read as a word and, with blanks in it, as a command line. */
function shownString(value: string, key: string | undefined): string {
  if (key !== undefined && !SECRET_NAME_GRAMMAR.test(value) && looksSecret(key, value)) return HIDDEN_VALUE_TEXT;
  const whole = shownWord(value, undefined).text;
  if (!HAS_BLANK.test(whole)) return whole;
  const parts = whole.split(BLANK_RUN);
  const words = shownWords(parts.filter((_, index) => index % 2 === 0));
  return parts.map((part, index) => (index % 2 === 0 ? (words[index / 2]?.text ?? part) : part)).join('');
}

/** The value with every string as it may be shown, and the scalars that changed. */
function maskedValue(value: unknown): { readonly value: unknown; readonly cuts: readonly Cut[] } {
  const cuts: Cut[] = [];
  const record = (path: readonly (string | number)[], original: string, shown: string): string => {
    if (shown !== original) cuts.push({ path, original, shown });
    return shown;
  };
  const walk = (node: unknown, path: readonly (string | number)[]): unknown => {
    const key = path.findLast(part => typeof part === 'string');
    if (typeof node === 'string') return record(path, node, shownString(node, key));
    if (Array.isArray(node)) {
      // A list of strings is read as a command line: each word is judged with the word before it.
      return node.map((item: unknown, index) => {
        const here = [...path, index];
        if (typeof item !== 'string') return walk(item, here);
        const before = node[index - 1];
        const secretKey = key !== undefined && !SECRET_NAME_GRAMMAR.test(item) && looksSecret(key, item);
        return record(
          here,
          item,
          secretKey ? HIDDEN_VALUE_TEXT : shownWord(item, typeof before === 'string' ? before : undefined).text,
        );
      });
    }
    if (node !== null && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([name, item]) => [name, walk(item, [...path, name])]));
    return node;
  };
  const masked = walk(value, []);
  return { value: masked, cuts };
}

/**
 * What `original` lost to `shown`: the text between its `‹hidden›` marks, read back by the pieces that stay. The pieces
 * are in the original in order, so each is found after the one before; the last is anchored at the end.
 */
function removedParts(original: string, shown: string): readonly string[] {
  const pieces = shown.split(HIDDEN_VALUE_TEXT);
  const parts: string[] = [];
  let at = (pieces[0] ?? '').length;
  pieces.slice(1).forEach((piece, index, rest) => {
    const end = index === rest.length - 1 ? original.length - piece.length : original.indexOf(piece, at);
    parts.push(original.slice(at, end));
    at = end + piece.length;
  });
  return parts;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The text as a read of it may show it.
 *
 * 1. Over the cap: withheld, unread. 2. It fails its check because it holds a raw secret, or its def is credential
 * records, or it does not parse and its raw text holds a secret: withheld. 3. Otherwise each string is cut where it
 * looks like a credential, and the text is rebuilt around the cut values. 4. If any cut part is still anywhere in the
 * shown text (an alias, a comment, a quoting quirk) the text is withheld too: a mask that may have missed something
 * shows nothing at all.
 */
export function shownConfigText(def: ConfigDef, path: string, text: string, binary: string): ShownConfigText {
  if (configTextTooLarge(text)) return { kind: 'withheld', reason: 'too_large' };
  const checked = checkConfigText(def, path, text, binary);
  if (
    !checked.ok &&
    (checked.reason === 'raw_secret' ||
      // A def of credential records never shows the text of a file that fails its check, whatever the reason: no check of
      // such a file can vouch that its text holds no secret. Any other def shows a failing file unless it does not parse
      // and its raw text holds a secret.
      def.credentialRecords === true ||
      (checked.reason === 'yaml' && rawTextHoldsSecret(text)))
  )
    return { kind: 'withheld', reason: 'raw_secret' };
  const read = readConfigText(text);
  if (!read.ok) return { kind: 'shown', text, hidden: [] };
  const { value, cuts } = maskedValue(read.read.value);
  if (cuts.length === 0) return { kind: 'shown', text, hidden: [] };
  if (!isPlainObject(value)) return { kind: 'withheld', reason: 'unmaskable' };
  const shown = editConfigText(text, value, read.read.value, undefined);
  const searched = new Set(
    cuts
      .flatMap(cut => removedParts(cut.original, cut.shown))
      .filter(part => part.length >= MIN_SEARCHED_LENGTH && !part.includes(HIDDEN_VALUE_TEXT)),
  );
  if (searched.size > MAX_SEARCHED_PARTS || [...searched].some(part => shown.includes(part)))
    return { kind: 'withheld', reason: 'unmaskable' };
  const located = readConfigText(shown);
  return {
    kind: 'shown',
    text: shown,
    hidden: cuts.map(cut => ({ line: (located.ok ? located.read.locate(cut.path)?.line : undefined) ?? 1 })),
  };
}
