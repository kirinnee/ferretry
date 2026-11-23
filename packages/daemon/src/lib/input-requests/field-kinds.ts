import type { InputBrowserFieldFacts } from '@ferretry/protocol';

/**
 * WHAT A PAGE FIELD IS, from what the page says it is (docs/input-requests.md, "One-time codes and card fields").
 *
 * - `code`: a one-time code, on the page's own evidence for THAT field and nothing else: `autocomplete="one-time-code"`;
 *   or a numeric keypad (`inputmode` numeric, tel or decimal) with a `maxlength` of 4 to 8 and no password signal (a
 *   password-typed input, an autocomplete, name or id that says password, pass, pwd or pin). A name or a label that says
 *   "code" is NOT evidence: a reusable password can sit in a text box called "code", and the ferret's own words (the
 *   label, the prompt) never downgrade a secret. The owner types it and the ferret may see it.
 * - `card`: a card number, expiry or security code (`autocomplete` cc-number, cc-exp, cc-exp-month, cc-exp-year,
 *   cc-csc, or a name, id or label that says so). A `secret`.
 *
 * A card word wins over a code word ("security code" on a card form is a CVC). A `type=password` input is never read as a
 * code here: the callers decide what a password-typed field is.
 */
export type PageFieldKind = 'code' | 'card';

const CARD_AUTOCOMPLETE = /(?:^|\s)cc-(?:number|exp|exp-month|exp-year|csc)(?:\s|$)/iu;
const CARD_WORDS =
  /card[\s._-]*(?:number|num|no)\b|cc[\s._-]*(?:num|number|exp|expiry|csc|cvc|cvv)|\bcvc\b|\bcvv\b|\bcsc\b|\bcvn\b|expir(?:y|ation|es)|exp[\s._-]*(?:date|month|year)/iu;
const CODE_AUTOCOMPLETE = /(?:^|\s)one-time-code(?:\s|$)/iu;
/** A page field that says password, in any of the words a page uses: it is never read as a one-time code on a keypad's evidence. */
const PASSWORD_SIGNAL = /pass|pwd|(?:^|[^a-z])pin(?:[^a-z]|$)/iu;
const KEYPAD = /^(?:numeric|tel|decimal)$/iu;

/** Whether the page's own words for a field (never the ferret's) put it among codes or card fields. */
export function pageFieldKind(
  field: InputBrowserFieldFacts['field'],
  /** The card's label for the field: the ferret's words, used only as one more sign. */
  label?: string,
): PageFieldKind | undefined {
  // The card words may read the ferret's label too: they only ever RAISE a field to a secret.
  const words = [field.name, field.id, label].filter((word): word is string => word !== undefined);
  if (field.autocomplete !== undefined && CARD_AUTOCOMPLETE.test(field.autocomplete)) return 'card';
  if (words.some(word => CARD_WORDS.test(word))) return 'card';
  if (field.type?.toLowerCase() === 'password') return undefined;
  if (/password/iu.test(field.autocomplete ?? '')) return undefined;
  if (field.autocomplete !== undefined && CODE_AUTOCOMPLETE.test(field.autocomplete)) return 'code';
  const length = field.maxlength === undefined ? Number.NaN : Number(field.maxlength);
  const signalled = [field.name, field.id, field.autocomplete].some(
    word => word !== undefined && PASSWORD_SIGNAL.test(word.normalize('NFKC')),
  );
  if (KEYPAD.test(field.inputmode ?? '') && length >= 4 && length <= 8 && !signalled) return 'code';
  return undefined;
}
