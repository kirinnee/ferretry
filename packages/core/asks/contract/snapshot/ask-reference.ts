/**
 * How an ask (an agenda item, `A3`) is cited in text: the ONE place the attention sigil is spelled.
 *
 * `^A3`. Not `!A3`: a line that starts with `!` is a shell command in Claude Code and Codex, which has
 * swallowed a reference before. Every emitter formats through {@link askReference}; the reference grammar
 * (`packages/app/src/references/grammar.ts`, docs/reference-standard.md) imports the same constants.
 */

/** The sigil every emitter writes. */
export const ASK_REFERENCE_SIGIL = '^';

/** The sigil texts written before the change still carry. READ as an alias, never written. */
export const ALIAS_ASK_REFERENCE_SIGIL = '!';

/** `A3` → `^A3`. */
export const askReference = (id: string): string => `${ASK_REFERENCE_SIGIL}${id}`;

/**
 * A regex character class (for the `u` flag) matching either sigil: what a READER accepts. Writers use
 * {@link askReference} only.
 */
export const ASK_REFERENCE_SIGIL_CLASS = `[${[ASK_REFERENCE_SIGIL, ALIAS_ASK_REFERENCE_SIGIL]
  .map(sigil => sigil.replace(/[\\\]^-]/gu, '\\$&'))
  .join('')}]`;

const LEADING_SIGIL = new RegExp(`^(?:\\?|${ASK_REFERENCE_SIGIL_CLASS})`, 'u');

/** What a person typed as an ask id, minus its sigil: `^A3`, the legacy `!A3` or the older `?A3` all read as `A3`. */
export const stripAskReferenceSigil = (value: string): string => value.trim().replace(LEADING_SIGIL, '');
