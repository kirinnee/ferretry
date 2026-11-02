import { isCodeFactor, type Place, placeHosts, type TwoFactorKeySummary } from './accounts.ts';
import { type TotpParameters, TotpParametersSchema, TotpSeedSchema } from './login-entries.ts';

/**
 * 2FA KEYS, AS PEOPLE PASTE AND READ THEM (docs/input-requests.md, "Accounts and sign-ins"): the one parser for a
 * TOTP key the owner pastes, the check that it is for the account it is being saved to, and the words a code card's
 * title is made of. Pure: the app runs them for instant feedback and the daemon runs them again, authoritatively.
 *
 * A pasted key is a SECRET. Nothing here logs it, and no refusal repeats any part of what was pasted: every problem
 * is a fixed sentence, so a refusal can be shown, journaled or sent anywhere without carrying the seed.
 */

/** The most a pasted key, or an `otpauth://` link, may be: a real one is well under this. */
export const TOTP_INPUT_MAX_BYTES = 2_048;

/** A TOTP key as the parser read it. `seed` is the normalised base32 secret: it goes to the vault and nowhere else. */
export interface ParsedTotpKey {
  readonly seed: string;
  readonly params: TotpParameters;
  /** Who the link says the key is for (`GitHub`), from its `issuer` or its label. Absent for a bare key. */
  readonly issuer?: string;
  /** The account the link names (`kirinnee`, `kirin@example.com`). Absent for a bare key. */
  readonly accountName?: string;
}

export type TotpInputParse =
  | { readonly ok: true; readonly value: ParsedTotpKey }
  | { readonly ok: false; readonly error: string };

/** Every reason a paste is refused, in the owner's words. None of them carries any of the input. */
export const TOTP_INPUT_PROBLEMS = {
  empty: 'Paste the 2FA key, or its otpauth://totp link.',
  tooLong: 'That is too long to be a 2FA key.',
  notAKey:
    'That is not a 2FA key: paste the key itself (letters A to Z and digits 2 to 7, spaces are fine) or an otpauth://totp link.',
  migration: 'Google Authenticator export links are not supported yet: add each key on its own.',
  hotp: 'Counter-based codes (HOTP) are not supported: only time-based ones (TOTP).',
  notTotp: 'That link is not for a time-based 2FA key (otpauth://totp).',
  shape: 'That otpauth link is not written the way one is.',
  hidden: 'That link has line breaks or hidden characters in it: copy it again.',
  encoding: 'That link has a broken %-escape in it: copy it again.',
  repeated: 'That link names the same setting twice, so it is not clear which one counts.',
  noSecret: 'That link has no secret in it.',
  badSecret: 'That link’s secret is not a 2FA key (base32, 16 to 128 characters).',
  algorithm: 'That key uses a code algorithm Ferretry does not support (SHA1, SHA256 and SHA512 are).',
  digits: 'That key makes codes of a length Ferretry does not support (6, 7 or 8 digits are).',
  period: 'That key changes its code at an interval Ferretry does not support (every 15 to 120 seconds is).',
  contradicts: 'That link names two different issuers, in its label and its settings.',
  longName: 'That link’s issuer or account name is too long.',
} as const;

const refuse = (error: string): TotpInputParse => ({ ok: false, error });

/** Line breaks, controls and invisible formatting (bidi overrides, zero-width): never in a link a person copied. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512']);
const KNOWN_SETTINGS = new Set(['secret', 'issuer', 'algorithm', 'digits', 'period']);

/** The longest an issuer and an account name may be, as a 2FA key keeps them (accounts.ts). */
const ISSUER_MAX_LENGTH = 80;
const ACCOUNT_NAME_MAX_LENGTH = 256;

const decode = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

/** A name as the checks compare it: case-folded, letters and digits only (`Git-Hub, Inc.` → `githubinc`). */
const comparable = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '');

/** Whether two issuers differ: on their letters and digits, or, when one has none, on the whole name. */
const namesDiffer = (one: string, other: string): boolean => {
  const [a, b] = [comparable(one), comparable(other)];
  return a === '' || b === '' ? one.normalize('NFKC').toLowerCase() !== other.normalize('NFKC').toLowerCase() : a !== b;
};

const presentOrUndefined = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

/**
 * READS A TOTP KEY the owner pasted: a bare base32 key (spaces, dashes and `=` padding are fine; any case), or an
 * `otpauth://totp/<issuer>:<account>?secret=…&issuer=…&algorithm=…&digits=…&period=…` link.
 *
 * Refused, each with its own sentence: an `otpauth://hotp` link (counter-based), any other `otpauth` type, an
 * `otpauth-migration://` export, an algorithm other than SHA1/SHA256/SHA512, digits other than 6–8, a period outside
 * 15–120 s, a missing or malformed secret, a setting named twice, a label whose issuer differs from the `issuer`
 * setting, hidden characters, a broken %-escape, and anything over {@link TOTP_INPUT_MAX_BYTES}. `image` and settings
 * it does not know are ignored.
 */
export function parseTotpInput(text: string): TotpInputParse {
  if (new TextEncoder().encode(text).length > TOTP_INPUT_MAX_BYTES) return refuse(TOTP_INPUT_PROBLEMS.tooLong);
  const input = text.trim();
  if (input === '') return refuse(TOTP_INPUT_PROBLEMS.empty);
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(input)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    const seed = TotpSeedSchema.safeParse(input);
    return seed.success
      ? { ok: true, value: { seed: seed.data, params: TotpParametersSchema.parse({}) } }
      : refuse(TOTP_INPUT_PROBLEMS.notAKey);
  }
  if (scheme === 'otpauth-migration') return refuse(TOTP_INPUT_PROBLEMS.migration);
  if (scheme !== 'otpauth') return refuse(TOTP_INPUT_PROBLEMS.notAKey);
  return parseOtpauth(input);
}

function parseOtpauth(input: string): TotpInputParse {
  if (HIDDEN.test(input)) return refuse(TOTP_INPUT_PROBLEMS.hidden);
  const parts = /^otpauth:\/\/([^/?#]*)\/([^?#]*)(?:\?([^#]*))?(?:#.*)?$/iu.exec(input);
  if (parts === null) return refuse(TOTP_INPUT_PROBLEMS.shape);
  const [, type = '', rawLabel = '', rawQuery = ''] = parts;
  if (type.toLowerCase() === 'hotp') return refuse(TOTP_INPUT_PROBLEMS.hotp);
  if (type.toLowerCase() !== 'totp') return refuse(TOTP_INPUT_PROBLEMS.notTotp);

  const label = decode(rawLabel);
  if (label === undefined) return refuse(TOTP_INPUT_PROBLEMS.encoding);
  const settings = new Map<string, string>();
  for (const pair of rawQuery.split('&')) {
    if (pair === '') continue;
    const at = pair.indexOf('=');
    const name = decode((at === -1 ? pair : pair.slice(0, at)).replaceAll('+', ' '))?.toLowerCase();
    const value = decode((at === -1 ? '' : pair.slice(at + 1)).replaceAll('+', ' '));
    if (name === undefined || value === undefined) return refuse(TOTP_INPUT_PROBLEMS.encoding);
    if (!KNOWN_SETTINGS.has(name)) continue;
    if (settings.has(name)) return refuse(TOTP_INPUT_PROBLEMS.repeated);
    settings.set(name, value);
  }
  if (HIDDEN.test(label) || [...settings.values()].some(value => HIDDEN.test(value)))
    return refuse(TOTP_INPUT_PROBLEMS.hidden);

  const secret = settings.get('secret');
  if (secret === undefined || secret.trim() === '') return refuse(TOTP_INPUT_PROBLEMS.noSecret);
  const seed = TotpSeedSchema.safeParse(secret);
  if (!seed.success) return refuse(TOTP_INPUT_PROBLEMS.badSecret);

  const algorithm = (settings.get('algorithm') ?? 'SHA1').trim().toUpperCase();
  if (!ALGORITHMS.has(algorithm)) return refuse(TOTP_INPUT_PROBLEMS.algorithm);
  const digits = (settings.get('digits') ?? '6').trim();
  if (!/^[678]$/u.test(digits)) return refuse(TOTP_INPUT_PROBLEMS.digits);
  const period = (settings.get('period') ?? '30').trim();
  const seconds = /^[0-9]{1,3}$/u.test(period) ? Number(period) : Number.NaN;
  if (!(seconds >= 15 && seconds <= 120)) return refuse(TOTP_INPUT_PROBLEMS.period);
  const params = TotpParametersSchema.safeParse({ algorithm, digits: Number(digits), period: seconds });
  if (!params.success) return refuse(TOTP_INPUT_PROBLEMS.shape);

  // The label is `issuer:account` or `account`; the `issuer` setting, when both exist, must name the same issuer (a
  // `+` or a dash one generator writes for a space does not count as a difference).
  const colon = label.indexOf(':');
  const labelIssuer = colon === -1 ? undefined : presentOrUndefined(label.slice(0, colon));
  const accountName = presentOrUndefined(colon === -1 ? label : label.slice(colon + 1));
  const settingIssuer = presentOrUndefined(settings.get('issuer'));
  if (labelIssuer !== undefined && settingIssuer !== undefined && namesDiffer(labelIssuer, settingIssuer))
    return refuse(TOTP_INPUT_PROBLEMS.contradicts);
  const issuer = settingIssuer ?? labelIssuer;
  if ((issuer?.length ?? 0) > ISSUER_MAX_LENGTH || (accountName?.length ?? 0) > ACCOUNT_NAME_MAX_LENGTH)
    return refuse(TOTP_INPUT_PROBLEMS.longName);

  return {
    ok: true,
    value: {
      seed: seed.data,
      params: params.data,
      ...(issuer === undefined ? {} : { issuer }),
      ...(accountName === undefined ? {} : { accountName }),
    },
  };
}

// ── Is this key for this account? ────────────────────────────────────────────────────────────────

/** What the mismatch check reads of the account a key is being saved to. */
export interface FactorMismatchAccount {
  readonly label: string;
  readonly username?: string | undefined;
}

/** What a pasted key says it is for, where it differs from the account: the amber box names exactly these. */
export interface FactorMismatch {
  readonly issuer?: string;
  readonly accountName?: string;
}

/**
 * The registrable label of every host a sign-in names: the one before the top-level domain (`github.com` → `github`,
 * `company.okta.com` → `okta`, a terminal's `ssh@build.example.com` → `example`). Never another label of the host:
 * `company` or `com` would let a fragment through.
 */
function registrableLabels(places: readonly Place[]): readonly string[] {
  const labels: string[] = [];
  for (const key of places.flatMap(place => placeHosts(place))) {
    const host = (key.includes('@') ? key.slice(key.indexOf('@') + 1) : key).replace(/:[0-9]+$/u, '');
    const parts = host.split('.');
    const label = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    if (label !== undefined && label !== '') labels.push(label.toLowerCase());
  }
  return labels;
}

/** A name as whole words, case-folded (`GitHub (kirinnee)` → `github`, `kirinnee`). */
const wordsOf = (text: string): readonly string[] =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word !== '');

/** Whether `part` is a run of whole words in `whole`. */
const isWordRun = (part: readonly string[], whole: readonly string[]): boolean =>
  part.length > 0 && whole.some((_, start) => part.every((word, offset) => whole[start + offset] === word));

/** A letter, digit or combining mark outside ASCII: a look-alike (`Оkta`, Cyrillic О; `O\u0336kta`) may hide in one. */
const NON_ASCII_LETTER = /[^\p{ASCII}](?<=[\p{L}\p{N}\p{M}])/u;

/**
 * Whether an issuer names this account. An ASCII issuer must be the registrable label of a host one of its sign-ins
 * names, or a run of whole words of the account's label (`git hub` fits "Git-Hub work"; `kta`, `pan` and `com` fit
 * nothing). An issuer with a letter or digit outside ASCII must be the label or a registrable label EXACTLY, case-
 * folded, so a look-alike never passes by losing the letters it swapped.
 */
function issuerFits(issuer: string, account: FactorMismatchAccount, places: readonly Place[]): boolean {
  const hosts = registrableLabels(places);
  const folded = issuer.normalize('NFKC').trim().toLowerCase();
  if (NON_ASCII_LETTER.test(folded))
    return folded === account.label.normalize('NFKC').trim().toLowerCase() || hosts.includes(folded);
  const words = wordsOf(issuer);
  const label = wordsOf(account.label);
  return (
    hosts.includes(words.join('')) || isWordRun(words, label) || (words.length > 0 && words.join('') === label.join(''))
  );
}

/**
 * WHETHER A PASTED KEY SAYS IT IS FOR ANOTHER ACCOUNT. The issuer must name this account ({@link issuerFits}: the
 * registrable label of a host its sign-ins name, or whole words of its label; exactly, when it has letters outside
 * ASCII). The account name must be the username (trimmed, case-folded), or an email whose local part is the
 * username. A bare key says neither, so it is never a mismatch; an issuer with no letters or digits is one.
 *
 * `undefined`: nothing differs. The daemon refuses a save with a mismatch unless the owner ticked "save it here
 * anyway", so a bug in the app cannot skip the warning. The warning is advice: the passkey is still the act.
 */
export function factorMismatch(
  account: FactorMismatchAccount,
  places: readonly Place[],
  parsed: Pick<ParsedTotpKey, 'issuer' | 'accountName'>,
): FactorMismatch | undefined {
  const mismatch: { issuer?: string; accountName?: string } = {};
  if (parsed.issuer !== undefined && !issuerFits(parsed.issuer, account, places)) mismatch.issuer = parsed.issuer;
  if (parsed.accountName !== undefined && account.username !== undefined) {
    const named = parsed.accountName.normalize('NFKC').trim().toLowerCase();
    const username = account.username.normalize('NFKC').trim().toLowerCase();
    const at = named.lastIndexOf('@');
    if (named !== username && (at === -1 || named.slice(0, at) !== username)) mismatch.accountName = parsed.accountName;
  }
  return mismatch.issuer === undefined && mismatch.accountName === undefined ? undefined : mismatch;
}

/** "GitHub · kirinnee": how an account is named on a card. */
const accountWords = (account: FactorMismatchAccount): string =>
  account.username === undefined ? account.label : `${account.label} · ${account.username}`;

/** The amber box: "This key says it is for Okta · bob@x.com, but you're saving it to GitHub · kirinnee." */
export function factorMismatchWords(
  parsed: Pick<ParsedTotpKey, 'issuer' | 'accountName'>,
  account: FactorMismatchAccount,
): string {
  const says = [parsed.issuer, parsed.accountName].filter(part => part !== undefined).join(' · ');
  return `This key says it is for ${says}, but you're saving it to ${accountWords(account)}.`;
}

/** The line a staged seed's agenda card carries when it was staged with "save it here anyway": the app draws the amber box from it. */
export const TWO_FACTOR_SEED_CARD_MISMATCH_LINE =
  'It does not look like this account’s key; it was staged with “save it here anyway”.';

// ── A code card's title ──────────────────────────────────────────────────────────────────────────

const twoDots = '••';

/** One key on its own: "Code sent to ••42 (SMS)", "Code sent to kirin@… (email)", "Code from Authenticator app". */
function oneKeyWords(key: TwoFactorKeySummary): string {
  switch (key.kind) {
    case 'sms':
      return key.endsWith === undefined
        ? `Code sent by SMS (${key.label})`
        : `Code sent to ${twoDots}${key.endsWith} (SMS)`;
    case 'email':
      return key.to === undefined ? `Code sent by email (${key.label})` : `Code sent to ${key.to} (email)`;
    default:
      return `Code from ${key.label}`;
  }
}

/** One key in a list: "SMS ••42", "email to kirin@…", "Authenticator app". */
function shortKeyWords(key: TwoFactorKeySummary): string {
  switch (key.kind) {
    case 'sms':
      return key.endsWith === undefined ? `SMS (${key.label})` : `SMS ${twoDots}${key.endsWith}`;
    case 'email':
      return key.to === undefined ? `email (${key.label})` : `email to ${key.to}`;
    default:
      return key.label;
  }
}

/** A code key by its kind alone, for agenda text: no label, address or digits the owner wrote. */
const KEY_KIND_WORDS = { totp: 'authenticator app', sms: 'SMS', email: 'email' } as const;

/**
 * THE TITLE OF A CODE CARD, from the account's keys: the one a ferret named (`factor`) when the caller passes only
 * that one, else every key that ends in a code. One: where its code went ("Code sent to ••42 (SMS)"). Several: each
 * ("One-time code: SMS ••42 or Authenticator app"). None known: the account ("One-time code for GitHub · kirinnee") where
 * the caller may name it (the app, from the accounts it reads), and the PLACE alone ("One-time code for github.com")
 * where the words reach the agenda: agenda text is readable by every ferret, so it never names an account label or a
 * username. On that path the keys are said by KIND only ("One-time code for github.com, by email"): a key's label and
 * the address an email key goes to are the owner's words, and an address is often the username (secrev-1329a L6).
 * Every word is the OWNER's (the key's label and plain facts) or Ferretry's, never a ferret's.
 */
export function factorAskWords(
  keys: readonly TwoFactorKeySummary[],
  named: FactorMismatchAccount | { readonly place: string },
): string {
  const codes = keys.filter(key => isCodeFactor(key.kind));
  const [only] = codes;
  if ('place' in named) {
    const kinds = [...new Set(codes.map(key => KEY_KIND_WORDS[key.kind as keyof typeof KEY_KIND_WORDS]))];
    return `One-time code for ${named.place}${kinds.length === 0 ? '' : `, by ${kinds.join(' or ')}`}`;
  }
  if (only === undefined) return `One-time code for ${accountWords(named)}`;
  if (codes.length === 1) return oneKeyWords(only);
  return `One-time code: ${codes.map(shortKeyWords).join(' or ')}`;
}
