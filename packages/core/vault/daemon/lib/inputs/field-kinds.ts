import type { InputSensitivity, PageFieldFacts } from '../../../contract/index.ts';

/**
 * WHAT A PAGE FIELD IS, from what the PAGE says it is for THAT field (never the ferret's words, except to raise a field
 * to a secret). Pure and total: facts in, a kind or nothing out.
 *
 * - `code`: a one-time code. `autocomplete="one-time-code"`; or a numeric keypad (`inputmode` numeric, tel or decimal)
 *   with a `maxlength` of 4 to 8; or a name, id or page label that says otp, code, verification, 2fa or one-time. Never
 *   when anything says password ({@link passwordSignalled}), whatever else the field says, and never for a field that
 *   says it is something else (a zip or promo code, a field with another `autocomplete`, a long free-text box).
 * - `card`: a card number, expiry or security code (`autocomplete` cc-number, cc-exp, cc-csc, or a name, id or label that
 *   says so, the ferret's label too). A `secret`. A card word wins over a code word ("security code" on a card is a CVC).
 *
 * A `type=password` input is neither: the callers decide what a password-typed field is.
 */
export type PageFieldKind = 'code' | 'card';

type Field = PageFieldFacts['field'];

const CARD_AUTOCOMPLETE = /(?:^|\s)cc-(?:number|exp|exp-month|exp-year|csc)(?:\s|$)/iu;
const CARD_WORDS =
  /card[\s._-]*(?:number|num|no)\b|cardnumber|cc[\s._-]*(?:num|number|exp|expiry|csc|cvc|cvv)|cvc|cvv|csc|cvn|expir(?:y|ation|es)|exp[\s._-]*(?:date|month|year)/iu;
const CODE_AUTOCOMPLETE = /(?:^|\s)one-time-code(?:\s|$)/iu;
/** A page field that says password, in any of the words a page uses. */
const PASSWORD_SIGNAL = /pass|pwd|ssn|security[\s._-]*code|cv[vc]|csc|mpin|pincode|pinnumber/iu;
/**
 * "Pin" as a word of its own, never inside another word (shipping, typing, spinner): at the start or after a non-letter
 * (pin, pin_code, card-pin, PIN), or as a camel-case word (userPin, cardPin). Case-sensitive on purpose: the capital P
 * marks a camel-case word, and the lookahead keeps "pinned" and "Pinterest" out.
 */
const PIN_WORD = /(?:^|[^A-Za-z])(?:pin|PIN|Pin)(?![a-z])|[a-z]Pin(?![a-z])/u;
/** "pin" ENDING a name, in any case (userPIN, cardpin, atmpin): "shipping", "typing", "opinion" and "pinned" stay out. */
const PIN_SUFFIX = /pin(?![a-z])/iu;
/** Phrases that name a code, not a password, even though they hold pass or pin: "one-time passcode", "totpPin". */
const ONE_TIME_WORDS = /one[\s._-]*time[\s._-]*pass(?:code|word)?|(?:t?otp|2fa|mfa)[\s._-]*(?:pin|pass(?:code)?)/giu;
const KEYPAD = /^(?:numeric|tel|decimal)$/iu;
/** The words a page uses for a one-time code: whole words or camel-case words, so "footprint" and "zipcode" stay out. */
const CODE_WORDS =
  /(?:^|[^a-z])(?:otp|totp|2fa|mfa)(?![a-z])|[a-z](?:Otp|OTP|Totp|TOTP)(?![a-z])|otp[\s._-]*(?:input|field|code|digit|value)|one[\s._-]*time|verif(?:y|ication)|authenticator|(?:^|[^a-z])code(?![a-z])|[a-z]Code(?![a-z])|\bsms\b/u;
/** Fields that are some other number or code: a zip, a promo, a date, a phone. */
const NOT_A_CODE =
  /zip|postal|post[\s._-]*code|promo|coupon|discount|referral|invite|gift|voucher|country|area|dial|sort|iban|swift|routing|captcha|barcode|year|month|\bday\b|dob|birth|amount|quantity|search|tax/iu;
/** The `type`s a one-time code can be typed into. */
const CODE_TYPES = /^(?:text|tel|number)?$/iu;
/** The longest a free-text box can be and still be read as a code by its words alone. */
const LONGEST_CODE_BY_WORDS = 10;

const words = (field: Field, ...more: readonly (string | undefined)[]): string[] =>
  [field.name, field.id, ...more].filter((word): word is string => word !== undefined);

/** Whether the page's own words for a field (its `label`, when the browser read one), plus the ferret's label for the card words, put it among codes or card fields. */
export function pageFieldKind(field: Field, ferretLabel?: string): PageFieldKind | undefined {
  // The card words may read the ferret's label too: they only ever RAISE a field to a secret.
  if (field.autocomplete !== undefined && CARD_AUTOCOMPLETE.test(field.autocomplete)) return 'card';
  if (words(field, field.label, ferretLabel).some(word => CARD_WORDS.test(word))) return 'card';
  if (field.type?.toLowerCase() === 'password' || /password/iu.test(field.autocomplete ?? '')) return undefined;
  if (passwordSignalled(field, ferretLabel) || !CODE_TYPES.test(field.type ?? '')) return undefined;
  if (field.autocomplete !== undefined && CODE_AUTOCOMPLETE.test(field.autocomplete)) return 'code';
  const length = field.maxlength === undefined ? Number.NaN : Number(field.maxlength);
  const other = words(field, field.label, field.autocomplete);
  const elsewhere = field.autocomplete !== undefined && !/^(?:on|off|)$/iu.test(field.autocomplete.trim());
  if (elsewhere || other.some(word => NOT_A_CODE.test(word))) return undefined;
  if (KEYPAD.test(field.inputmode ?? '') && length >= 4 && length <= 8) return 'code';
  const short = Number.isNaN(length) || length <= LONGEST_CODE_BY_WORDS;
  return short && words(field, field.label).some(word => CODE_WORDS.test(word)) ? 'code' : undefined;
}

/**
 * Whether anything on the field says secret: the substring set pass, pwd, ssn, mpin, pincode, security code, cvv, cvc or
 * csc, or "pin" as a word of its own, in its name, id, autocomplete, page label or the ferret's label. ONE definition:
 * a signal ALWAYS wins, also over `autocomplete="one-time-code"`, in the card's fill and in the lock.
 */
export function passwordSignalled(field: Field, ferretLabel?: string): boolean {
  return [field.name, field.id, field.autocomplete, field.label, ferretLabel].some(word => {
    if (word === undefined) return false;
    const text = word.normalize('NFKC').replace(ONE_TIME_WORDS, '');
    return PASSWORD_SIGNAL.test(text) || PIN_WORD.test(text) || PIN_SUFFIX.test(text);
  });
}

/**
 * THE DAEMON'S PICK for a field on a page, over the agent's: a card field is a `secret`; a one-time code is a `code`,
 * whatever the agent called it (a code is not a password, so a saved password is never offered for it); anything else
 * stays as the agent asked. A label the daemon gave (`labels`, by sensitivity) says nothing of the agent's and follows
 * the pick; one the agent wrote is read as its word and kept. A target that is not a page, or a field the facts do not
 * name, changes nothing.
 */
export function pickedOnPage<
  F extends { readonly id: string; readonly label: string; readonly sensitivity: InputSensitivity },
>(
  facts: { readonly kind: string; readonly fields?: readonly PageFieldFacts[] },
  field: F,
  labels: Readonly<Record<InputSensitivity, string>>,
): F {
  const found = facts.kind === 'page' ? facts.fields?.find(each => each.fieldId === field.id) : undefined;
  const given = field.label === labels[field.sensitivity];
  const kind = found === undefined ? undefined : pageFieldKind(found.field, given ? undefined : field.label);
  const sensitivity = kind === 'card' ? 'secret' : kind === 'code' ? 'code' : field.sensitivity;
  return sensitivity === field.sensitivity
    ? field
    : { ...field, sensitivity, ...(given ? { label: labels[sensitivity] } : {}) };
}
