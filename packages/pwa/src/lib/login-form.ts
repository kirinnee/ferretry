/**
 * THE SIGN-IN FORMS, AS DECISIONS.
 *
 * What a sign-in form may send and what it may not: the method a draft says, the domains it types, the
 * handle a label offers and the password length. Pure, so the Accounts screen only draws.
 */

import {
  LOGIN_METHOD_LABELS,
  LOGIN_METHODS,
  LOGIN_MATCH_MAX,
  LOGIN_PASSWORD_MIN_LENGTH,
  type LoginDomain,
  type LoginMethod,
  LoginMethodChangeSchema,
  type LoginMethodKind,
  normalizedLoginDomain,
} from '@ferretry/protocol';

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

/** How a form says a login signs in: the method, the SSO name, the provider login it goes via, and its domains. */
export interface SignInDraft {
  readonly method: LoginMethodKind;
  /** `sso` only. */
  readonly ssoName: string;
  /** A saved login's handle, or empty for none. Not for a password. */
  readonly via: string;
  readonly domains: string;
}

/** The method a draft says. A password carries no name or via; only an SSO carries a name. */
export const methodOfDraft = (draft: SignInDraft): LoginMethod => ({
  kind: draft.method,
  ...(draft.method === 'sso' ? { name: draft.ssoName.trim() } : {}),
  ...(draft.method !== 'password' && draft.via !== '' ? { via: draft.via } : {}),
});

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

export const passwordProblem = (password: string): string | undefined =>
  password !== '' && password.length < LOGIN_PASSWORD_MIN_LENGTH
    ? `At least ${LOGIN_PASSWORD_MIN_LENGTH} characters.`
    : undefined;

/** A handle offered while a label is typed: `GitHub (kirinnee)` → `GITHUB_KIRINNEE`. Editable by the owner. */
export const handleFromLabel = (label: string): string =>
  label
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .slice(0, 64);
