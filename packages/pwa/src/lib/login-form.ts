/**
 * THE SAVED-LOGINS FORMS, AS DECISIONS.
 *
 * What a form may send and what it may not: which fields a put carries, the 2FA seed that needs its tick, the
 * password that is only ever replaced. Pure, so the settings component only draws. A value is an argument and
 * is never returned except inside the one request body.
 */

import {
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_MATCH_MAX,
  LOGIN_METHOD_LABELS,
  LOGIN_METHODS,
  LOGIN_PASSWORD_MIN_LENGTH,
  type LoginDomain,
  LoginEntryIdSchema,
  type LoginEntrySummary,
  LoginMatchSchema,
  type LoginMethod,
  type LoginMethodKind,
  LoginMethodChangeSchema,
  loginDomainsOf,
  loginMethodOf,
  loginMethodSentence,
  normalizedLoginDomain,
  type PutLoginEntryRequest,
  TotpSeedSchema,
} from '@ferretry/protocol';

export const MATCH_HELP =
  'What it is for: program@host (sudo@kirin-box) or a web host (github.com). Separate several with commas.';

export const DOMAINS_HELP = 'Web hosts you sign in on, like app.vercel.com. Commas between.';

/** `sudo@kirin-box, github.com` → the list; blanks dropped, lowercase. */
export const parseMatch = (text: string): readonly string[] =>
  text
    .split(/[,\n]/u)
    .map(part => part.trim().toLowerCase())
    .filter(part => part !== '');

export const matchText = (match: readonly string[]): string => match.join(', ');

/** The sign-in methods, in the order the select lists them. There is no passkey one. */
export const METHOD_OPTIONS: readonly { readonly kind: LoginMethodKind; readonly label: string }[] = LOGIN_METHODS.map(
  kind => ({ kind, label: LOGIN_METHOD_LABELS[kind] }),
);

/** `https://App.Vercel.com/login, accounts.google.com` → the hosts typed, trimmed; blanks dropped. */
const domainParts = (text: string): readonly string[] =>
  text
    .split(/[,\n]/u)
    .map(part => part.trim())
    .filter(part => part !== '');

/** The login domains typed, each normalised to its host; one that is not a web host is dropped (see the problem). */
export const parseDomains = (text: string): readonly LoginDomain[] =>
  domainParts(text).flatMap(part => {
    const host = normalizedLoginDomain(part);
    return host === undefined ? [] : [host];
  });

const domainsText = (domains: readonly string[]): string => domains.join(', ');

/** How a form says a login signs in: the method, the SSO name, the provider login it goes via, and its domains. */
export interface SignInDraft {
  readonly method: LoginMethodKind;
  /** `sso` only. */
  readonly ssoName: string;
  /** A saved login's handle, or empty for none. Not for a password. */
  readonly via: string;
  readonly domains: string;
}

/** The sign-in an entry reads as, for a form to start from. A dangling `via` starts as none. */
export const signInDraftOf = (
  entry: LoginEntrySummary | undefined,
  entries: readonly LoginEntrySummary[],
): SignInDraft => {
  if (entry === undefined) return { method: 'password', ssoName: '', via: '', domains: '' };
  const method = loginMethodOf(entry);
  const via = method.via !== undefined && entries.some(other => other.id === method.via) ? method.via : '';
  return { method: method.kind, ssoName: method.name ?? '', via, domains: domainsText(loginDomainsOf(entry)) };
};

/** The method a draft says. A password carries no name or via; only an SSO carries a name. */
const methodOfDraft = (draft: SignInDraft): LoginMethod => ({
  kind: draft.method,
  ...(draft.method === 'sso' ? { name: draft.ssoName.trim() } : {}),
  ...(draft.method !== 'password' && draft.via !== '' ? { via: draft.via } : {}),
});

const sameMethod = (left: LoginMethod, right: LoginMethod): boolean =>
  left.kind === right.kind && (left.name ?? '') === (right.name ?? '') && (left.via ?? '') === (right.via ?? '');

/** The saved logins a provider method may go via: every OTHER entry, never the one being edited. */
export const viaChoices = (
  entries: readonly LoginEntrySummary[],
  self: string | undefined,
): readonly { readonly id: string; readonly label: string }[] =>
  entries.filter(entry => entry.id !== self).map(entry => ({ id: entry.id, label: entry.label }));

/** Why the sign-in part of a form cannot go, in the schema's own words, or `undefined`. */
export const signInProblem = (draft: SignInDraft): string | undefined => {
  if (draft.method === 'sso' && draft.ssoName.trim() === '') return 'Name the SSO provider, as its button says it.';
  const parsed = LoginMethodChangeSchema.safeParse(methodOfDraft(draft));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'That sign-in method is not valid.';
  const bad = domainParts(draft.domains).find(part => normalizedLoginDomain(part) === undefined);
  if (bad !== undefined) return `"${bad}" is not a web host, like app.vercel.com.`;
  if (parseDomains(draft.domains).length > LOGIN_MATCH_MAX) return `At most ${LOGIN_MATCH_MAX} login domains.`;
  return undefined;
};

/** What a row says of how an entry signs in: "Password", or "Sign in with Google via 'Google (kirin@…)'". */
export const methodWords = (entry: LoginEntrySummary, entries: readonly LoginEntrySummary[]): string => {
  const method = loginMethodOf(entry);
  const via = method.via === undefined ? undefined : entries.find(other => other.id === method.via)?.label;
  return loginMethodSentence(method, via);
};

/** The login domains an entry reads as, or `undefined` when it has none. */
export const domainsWords = (entry: LoginEntrySummary): string | undefined => {
  const domains = loginDomainsOf(entry);
  return domains.length === 0 ? undefined : `sign-in on ${domainsText(domains)}`;
};

export interface NewLoginDraft extends SignInDraft {
  readonly label: string;
  readonly id: string;
  readonly match: string;
  readonly username: string;
  readonly password: string;
}

/** Why an add cannot go yet, or `undefined`. Shown beside the form so the button and the sentence agree. */
export const newLoginProblem = (draft: NewLoginDraft, held: readonly string[]): string | undefined => {
  if (draft.label.trim() === '' || draft.id === '') return undefined;
  if (draft.label.trim().length > LOGIN_LABEL_MAX_LENGTH)
    return `A label is at most ${LOGIN_LABEL_MAX_LENGTH} characters.`;
  if (!LoginEntryIdSchema.safeParse(draft.id).success)
    return 'A handle is uppercase letters, digits and underscores, starting with a letter.';
  if (held.includes(draft.id)) return `${draft.id} already exists. Pick another handle, or edit that one.`;
  const bad = parseMatch(draft.match).find(entry => !LoginMatchSchema.safeParse(entry).success);
  if (bad !== undefined) return `"${bad}" is not a program@host or a web host.`;
  if (parseMatch(draft.match).length > LOGIN_MATCH_MAX) return `At most ${LOGIN_MATCH_MAX} matches.`;
  const signIn = signInProblem(draft);
  if (signIn !== undefined) return signIn;
  if (draft.password !== '' && draft.password.length < LOGIN_PASSWORD_MIN_LENGTH)
    return `A saved password is at least ${LOGIN_PASSWORD_MIN_LENGTH} characters, so it can be masked out of output safely.`;
  return undefined;
};

export const canAddLogin = (draft: NewLoginDraft, held: readonly string[]): boolean =>
  draft.label.trim() !== '' &&
  draft.id !== '' &&
  draft.password.length >= LOGIN_PASSWORD_MIN_LENGTH &&
  newLoginProblem(draft, held) === undefined;

/**
 * The body that creates an entry. An empty username is left out rather than sent blank; a plain password
 * sign-in sends no method (it is the default), and no domains means the daemon reads the web hosts of `match`.
 */
export const newLoginBody = (draft: NewLoginDraft): PutLoginEntryRequest => {
  const domains = parseDomains(draft.domains);
  return {
    label: draft.label.trim(),
    match: [...parseMatch(draft.match)],
    ...(draft.method === 'password' ? {} : { method: methodOfDraft(draft) }),
    ...(domains.length === 0 ? {} : { domains: [...domains] }),
    ...(draft.username.trim() === '' ? {} : { username: draft.username.trim() }),
    password: draft.password,
  };
};

export interface EditLoginDraft extends SignInDraft {
  readonly label: string;
  readonly match: string;
  readonly username: string;
}

/**
 * The body that edits label, match, sign-in method, login domains and username: only what changed is sent, so
 * everything else (the password, a 2FA seed) is kept. A changed method is sent whole. An emptied username is
 * `null`, which removes it. `undefined` when nothing changed, or when the sign-in part is not valid.
 */
export const editLoginBody = (entry: LoginEntrySummary, draft: EditLoginDraft): PutLoginEntryRequest | undefined => {
  if (signInProblem(draft) !== undefined) return undefined;
  const label = draft.label.trim();
  const match = parseMatch(draft.match);
  const username = draft.username.trim();
  const method = methodOfDraft(draft);
  const domains = parseDomains(draft.domains);
  const body: PutLoginEntryRequest = {
    ...(label !== '' && label !== entry.label ? { label } : {}),
    ...(matchText(match) !== matchText(entry.match) ? { match: [...match] } : {}),
    ...(sameMethod(method, loginMethodOf(entry)) ? {} : { method }),
    ...(domainsText(domains) !== domainsText(loginDomainsOf(entry)) ? { domains: [...domains] } : {}),
    ...(username !== (entry.username ?? '') ? { username: username === '' ? null : username } : {}),
  };
  return Object.keys(body).length === 0 ? undefined : body;
};

/** A new password replaces the old one; it is write-only. */
export const replacePasswordBody = (password: string): PutLoginEntryRequest => ({ password });

export const passwordProblem = (password: string): string | undefined =>
  password !== '' && password.length < LOGIN_PASSWORD_MIN_LENGTH
    ? `At least ${LOGIN_PASSWORD_MIN_LENGTH} characters.`
    : undefined;

/** Whether the seed field holds something the daemon would accept; checked locally for a sentence, not for trust. */
export const seedProblem = (seed: string): string | undefined =>
  seed.trim() === '' || TotpSeedSchema.safeParse(seed).success
    ? undefined
    : 'A 2FA seed is base32 (letters A-Z and digits 2-7), 16 to 128 characters.';

/**
 * Adds a 2FA seed. It needs the explicit tick: without it nothing is built, so a seed can never go in on a
 * stray press. The warning is shown by the form before the tick is offered.
 */
export const addTotpBody = (seed: string, acknowledged: boolean): PutLoginEntryRequest | undefined =>
  acknowledged && seed.trim() !== '' && seedProblem(seed) === undefined
    ? { totp: { seed }, totpAcknowledged: true }
    : undefined;

export const removeTotpBody = (): PutLoginEntryRequest => ({ totp: null });

/** Which secret fields an entry holds, as words: never a value. */
export const fieldWords = (entry: LoginEntrySummary): readonly string[] => [
  entry.fields.password ? 'password ✓' : 'no password',
  entry.fields.totp ? '2FA ✓' : 'no 2FA',
];

/** A handle offered while a label is typed: `GitHub (kirinnee)` → `GITHUB_KIRINNEE`. Editable by the owner. */
export const handleFromLabel = (label: string): string =>
  label
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .slice(0, 64);
