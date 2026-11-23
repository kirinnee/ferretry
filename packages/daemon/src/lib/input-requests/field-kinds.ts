import type { InputBrowserFieldFacts } from '@ferretry/protocol';

/**
 * WHAT A PAGE FIELD IS, from what the page says it is (docs/input-requests.md, "One-time codes and card fields").
 *
 * - `code`: a one-time code. `autocomplete="one-time-code"`; or a numeric keypad (`inputmode` numeric, tel or decimal)
 *   with a `maxlength` of 4 to 8; or a name, id or label that says otp, code, verification, 2fa or one-time. The owner
 *   types it and the ferret may see it, so it is never offered as a password.
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
const CODE_WORDS =
  /otp|totp|2fa|mfa|verif|one[\s._-]*time|passcode|auth(?:enticator)?[\s._-]*code|(?:^|[^a-z])code(?:[^a-z]|$)/iu;
/** A "code" that is not a one-time one. */
const NOT_ONE_TIME =
  /zip|postal|post[\s._-]*code|promo|coupon|voucher|discount|country|area|currency|referral|invite/iu;
const KEYPAD = /^(?:numeric|tel|decimal)$/iu;

/** Whether the page's own words for a field (never the ferret's) put it among codes or card fields. */
export function pageFieldKind(
  field: InputBrowserFieldFacts['field'],
  /** The card's label for the field: the ferret's words, used only as one more sign. */
  label?: string,
): PageFieldKind | undefined {
  const words = [field.name, field.id, label].filter((word): word is string => word !== undefined);
  if (field.autocomplete !== undefined && CARD_AUTOCOMPLETE.test(field.autocomplete)) return 'card';
  if (words.some(word => CARD_WORDS.test(word))) return 'card';
  if (field.type?.toLowerCase() === 'password') return undefined;
  if (field.autocomplete !== undefined && CODE_AUTOCOMPLETE.test(field.autocomplete)) return 'code';
  const length = field.maxlength === undefined ? Number.NaN : Number(field.maxlength);
  if (KEYPAD.test(field.inputmode ?? '') && length >= 4 && length <= 8) return 'code';
  if (words.some(word => NOT_ONE_TIME.test(word))) return undefined;
  return words.some(word => CODE_WORDS.test(word)) ? 'code' : undefined;
}
