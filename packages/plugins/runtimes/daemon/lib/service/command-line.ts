/**
 * THE rule for what a command-line word may show: a launch flag and an MCP argument, wherever one travels — the
 * Resolved view (`POST /v1/runtimes/profiles/preview`) and a component's detail (`GET /v1/runtimes/components`) — so
 * a credential a person wrote into a flag is cut the same way on every read, for every caller, the edit form's owner
 * included.
 *
 * A credential sits in a word in four ways:
 * - a word that IS a token (`sk-…`), anywhere, also quoted;
 * - a value glued to a secret-named flag (`--token=v`, `-k=v`, `--token v` in one word, `-Hv`), or the word after one
 *   (`--token`, `v`). The name is the flag's (`looksSecret` reads `--api-key` as the words API and KEY, so dashes
 *   need no stripping); the value is unquoted first, so `--token="$TOKEN"` stays the pointer it is; and a token is
 *   looked for at the start of every piece of the value, so `--header=Bearer sk-…` is caught under a harmless name;
 * - a secret-named key NESTED inside a value (ruling #40): `-c mcp_servers.x.env.API_KEY=v`,
 *   `--header=Authorization: Bearer v`, `X-Api-Key: v`, and a URL's secret-named query parameter (`?token=v`);
 * - the password of a URL's user (`scheme://user:PASS@host`).
 *
 * Only the VALUE is replaced: the flag's own spelling, a nested key's name, a URL's user and host and every other
 * parameter stay, because that is what tells a person which word it is. Every word today hid is still hidden: such a
 * word starts with a token prefix, so it is no flag and reaches the last test, whose `looksSecret` under any name
 * hides at least what it hides under none.
 *
 * NOT handled (declared GAPs): a JSON document inside a flag (`--settings '{"env":{"API_KEY":"v"}}'`, its keys are
 * quoted) and a plain password stuck to a one-letter flag (`-p<password>`: a single letter is no secret name).
 *
 * Pure.
 */
import { HIDDEN_WORD_TEXT } from '../../../contract/index.ts';
import { looksSecret, pointsElsewhere, secretNamed } from '../account/import.ts';
import { sha256Hex } from '../foreign.ts';

/** A word that is a flag on its own: one or two dashes and a name, with no value in it. */
const FLAG_WORD = /^-{1,2}[A-Za-z0-9][^=\s]*$/u;

/** A flag and its value in one word, glued by `=` or by spaces: `--token=v`, `-k=v`, `--token v`. */
const GLUED_VALUE = /^(-{1,2}[A-Za-z0-9][^=\s]*)(=|\s+)([\s\S]*)$/u;

/** A one-letter flag with its value stuck straight to it: `-Hv`. */
const STUCK_VALUE = /^(-[A-Za-z])([^-=\s][\s\S]*)$/u;

/** What splits a value into the pieces a token may start at: spaces, quotes and separators. */
const PIECE_BREAK = /[\s"'`:,;=]+/u;

/** A value inside one pair of matching quotes: the quote and what it holds. */
const QUOTED = /^(["'])([\s\S]*)\1$/u;

/** A value without one pair of matching quotes around it. */
const unquoted = (value: string): string => QUOTED.exec(value)?.[2] ?? value;

/** Whether a flag's value looks like a credential under the flag's name, or holds a token. */
function secretValue(name: string, value: string): boolean {
  return looksSecret(name, unquoted(value)) || value.split(PIECE_BREAK).some(piece => looksSecret('', piece));
}

// ── Nested inside a value (ruling #40) ───────────────────────────────────────────────────────────

/**
 * A name and its separator inside a value: `API_KEY=`, `Authorization: `, `X-Api-Key:`, `?token=`.
 *
 * LINEAR: a name starts only where a run of name characters starts (the look-behind), after any leading digits, dots
 * and dashes, so a long run with no separator after it is scanned once, not once from every character in it. A name
 * right after `${` is a pointer's (`${secret:NAME}`, `${NAME:-x}`), never a key.
 */
const NESTED_NAME = /(?<![A-Za-z0-9_.-]|\$\{)[0-9.-]*([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[:=][ \t]*/gu;

/** Where a nested value ends: the next parameter separator (`a=1,b=2`, `?a=1&b=2`, `a=1; b=2`), or the text's end. */
const NESTED_VALUE_END = /[,;&]/gu;

/**
 * The password of a URL's user, `scheme://user:PASS@`: the part before it, and it. A scheme starts only where a run
 * of scheme characters starts, and neither the user nor the password can hold the character that ends it.
 */
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@\s:]*:)([^/?#@\s]*)@/gu;

/** A text with each URL user's password cut, unless it only points at one. */
const withoutUrlPasswords = (text: string): string =>
  text.replace(URL_PASSWORD, (whole, before: string, password: string) =>
    password === '' || pointsElsewhere(password) ? whole : `${before}${HIDDEN_WORD_TEXT}@`,
  );

/** A text with the value of every secret-named key nested in it cut, the key and the separator kept. */
function withoutNestedValues(text: string): string {
  let out = '';
  let from = 0;
  NESTED_NAME.lastIndex = 0;
  for (let found = NESTED_NAME.exec(text); found !== null; found = NESTED_NAME.exec(text)) {
    const name = found[1] ?? '';
    if (!secretNamed(name)) continue;
    const start = found.index + found[0].length;
    NESTED_VALUE_END.lastIndex = start;
    const end = NESTED_VALUE_END.exec(text)?.index ?? text.length;
    // A secret-named key whose value is no secret (a pointer, too short) is passed over whole, so a run of keys is
    // read once.
    NESTED_NAME.lastIndex = Math.max(end, start + 1);
    if (!looksSecret(name, unquoted(text.slice(start, end).trim()))) continue;
    out += `${text.slice(from, start)}${HIDDEN_WORD_TEXT}`;
    from = end;
  }
  return `${out}${text.slice(from)}`;
}

/** A value with every nested credential cut (inside one pair of quotes, kept), or `undefined` when it holds none. */
function withoutNested(value: string): string | undefined {
  const quoted = QUOTED.exec(value);
  const inner = quoted?.[2] ?? value;
  const cut = withoutNestedValues(withoutUrlPasswords(inner));
  if (cut === inner) return undefined;
  return quoted === null ? cut : `${quoted[1] ?? ''}${cut}${quoted[1] ?? ''}`;
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export interface ShownWord {
  readonly text: string;
  readonly hidden: boolean;
}

/** One command-line word as it may be shown, judged with the word before it. */
export function shownWord(word: string, before: string | undefined): ShownWord {
  const hidden = (text: string): ShownWord => ({ text, hidden: true });
  const glued = GLUED_VALUE.exec(word);
  if (glued !== null) {
    const [, flag = '', separator = '', value = ''] = glued;
    if (secretValue(flag, value)) return hidden(`${flag}${separator}${HIDDEN_WORD_TEXT}`);
    const cut = withoutNested(value);
    if (cut !== undefined) return hidden(`${flag}${separator}${cut}`);
  }
  const stuck = STUCK_VALUE.exec(word);
  if (stuck !== null) {
    const [, flag = '', value = ''] = stuck;
    if (secretValue('', value)) return hidden(`${flag}${HIDDEN_WORD_TEXT}`);
    const cut = withoutNested(value);
    if (cut !== undefined) return hidden(`${flag}${cut}`);
  }
  const name = before !== undefined && FLAG_WORD.test(before) && !word.startsWith('-') ? before : '';
  if (secretValue(name, word)) return hidden(HIDDEN_WORD_TEXT);
  // A flag's own value was searched above; only a word that is no flag with a value is searched whole.
  const cut = glued === null && stuck === null ? withoutNested(word) : undefined;
  return cut === undefined ? { text: word, hidden: false } : hidden(cut);
}

/** A command line's words as they may be shown, in order; `first` is the word before the first (an MCP command). */
export const shownWords = (words: readonly string[], first?: string): readonly ShownWord[] =>
  words.map((word, index) => shownWord(word, index === 0 ? first : words[index - 1]));

/**
 * The etag of a list of words AS SHOWN: what an edit that keeps a hidden word by its position is checked against. It
 * is made of the shown words only, so it carries nothing the same read does not already show; it moves when a word is
 * added, removed, moved or changed where it can be seen. A hidden value retyped in place is kept as it now is, as an
 * environment `{ keep: true }` keeps the value the component has when the edit lands.
 */
export const shownWordsEtag = (shown: readonly ShownWord[]): string =>
  sha256Hex(JSON.stringify(shown.map(word => [word.text, word.hidden])));
