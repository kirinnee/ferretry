import { looksSecret, MIN_SECRET_VALUE_LENGTH, SECRET_TOKEN_SOURCE } from '@ferretry/core-vault/contract';

/*
 * `redactText` exactly as it stands today (4.291.5, `packages/daemon/src/lib/fleet/catalog.ts` at bb89d054d), frozen
 * here as the S26 oracle (`redact-differential.test.ts`). It shares `looksSecret` with the code under test, as the
 * frozen floor of today's own S26 test did. Do not "fix" it, not even its one known leak (`PASSWORD⏎= |⏎  value`,
 * ruling #36): the real one is changed instead, and the differential holds it to hide at least what this hides.
 */

/** What a hidden value is replaced by in a component's text. */
const HIDDEN_TEXT = '‹hidden›';

/**
 * `NAME=value`, `name: value`, `"name": "value"` — a value with the name that says what it is, on ONE line (a
 * name at the end of a line never takes the next line's text, so `db:⏎  pass: x` reads `pass: x`).
 *
 * LINEAR: a name starts only where a run of name characters starts (the look-behind), after any leading digits,
 * dots and dashes (`9TOKEN=…`, `-=TOKEN=…`), so a long run with no separator after it is scanned once, not once
 * from every character in it. The value is only LOOKED AT (a capped look-ahead) and consumed once it is hidden, so a
 * value that is no secret, or a hidden one that is a name with its separator (`auth: KEY="x"`), is searched for a name
 * of its own (`Q= apikey:x`).
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])([0-9.-]*)([A-Za-z_][A-Za-z0-9_.-]*)(["']?[ \t]*[:=][ \t]*["']?)(?=([^\s"'`,;)}\]]{1,1024}))/gu;
const VALUE_RUN = /[^\s"'`,;)}\]]+/uy;

/** One bare word of text, for a value whose own shape says it is a token. */
const WORD = /[^\s"'`,;()[\]{}<>]+/gu;
/**
 * A private-key block (its header, the base64 body and its footer when there is one) and any well-known token
 * ({@link SECRET_TOKEN_SOURCE}), wherever either stands: no name, separator or word boundary is needed. Every
 * part is a linear class, so a long run of one costs a single pass.
 */
const CONTEXT_FREE_SECRET = new RegExp(
  `-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\\s]*(?:-----END [A-Z ]{0,40}PRIVATE KEY-----)?|${SECRET_TOKEN_SOURCE}`,
  'gu',
);

/** A line that ends in a name and its separator (`password =`), or opens a block value (`password: |`, `token: >-`). */
const OPENS_VALUE = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*[:=]([ \t]*[|>][-+0-9]*)?[ \t]*$/u;
/** A line that ends in a name and nothing else, for a separator that starts the next line (`PASSWORD⏎= x`). */
const NAME_ENDS = /(?:^|[^A-Za-z0-9_.-])["']?([A-Za-z0-9_.-]+)["']?[ \t]*$/u;
const STARTS_WITH_SEPARATOR = /^[ \t]*[:=][ \t]*/u;
const BLOCK_INDICATOR = /^[|>][-+0-9]*$/u;
const LINE_BREAKS = /(\r\n|\r|\n)/u;
const FIRST_VALUE = /^([ \t]*["']?)([^\s"'`,;)}\]]*[A-Za-z0-9][^\s"'`,;)}\]]*)/u;
/** A line that is a key of its own (`login_page: x`), and so is not the value of the name above it. */
const KEY_LINE = /^[ \t]*["']?[A-Za-z_][A-Za-z0-9_.-]*["']?[ \t]*:(?:[ \t]|$)/u;
/**
 * A value that only points at one (`$HOME`, `${TOKEN}`, `${secret:TOKEN}`), whole up to the next space. A
 * `${NAME-default}` is no pointer: its default is a value, read as the value of NAME ({@link redactExpansions}).
 */
const POINTER = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{(?:secret:)?[A-Za-z_][A-Za-z0-9_.]*\})$/u;
/**
 * `${NAME<op>default}` with op `:-` `-` `:=` `=` `:+` `+` `:?` `?`: the default is read as the value of NAME. Only
 * LOOKED AT here (a capped look-ahead); the whole default run is consumed once it is hidden.
 */
const EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_.]*):?[-=+?]["']?(?=([^}\s"'`]{1,1024}))/gu;
const DEFAULT_RUN = /[^}\s"'`]+/uy;
const MAX_POINTER = 256;
/** A value that only a name which announces a secret hides: the block under any other name is no secret's. */
const BLOCK_PROBE = 'x'.repeat(MIN_SECRET_VALUE_LENGTH);
/** What ASSIGNMENT leaves out of a name too: `9TOKEN` is the name `TOKEN`. */
const LEADING_DIGITS = /^[0-9.-]+/u;
/** The separator that a value carries when a line break comes between it and its name (`ghp_x⏎=ghp_y`). */
const LEADING_SEPARATORS = /^[=:&?|/$@]+/u;
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Whether the value found at `start` of `text` is the start of a pointer (`${secret:TOKEN}`), not a secret. */
function isPointer(text: string, start: number): boolean {
  const word = /^\S+/u.exec(text.slice(start, start + MAX_POINTER + 1))?.[0] ?? '';
  return word.length <= MAX_POINTER && POINTER.test(word);
}

const ALPHANUMERIC = /[A-Za-z0-9]/u;
const DIGIT = /[0-9]/u;

/**
 * Whether a match of {@link CONTEXT_FREE_SECRET} is a secret and not a word that merely ends the way a token starts
 * (`task-plan-ended`, `risk-assessment-notes`, `vosk-model-small-en-us-0`): a private-key block always is; a token is
 * one only when no letter or digit stands before it and its body holds a digit. Decided on the match, because a
 * look-behind or look-ahead in the pattern is quadratic on `sk-sk-sk-…`.
 */
function isContextFreeSecret(match: string, offset: number, whole: string): boolean {
  if (match.startsWith('-----BEGIN')) return true;
  return !ALPHANUMERIC.test(whole.charAt(offset - 1)) && DIGIT.test(match);
}

/**
 * Where the value of a name that ends its line is: the line it is on and how far in, whether it opens a block
 * scalar, and the name. The name ends the line itself (`password =`, `password: |`), or stands alone with its
 * separator starting the next line (`PASSWORD⏎= x`).
 */
function opening(
  parts: readonly string[],
  index: number,
): { name: string; block: boolean; line: number; from: number } | undefined {
  const next = (after: number): number => {
    let at = after + 2;
    while (at < parts.length && (parts[at] ?? '').trim() === '') at += 2;
    return at;
  };
  const line = parts[index] ?? '';
  const opens = OPENS_VALUE.exec(line);
  const opened = opens?.[1]?.replace(LEADING_DIGITS, '');
  if (opened) return { name: opened, block: opens?.[2] !== undefined, line: next(index), from: 0 };
  const alone = NAME_ENDS.exec(line)?.[1]?.replace(LEADING_DIGITS, '');
  if (!alone) return undefined;
  const at = next(index);
  const separator = STARTS_WITH_SEPARATOR.exec(parts[at] ?? '');
  if (separator === null) return undefined;
  const rest = (parts[at] ?? '').slice(separator[0].length);
  if (rest.trim() === '') return { name: alone, block: false, line: next(at), from: 0 };
  if (BLOCK_INDICATOR.test(rest.trim())) return { name: alone, block: true, line: at, from: 0 };
  return { name: alone, block: false, line: at, from: separator[0].length };
}

/** Whether the name at `at` is the inside of a pointer (`${secret:TOKEN}`), which is no name and value. */
const insidePointer = (text: string, at: number): boolean =>
  at >= 2 && text.startsWith('${', at - 2) && isPointer(text, at - 2);

/**
 * The value of a name that ends its line, on the lines after it (`password:⏎hunter2`, `password =⏎x`,
 * `PASSWORD⏎= x`, and a block `password: |⏎  x`). A name is read as it was written (a value after it on its line
 * may be hidden by now), and a next line that is a key of its own is read on its own. One pass
 * over the lines, each read once: the block under a name that announces a secret is read as a whole, and a block
 * opened inside it is not read again (it ends inside it, and what the outer name hides the inner one cannot
 * show), and the block under any other name is not read at all.
 */
function redactNextLines(
  original: string,
  text: string,
  isSecret: (name: string, value: string) => boolean,
): { readonly text: string; readonly redacted: boolean } {
  const parts = text.split(LINE_BREAKS);
  const asWritten = original.split(LINE_BREAKS);
  let redacted = false;
  let covered = -1;
  for (let index = 0; index < parts.length; index += 2) {
    const opens = opening(asWritten, index);
    if (opens === undefined) continue;
    if (!opens.block) {
      const line = parts[opens.line] ?? '';
      const rest = line.slice(opens.from);
      const value = FIRST_VALUE.exec(rest);
      if (value?.[2] === HIDDEN_TEXT) continue;
      const start = opens.from + (value?.[1]?.length ?? 0);
      // A token already hidden at the head of the run (`ghp_x{y`) leaves the rest of its run showing: hide that too.
      const headHidden = value?.[2]?.startsWith(HIDDEN_TEXT) === true;
      if (
        value === null ||
        (!headHidden &&
          ((opens.from === 0 && KEY_LINE.test(rest)) ||
            isPointer(line, start) ||
            !isSecret(opens.name, value[2] ?? '')))
      ) {
        continue;
      }
      parts[opens.line] = `${line.slice(0, start)}${HIDDEN_TEXT}${line.slice(opens.from + value[0].length)}`;
      redacted = true;
      continue;
    }
    if (index <= covered || !isSecret(opens.name, BLOCK_PROBE)) continue;
    const indent = indentOf(parts[index] ?? '');
    let last = index;
    for (let next = index + 2; next < parts.length; next += 2) {
      const line = parts[next] ?? '';
      if (line.trim() === '') continue;
      if (indentOf(line) <= indent) break;
      last = next;
      if (!isSecret(opens.name, line.trim())) continue;
      parts[next] = `${line.slice(0, indentOf(line))}${HIDDEN_TEXT}`;
      redacted = true;
    }
    covered = last;
  }
  return { text: parts.join(''), redacted };
}

/** The default of every `${NAME<op>default}` in `text` that is a secret when NAME holds it, hidden. */
function redactExpansions(
  text: string,
  isSecret: (name: string, value: string) => boolean,
): { readonly text: string; readonly redacted: boolean } {
  let out = '';
  let from = 0;
  let redacted = false;
  EXPANSION.lastIndex = 0;
  for (let found = EXPANSION.exec(text); found !== null; found = EXPANSION.exec(text)) {
    const start = found.index + found[0].length;
    const value = found[2] ?? '';
    if (start < from || value.startsWith(HIDDEN_TEXT) || !isSecret(found[1] ?? '', value)) continue;
    DEFAULT_RUN.lastIndex = start;
    const end = start + (DEFAULT_RUN.exec(text)?.[0].length ?? 0);
    out += `${text.slice(from, start)}${HIDDEN_TEXT}`;
    from = end;
    EXPANSION.lastIndex = end;
    redacted = true;
  }
  return { text: out + text.slice(from), redacted };
}

/**
 * A component's text with every secret-looking value replaced by {@link HIDDEN_TEXT}. `isSecret` is the rule for
 * a value beside its name (the fleet's `looksSecret` unless a caller needs a stricter one).
 */
export function redactTodayText(
  text: string,
  isSecret: (name: string, value: string) => boolean = looksSecret,
): { readonly text: string; readonly redacted: boolean } {
  let redacted = false;
  let named = '';
  let from = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let found = ASSIGNMENT.exec(text); found !== null; found = ASSIGNMENT.exec(text)) {
    const start = found.index + found[0].length;
    const value = found[4] ?? '';
    if (start < from || BLOCK_INDICATOR.test(value) || isPointer(text, start) || insidePointer(text, found.index)) {
      continue;
    }
    if (!isSecret(found[2] ?? '', value)) continue;
    VALUE_RUN.lastIndex = start;
    const end = start + (VALUE_RUN.exec(text)?.[0].length ?? 0);
    named += `${text.slice(from, start)}${HIDDEN_TEXT}`;
    from = end;
    ASSIGNMENT.lastIndex = start;
    redacted = true;
  }
  named += text.slice(from);
  const expanded = redactExpansions(named, isSecret);
  redacted = redacted || expanded.redacted;
  const bare = expanded.text.replace(WORD, word => {
    if (looksSecret('', word)) {
      redacted = true;
      return HIDDEN_TEXT;
    }
    const held = word.replace(LEADING_SEPARATORS, '');
    if (held === word || !looksSecret('', held)) return word;
    redacted = true;
    return `${word.slice(0, word.length - held.length)}${HIDDEN_TEXT}`;
  });
  const lines = redactNextLines(text, bare, isSecret);
  const cut = lines.text.replace(CONTEXT_FREE_SECRET, (match, offset: number, whole: string) => {
    if (!isContextFreeSecret(match, offset, whole)) return match;
    redacted = true;
    return HIDDEN_TEXT;
  });
  return { text: cut, redacted: redacted || lines.redacted };
}
