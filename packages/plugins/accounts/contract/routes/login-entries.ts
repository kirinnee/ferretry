import { z } from 'zod';
import { MIN_SECRET_VALUE_LENGTH, SecretNameSchema } from '@ferretry/core-vault/contract';

/** Field, target-matching and input-card primitives shared by canonical Accounts. */

/** An entry's handle: the shape of a secret name, because the CLI and the card name it (`SUDO_KIRIN_BOX`). */
export const LoginEntryIdSchema = SecretNameSchema;
export type LoginEntryId = z.infer<typeof LoginEntryIdSchema>;

export const LOGIN_LABEL_MAX_LENGTH = 80;
export const LOGIN_USERNAME_MAX_LENGTH = 256;
export const LOGIN_MATCH_MAX = 16;
/** Most entries one daemon keeps: a list a person can read, not a database. */
export const MAX_LOGIN_ENTRIES = 256;
/**
 * The shortest password an entry keeps. A REDACTION constraint, exactly as {@link MIN_SECRET_VALUE_LENGTH}
 * is: a saved value is masked wherever the daemon scrubs text, and a very short value would mask ordinary
 * words. A shorter password can still be TYPED on a card; it just cannot be saved.
 */
export const LOGIN_PASSWORD_MIN_LENGTH = MIN_SECRET_VALUE_LENGTH;
export const LOGIN_PASSWORD_MAX_LENGTH = 1_024;

/** A one-line text field: trimmed, at most `maximum` characters, no control or format characters. */
export const oneLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

/**
 * What an entry is for, as the daemon names a target: `program@host` for a terminal (`sudo@kirin-box`,
 * `ssh@build.example.com`), or a web host for a page (`github.com`, `localhost:8443`). Lowercase. The DAEMON
 * works out a target's key from what it observed; an agent never says what matches.
 */
export const LoginMatchSchema = z
  .string()
  .max(320)
  .regex(
    /^(?:[a-z0-9][a-z0-9._+-]{0,63}@)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u,
    'a program@host or a web host, lowercase',
  );
export type LoginMatch = z.infer<typeof LoginMatchSchema>;

/** The fields an entry can hold, and which of them are secret. */
const LOGIN_FIELD_ROLES = ['username', 'password', 'totp'] as const;
export const LoginFieldRoleSchema = z.enum(LOGIN_FIELD_ROLES);
export type LoginFieldRole = z.infer<typeof LoginFieldRoleSchema>;

/** How the code is made from the seed (RFC 6238). Not secret: an authenticator shows these. */
export const TotpParametersSchema = z.strictObject({
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).default('SHA1'),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]).default(6),
  period: z.number().int().min(15).max(120).default(30),
});
export type TotpParameters = z.infer<typeof TotpParametersSchema>;

/**
 * THE SENTENCE the owner reads before a 2FA key is SAVED, in the app, the CLI and the docs. It is the
 * reason TOTP is off by default and opted into per entry. It is about keeping the key, never about a fill: a ticked
 * code on a plan line or a standing rule says {@link AUTOMATED_CODE_WARNING}.
 */
export const LOGIN_TOTP_WARNING =
  "Keeping the password and the 2FA key in the same place means one compromise of this machine's vault defeats both factors.";

/**
 * THE ONE-FACTOR SENTENCE UNDER A TICKED CODE, on a task-plan line and on a standing rule alike, verbatim: Ferretry
 * fills the code itself, so nobody is asked for it. One red line, short enough for a rule's single red block.
 */
export const AUTOMATED_CODE_WARNING =
  'Ferretry types the password and the 2FA code, so a ferret it fills for has both factors.';

/**
 * What the owner says they understand before a code is ticked, verbatim: the app's tick beside
 * {@link AUTOMATED_CODE_WARNING} and the help of the CLI's `--i-understand-one-factor`.
 */
export const AUTOMATED_CODE_ACK_WORDS =
  'I understand this makes the sign-in one factor, with no one to approve a code.';

/** Most 2FA keys of one account that hold a seed: a re-enrolled second authenticator, a backup app. */
export const MAX_SEEDS_PER_ACCOUNT = 4;
/** The longest label the owner gives a 2FA key ("Okta Verify on Pixel", "Phone ••42"). */
export const TWO_FACTOR_LABEL_MAX_LENGTH = 60;

/** A base32 TOTP seed, as authenticator setup pages show it (spaces and `=` padding allowed). */
export const TotpSeedSchema = z
  .string()
  .transform(seed => seed.replaceAll(/[\s=-]/gu, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z2-7]{16,128}$/u, 'a base32 2FA key of 16 to 128 characters'));

/**
 * WHERE THE SIGN-IN HAPPENS: a web host, exactly as a page's origin names it (`app.vercel.com`,
 * `accounts.google.com`, `localhost:8443`). Separate from `match`, which says what the entry is FOR (the site
 * the work is on). A page card's one-tap choice is an entry whose login domain is the page's host EXACTLY:
 * no wildcard, no parent domain, no look-alike.
 */
export const LoginDomainSchema = z
  .string()
  .max(260)
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u, 'a web host, lowercase, like app.vercel.com');
export type LoginDomain = z.infer<typeof LoginDomainSchema>;

/** The host a person typed or pasted (`https://App.Vercel.com/login` → `app.vercel.com`), or `undefined`. */
export function normalizedLoginDomain(text: string): LoginDomain | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`).host.toLowerCase();
  } catch {
    return undefined;
  }
  return LoginDomainSchema.safeParse(host).success ? host : undefined;
}

/** The web hosts among what an entry matches: the login domains an entry kept before it had its own. */
export function webHostsOf(match: readonly string[]): readonly LoginDomain[] {
  return match.filter(target => !target.includes('@') && LoginDomainSchema.safeParse(target).success);
}

/**
 * HOW A SAVED LOGIN SIGNS IN. `password` types what the entry holds. An identity-provider method means the site
 * signs in through that provider ("Continue with Google"): the ferret clicks it, and the PROVIDER's page is
 * filled from the provider's own saved login, named by `via` (this site → the "Google (kirin@…)" entry).
 *
 * THERE IS NO PASSKEY METHOD, and an `sso` name that says passkey, WebAuthn or a security key is refused: the
 * agent browser has passkeys switched off (docs/input-requests.md, "Passkeys are off"), so a login that needs
 * one is the owner's hands, never a saved login.
 */
export const LOGIN_METHODS = ['password', 'google', 'github', 'microsoft', 'apple', 'sso'] as const;
export const LoginMethodKindSchema = z.enum(LOGIN_METHODS);
export type LoginMethodKind = z.infer<typeof LoginMethodKindSchema>;
export const LOGIN_SSO_NAME_MAX_LENGTH = 40;

/** What the owner reads for each method, in the app, the CLI and the agent's hint. */
export const LOGIN_METHOD_LABELS: Readonly<Record<LoginMethodKind, string>> = {
  password: 'Password',
  google: 'Sign in with Google',
  github: 'Sign in with GitHub',
  microsoft: 'Sign in with Microsoft',
  apple: 'Sign in with Apple',
  sso: 'Other SSO',
};

/** Words that name a passkey or a hardware authenticator: never a saved login's method. */
const PASSKEY_WORDS =
  /pass\s*-?\s*key|web\s*-?\s*authn|fido|u2f|security\s*-?\s*key|hardware\s*-?\s*key|yubi\s*-?\s*key/iu;

/** Whether a sign-in method's name means a passkey: a change that says one is refused. */
export const namesPasskey = (text: string): boolean => PASSKEY_WORDS.test(text);

const PASSKEYS_OFF = 'passkeys are off: a saved login signs in with a password or a provider';

/**
 * What is wrong with a method, as issues: an SSO method names its provider, only SSO does, and a password sign-in
 * goes via nothing. `link` is the provider it goes via, however the caller spells it (a handle here, an account key
 * in the stored sign-in of accounts.ts), so both shapes keep one rule.
 */
export function loginMethodIssues(
  kind: LoginMethodKind,
  name: string | undefined,
  link: string | undefined,
  linkPath: string,
): readonly { readonly path: string[]; readonly message: string }[] {
  return [
    ...(kind === 'sso' && name === undefined
      ? [{ path: ['name'], message: 'name the SSO provider, as its button says it' }]
      : []),
    ...(kind !== 'sso' && name !== undefined ? [{ path: ['name'], message: 'only other SSO takes a name' }] : []),
    ...(kind === 'password' && link !== undefined
      ? [{ path: [linkPath], message: 'a password sign-in is not via another login' }]
      : []),
  ];
}

export const LoginMethodSchema = z
  .strictObject({
    kind: LoginMethodKindSchema,
    /** `sso` only: the provider's name as the site's button says it ("Okta", "Company SSO"). */
    name: oneLine(LOGIN_SSO_NAME_MAX_LENGTH).optional(),
    /** An identity-provider method only: the saved login of that provider, whose page it fills. */
    via: LoginEntryIdSchema.optional(),
  })
  .superRefine((method, context) => {
    for (const issue of loginMethodIssues(method.kind, method.name, method.via, 'via'))
      context.addIssue({ code: 'custom', ...issue });
  });
export type LoginMethod = z.infer<typeof LoginMethodSchema>;

/**
 * A method as a CHANGE sends it: {@link LoginMethodSchema}, and an SSO name that says passkey is refused. Only a
 * write is judged by the word list, so a list that grows later never makes an entry already stored unreadable.
 */
export const LoginMethodChangeSchema = LoginMethodSchema.refine(
  method => method.name === undefined || !namesPasskey(method.name),
  { path: ['name'], message: PASSKEYS_OFF },
);

/** "Sign in with Google", "Sign in with Okta (SSO)" or "Password", without the provider entry. */
function loginMethodWords(method: LoginMethod): string {
  return method.kind === 'sso' ? `Sign in with ${method.name ?? 'SSO'} (SSO)` : LOGIN_METHOD_LABELS[method.kind];
}

/** The same, naming the provider's saved login: `Sign in with Google via 'Google (kirin@…)'`. */
export function loginMethodSentence(method: LoginMethod, viaLabel: string | undefined): string {
  const words = loginMethodWords(method);
  return viaLabel === undefined || method.kind === 'password' ? words : `${words} via '${viaLabel}'`;
}

/** A password as a write sends it: no control character or line break, which would press keys. */
export const LoginPasswordSchema = z
  .string()
  .min(LOGIN_PASSWORD_MIN_LENGTH)
  .max(LOGIN_PASSWORD_MAX_LENGTH)
  .regex(/^[^\p{Cc}]*$/u, 'a password with a control character or line break would press keys');

/**
 * Why a card's primary offer is first (accounts.ts `chosenSignIn`): the ferret named it, a project, folder or
 * site default chose it, or it is the only account that signs in here. Absent on every other offer.
 */
const SIGN_IN_CHOICE_REASONS = ['ferret', 'project', 'folder', 'site', 'only'] as const;
const SignInChoiceReasonSchema = z.enum(SIGN_IN_CHOICE_REASONS);
export type SignInChoiceReason = z.infer<typeof SignInChoiceReasonSchema>;

/** The longest project name a card's "Default for <project>" carries. */
export const SIGN_IN_PROJECT_MAX_LENGTH = 128;

/** A saved login named by another: its handle and its label, never what it holds. */
const LoginEntryRefSchema = z.strictObject({ id: LoginEntryIdSchema, label: oneLine(LOGIN_LABEL_MAX_LENGTH) });
export type LoginEntryRef = z.infer<typeof LoginEntryRefSchema>;

/** The site a hint is asked for: a host, a URL or a `program@host`, as a key a saved login could match. */
export function loginHintSite(text: string): LoginMatch | undefined {
  const trimmed = text.trim().toLowerCase();
  if (LoginMatchSchema.safeParse(trimmed).success) return trimmed;
  return normalizedLoginDomain(trimmed);
}

/** The sentence every hint ends with. */
export const LOGIN_HINT_PASSKEYS_OFF = 'Use the password or provider flow; passkeys are off, never create one.';

/**
 * The role a request's one field takes from an entry, by the request's sensitivity: a one-time `code` (and a `private`
 * value, which older ferrets raised for a 2FA code) takes the code the daemon makes from the entry's 2FA seed.
 */
export function fillRoleFor(sensitivity: 'secret' | 'private' | 'code' | 'plain'): LoginFieldRole {
  return sensitivity === 'secret'
    ? 'password'
    : sensitivity === 'private' || sensitivity === 'code'
      ? 'totp'
      : 'username';
}

/**
 * The handle "Save as" suggests for a target key: `sudo@kirin-box` → `SUDO_KIRIN_BOX`, `github.com` →
 * `GITHUB_COM`. Always a valid {@link LoginEntryIdSchema}; the owner can edit it.
 */
export function suggestedLoginId(match: string): LoginEntryId {
  const words = match
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '');
  const head = /^[A-Z]/u.test(words) ? words : `LOGIN_${words}`;
  return head.slice(0, 64).replace(/_+$/u, '');
}

/** The label "Save as" suggests: `sudo on kirin-box`, or the web host itself. */
export function suggestedLoginLabel(match: string): string {
  const at = match.indexOf('@');
  return (at === -1 ? match : `${match.slice(0, at)} on ${match.slice(at + 1)}`).slice(0, LOGIN_LABEL_MAX_LENGTH);
}

const PROVIDER_HOSTS: ReadonlyMap<string, string> = new Map([
  ['accounts.google.com', 'Google'],
  ['login.microsoftonline.com', 'Microsoft'],
  ['login.live.com', 'Microsoft'],
]);
const OKTA_DOMAINS = ['okta.com', 'oktapreview.com', 'okta-emea.com'] as const;

/**
 * The identity provider a sign-in host belongs to, by the name people call it ("Google"), from a FIXED list: Google's
 * and Microsoft's sign-in hosts exactly, and an organisation's own subdomain of Okta's (never the bare apex). Names a
 * new account only; it decides nothing.
 */
export function providerNameOf(match: string): string | undefined {
  const host = match.toLowerCase();
  const exact = PROVIDER_HOSTS.get(host);
  if (exact !== undefined) return exact;
  return OKTA_DOMAINS.some(domain => host.endsWith(`.${domain}`)) ? 'Okta' : undefined;
}

/** A username's part a CLI name is made from: an email's local part, else the whole name. */
const handleWordOf = (username: string): string => {
  const at = username.indexOf('@');
  return at > 0 ? username.slice(0, at) : username;
};

/**
 * What "New account" is called on a card ({@link InputSaved} `newAccount`, from `@ferretry/core-vault/contract`): the provider's name, or the place as
 * {@link suggestedLoginLabel} says it, then ` · <username>` when the username is known ("Google · a@gmail.com"); the
 * CLI name from the same words (`GOOGLE_A`, `GITHUB_COM_KIRINNEE`). A CLI name in `taken` gets `_2`, `_3`, … so two
 * accounts on one site never share one. Always a valid {@link LoginEntryIdSchema}; the owner can edit both.
 */
export function suggestedNewAccount(
  match: string,
  username: string | undefined,
  taken: ReadonlySet<string>,
): LoginEntryRef {
  const provider = providerNameOf(match);
  const place = provider ?? suggestedLoginLabel(match);
  const who = username?.trim();
  const label = (who === undefined || who === '' ? place : `${place} · ${who}`).slice(0, LOGIN_LABEL_MAX_LENGTH).trim();
  const base = suggestedLoginId(
    who === undefined || who === '' ? (provider ?? match) : `${provider ?? match}_${handleWordOf(who)}`,
  );
  let id = base;
  for (let count = 2; taken.has(id); count += 1) {
    const suffix = `_${String(count)}`;
    id = `${base.slice(0, 64 - suffix.length).replace(/_+$/u, '')}${suffix}`;
  }
  return { id, label };
}
