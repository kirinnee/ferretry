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
 *   says so, the ferret's label too: CVV, CVC, CSC, "card security code"). A `secret`. A card word wins over a code word
 *   ("security code" on a card is a CVC). A bare "security code" is a card's only when another field beside it is a card
 *   field by its own words: on its own it is just a secret-sounding word, as before.
 *
 * A `type=password` input is neither: the callers decide what a password-typed field is.
 */
export type PageFieldKind = 'code' | 'card';

type Field = PageFieldFacts['field'];

const CARD_AUTOCOMPLETE = /(?:^|\s)cc-(?:number|exp|exp-month|exp-year|csc)(?:\s|$)/iu;
const CARD_WORDS =
  /card[\s._-]*(?:number|num|no)\b|cardnumber|cc[\s._-]*(?:num|number|exp|expiry|csc|cvc|cvv)|cvc|cvv|csc|cvn|expir(?:y|ation|es)|exp[\s._-]*(?:date|month|year)/iu;
/** "Card security code", "card verification value": the card's own words for the CVC, with "card" in them. */
const CARD_SECURITY_WORDS = /card[\s._-]*(?:security|verification)[\s._-]*(?:code|number|no|value)/iu;
/** "Security code" with no "card" in it: a card's only beside a card field. */
const SECURITY_CODE = /security[\s._-]*(?:code|number|no)\b/iu;
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

/** Whether a field says it is a card field by its OWN words alone (never its neighbours'). */
function cardByItself(field: Field, ferretLabel?: string): boolean {
  if (field.autocomplete !== undefined && CARD_AUTOCOMPLETE.test(field.autocomplete)) return true;
  return words(field, field.label, ferretLabel).some(word => CARD_WORDS.test(word) || CARD_SECURITY_WORDS.test(word));
}

/**
 * Whether the page's own words for a field (its `label`, when the browser read one), plus the ferret's label for the card
 * words, put it among codes or card fields. `siblings` are the other fields on the page: a bare "security code" is a card's
 * only when one of them is a card field.
 */
export function pageFieldKind(
  field: Field,
  ferretLabel?: string,
  siblings: readonly Field[] = [],
): PageFieldKind | undefined {
  // The card words may read the ferret's label too: they only ever RAISE a field to a secret.
  if (cardByItself(field, ferretLabel)) return 'card';
  const beside = siblings.some(each => each !== field && cardByItself(each));
  if (beside && words(field, field.label, ferretLabel).some(word => SECURITY_CODE.test(word))) return 'card';
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

/** The words that say a field is a one-time code beyond doubt: otp, totp, 2fa, mfa, one-time. Not "code", not "verify". */
const CODE_EVIDENCE_WORDS =
  /(?:^|[^a-z])(?:otp|totp|2fa|mfa)(?![a-z])|[a-z](?:Otp|OTP|Totp|TOTP)(?![a-z])|otp[\s._-]*(?:input|field|code|digit|value)/u;
/** "One-time" in any case ("One-time passcode"). */
const ONE_TIME = /one[\s._-]*time/iu;

/**
 * Whether the page says UNAMBIGUOUSLY that a field takes a one-time code: `autocomplete="one-time-code"`, or a name, id or
 * label that says otp, totp, 2fa, mfa or one-time with no password word beside it. Independent of what the field's
 * `type` is and of the sensitivity the owner's card shows: a masked code box (`type="password"`) is still a code box.
 * Weaker hints (a numeric keypad, the word "code" or "verify") are not evidence here: a PIN box has them too.
 */
function codeEvidence(field: Field, ferretLabel?: string): boolean {
  if (field.autocomplete !== undefined && CODE_AUTOCOMPLETE.test(field.autocomplete)) return true;
  if (passwordSignalled(field, ferretLabel)) return false;
  return words(field, field.label, ferretLabel).some(
    word => CODE_EVIDENCE_WORDS.test(word) || CODE_EVIDENCE_WORDS.test(word.toLowerCase()) || ONE_TIME.test(word),
  );
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

/** What a field is called on the card when the agent gave it no label: the daemon's own words, never the agent's. */
export const FIELD_LABELS: Readonly<Record<InputSensitivity, string>> = {
  secret: 'Password',
  private: 'Private value',
  code: 'Code',
  plain: 'Value',
};

const foundOn = (
  facts: { readonly kind: string; readonly fields?: readonly PageFieldFacts[] },
  id: string,
): PageFieldFacts | undefined => (facts.kind === 'page' ? facts.fields?.find(each => each.fieldId === id) : undefined);

/**
 * Whether a field may NOT be filled from a saved LOGIN password, as an offer, a Save as, a grant's match or recheck, or at
 * delivery: it is a `secret` and the page says it is a card field or a one-time code (`type` and the card's masking aside). A login's password goes into a password box, never a card number or a code
 * box. SEPARATE from the field's sensitivity: the agent's secret stays a secret (masked) either way.
 */
export function barredFromLoginPassword(
  facts: { readonly kind: string; readonly fields?: readonly PageFieldFacts[] },
  field: { readonly id: string; readonly label: string; readonly sensitivity: InputSensitivity },
): boolean {
  if (field.sensitivity !== 'secret') return false;
  const found = foundOn(facts, field.id);
  if (found === undefined) return false;
  const given = field.label === FIELD_LABELS[field.sensitivity];
  const siblings = (facts.fields ?? []).map(each => each.field);
  const ferretLabel = given ? undefined : field.label;
  // The deny check does not follow the UI's precedence: a masked box (`type="password"`) that says one-time code is a
  // code box, kept masked AND given no login password.
  return pageFieldKind(found.field, ferretLabel, siblings) !== undefined || codeEvidence(found.field, ferretLabel);
}

/**
 * THE DAEMON'S PICK for a field on a page, over the agent's. It may only RAISE a field's sensitivity, never lower what
 * the agent asked: a card field is a `secret`; a one-time code is a `code` ONLY when the agent called it plain (a `secret`
 * or `private` ask stays, masked as asked; a saved password is kept from it by {@link barredFromLoginPassword}); anything
 * else stays as the agent asked. A label the daemon gave (`labels`, by sensitivity) says nothing of the agent's and follows
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
  const found = foundOn(facts, field.id);
  const given = field.label === labels[field.sensitivity];
  const siblings = (facts.fields ?? []).map(each => each.field);
  const kind = found === undefined ? undefined : pageFieldKind(found.field, given ? undefined : field.label, siblings);
  const sensitivity =
    kind === 'card' ? 'secret' : kind === 'code' && field.sensitivity === 'plain' ? 'code' : field.sensitivity;
  return sensitivity === field.sensitivity
    ? field
    : { ...field, sensitivity, ...(given ? { label: labels[sensitivity] } : {}) };
}
