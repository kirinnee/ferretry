import type { InputBrowserFieldFacts } from '@ferretry/protocol';

/**
 * WHAT A PAGE FIELD IS, from what the page says it is (docs/input-requests.md, "One-time codes and card fields").
 *
 * - `code`: a one-time code, on the page's own evidence for THAT field and nothing else: `autocomplete="one-time-code"`;
 *   or a numeric keypad (`inputmode` numeric, tel or decimal) with a `maxlength` of 4 to 8 and no password signal (a
 *   password-typed input, or {@link passwordSignalled}). A name or a label that says "code" is NOT evidence: a reusable
 *   password can sit in a text box called "code". A password signal (pass, pwd, pin, ssn, security code, cvv, cvc, csc in
 *   the name, id, autocomplete or label, the ferret's too) and a field the ferret asked for as a secret ALWAYS win, also
 *   over `autocomplete="one-time-code"`; the ferret's label may only raise. The owner types it and the ferret may see it.
 * - `card`: a card number, expiry or security code (`autocomplete` cc-number, cc-exp, cc-exp-month, cc-exp-year,
 *   cc-csc, or a name, id or label that says so). A `secret`.
 *
 * A card word wins over a code word ("security code" on a card form is a CVC). A `type=password` input is never read as a
 * code here: the callers decide what a password-typed field is.
 */
export type PageFieldKind = 'code' | 'card';

const CARD_AUTOCOMPLETE = /(?:^|\s)cc-(?:number|exp|exp-month|exp-year|csc)(?:\s|$)/iu;
const CARD_WORDS =
  /card[\s._-]*(?:number|num|no)\b|cc[\s._-]*(?:num|number|exp|expiry|csc|cvc|cvv)|cvc|cvv|csc|cvn|expir(?:y|ation|es)|exp[\s._-]*(?:date|month|year)/iu;
const CODE_AUTOCOMPLETE = /(?:^|\s)one-time-code(?:\s|$)/iu;
/** A page field that says password, in any of the words a page uses: it is never read as a one-time code on a keypad's evidence. */
const PASSWORD_SIGNAL = /pass|pwd|pin|ssn|security[\s._-]*code|cv[vc]|csc/iu;
/** "One-time passcode" and "one-time password" name a code, not a password: they are not a signal. */
const ONE_TIME_PASS = /one[\s._-]*time[\s._-]*pass(?:code|word)?/giu;
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
  if (field.autocomplete !== undefined && CODE_AUTOCOMPLETE.test(field.autocomplete))
    return passwordSignalled(field, label) ? undefined : 'code';
  const length = field.maxlength === undefined ? Number.NaN : Number(field.maxlength);
  if (KEYPAD.test(field.inputmode ?? '') && length >= 4 && length <= 8 && !passwordSignalled(field, label))
    return 'code';
  return undefined;
}

/**
 * Whether anything on the field says secret: the substring set pass, pwd, pin, ssn, security code, cvv, cvc or csc in
 * its name, id, autocomplete or label (the page's or the ferret's). THE one definition: a signal ALWAYS wins, also over
 * `autocomplete="one-time-code"`, in the card's fill (service.ts) and the lock (lock.ts).
 */
export function passwordSignalled(field: InputBrowserFieldFacts['field'], label?: string): boolean {
  return [field.name, field.id, field.autocomplete, label].some(
    word => word !== undefined && PASSWORD_SIGNAL.test(word.normalize('NFKC').replace(ONE_TIME_PASS, '')),
  );
}
