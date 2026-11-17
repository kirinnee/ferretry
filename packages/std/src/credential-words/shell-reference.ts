/**
 * A shell reference, read once for the write rule (`write-rule.ts`) and for the display-side cutters that must agree with it.
 *
 * A configuration value may name an environment variable instead of holding one: `$NAME`, `${NAME}`, `${secret:NAME}`
 * and `${secret?:NAME}` are POINTERS, and carry no literal. `${NAME<op>literal}` is a shell default: it carries a
 * LITERAL, and a literal can be a credential. `<op>` is `:-` `-` `:=` `=` `:+` `+` (the literal is what the value
 * becomes) or `:?` `?` (the literal is the message printed when NAME is unset, and is never a value).
 *
 * The write rule judges a default's LITERAL alone, never the whole text: a long, plain NAME must not dilute a random
 * literal, and a harmless literal (empty, a path, a message) must not be refused for the key it is written under.
 *
 * Pure and linear: one pass over the text, no backtracking pattern over the literal.
 */

/** The operator of a shell default, as written. */
export type ShellDefaultOperator = ':-' | '-' | ':=' | '=' | ':+' | '+' | ':?' | '?';

/** A value that names a variable and holds nothing: `$NAME`, `${NAME}`, `${secret:NAME}`, `${secret?:NAME}`. */
export interface ShellPointer {
  readonly kind: 'pointer';
}

/** A shell default: the literal between the operator and the closing brace, with its nested braces balanced. */
export interface ShellDefault {
  readonly kind: 'default';
  readonly operator: ShellDefaultOperator;
  readonly literal: string;
}

export type ShellReference = ShellPointer | ShellDefault;

/** The pointers: anchored at both ends, one class run per branch, so each is tried from one start and ends one way. */
const POINTER_FORM = /^\$(?:\{(?:secret\??:)?[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/u;

/** The head of a default: `${`, the NAME and the operator. Linear: anchored, one class run, one short alternation. */
const DEFAULT_HEAD = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-|:=|:\?|:\+|-|=|\?|\+)/u;

/**
 * Reads `text` as ONE whole shell reference, or `undefined` when it is not exactly one (plain text, or a reference with
 * text around it or after it: `${A:-x}-${B:-y}`). The closing brace must be the last character and match the opening
 * one, counting the braces nested in the literal.
 */
export function parseShellReference(text: string): ShellReference | undefined {
  if (POINTER_FORM.test(text)) return { kind: 'pointer' };
  const head = DEFAULT_HEAD.exec(text);
  if (head === null || !text.endsWith('}')) return undefined;
  const operator = head[1] as ShellDefaultOperator;
  const start = head[0].length;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '{') depth += 1;
    else if (character === '}') {
      if (depth === 0)
        return index === text.length - 1 ? { kind: 'default', operator, literal: text.slice(start, index) } : undefined;
      depth -= 1;
    }
  }
  return undefined;
}

/** Whether `text` is a pointer and nothing else: a variable's NAME, with no literal in it. */
export function isShellPointer(text: string): boolean {
  return POINTER_FORM.test(text);
}

/** The head of a default again, read where `judgedText` stands rather than at the start of a slice. */
const DEFAULT_HEAD_AT = new RegExp(DEFAULT_HEAD.source.slice(1), 'uy');

/** For each `{` of `text`, the index of the `}` that closes it, or -1: one pass, so a nest of any depth costs its length. */
function braceMatches(text: string): Int32Array {
  const closes = new Int32Array(text.length).fill(-1);
  const open: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === '{') open.push(index);
    else if (character === '}') {
      const start = open.pop();
      if (start !== undefined) closes[start] = index;
    }
  }
  return closes;
}

/**
 * What a value holds that could be a credential once any shell reference in it is read for what it is: the text the
 * secret tests must judge.
 *
 * - a pointer, an empty default and an error message (`:?` `?`): `''` — nothing that is a value;
 * - a default with a literal (`:-` `-` `:=` `=` `:+` `+`): the literal, unwrapped again when it is a reference itself
 *   (`${A:-${B:-lit}}`), so a nested default is judged by its innermost literal;
 * - anything else, `text` trimmed as it is: a reference with text around it, or one that does not close, is judged
 *   whole, so nothing is let through for being unreadable.
 *
 * Linear whatever the depth: the braces are matched once, and each level only moves two offsets.
 */
export function judgedText(text: string): string {
  let from = 0;
  let to = text.length;
  let closes: Int32Array | undefined;
  for (;;) {
    while (from < to && text.charAt(from).trim() === '') from += 1;
    while (to > from && text.charAt(to - 1).trim() === '') to -= 1;
    DEFAULT_HEAD_AT.lastIndex = from;
    const head = DEFAULT_HEAD_AT.exec(text);
    if (head === null || text.charAt(to - 1) !== '}' || from + head[0].length > to - 1) {
      const rest = text.slice(from, to);
      return POINTER_FORM.test(rest) ? '' : rest;
    }
    closes ??= braceMatches(text);
    if (closes[from + 1] !== to - 1) return text.slice(from, to);
    const operator = head[1];
    if (operator === ':?' || operator === '?') return '';
    from += head[0].length;
    to -= 1;
  }
}
