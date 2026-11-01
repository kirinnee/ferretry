/**
 * SETTINGS › ACCOUNTS, AS DECISIONS (docs/secrets.md, "The Accounts screen").
 *
 * What the screen decides that is not drawing lives here as a pure function: the sites the accounts are grouped under,
 * how a 2FA key reads (and whether it worked), which keys a "default" can be set for, and what the defaults file says.
 * Nothing here holds a secret: the wire this reads from carries none, only which fields exist.
 */

import {
  type AccountDefaultLine,
  type AccountDefaultsFile,
  AccountDefaultsFileSchema,
  type AccountId,
  type AccountList,
  type AccountSummary,
  accountDefaultLines,
  loginMethodSentence,
  type Place,
  type PushApp,
  placeHosts,
  type SignInSummary,
  type TwoFactorKeySummary,
  type TwoFactorKind,
} from '@ferretry/protocol';
import { parse } from 'yaml';

/** One account's sign-in at one site, as a row under that site. */
interface SiteRow {
  readonly signIn: SignInSummary;
  readonly account: AccountSummary;
}

interface SiteGroup {
  /** The first host the place names: `github.com`, or `ssh@box` for a terminal. */
  readonly key: string;
  readonly rows: readonly SiteRow[];
}

export interface AccountsBySite {
  readonly groups: readonly SiteGroup[];
  /** Accounts with no sign-in anywhere yet: they still belong on the screen. */
  readonly unplaced: readonly AccountSummary[];
}

/** The line a place sits under: its first host, so the same site is one heading however many accounts sign in there. */
const siteKeyOf = (place: Place): string => placeHosts(place)[0] ?? '';

/** Accounts grouped by the site they sign in at, sites in alphabetical order and an account once per site. */
export function accountsBySite(list: AccountList): AccountsBySite {
  const byId = new Map(list.accounts.map(account => [account.id, account]));
  const grouped = new Map<string, SiteRow[]>();
  const placed = new Set<AccountId>();
  for (const signIn of list.signIns) {
    const account = byId.get(signIn.account);
    if (account === undefined) continue;
    placed.add(account.id);
    const key = siteKeyOf(signIn.place);
    grouped.set(key, [...(grouped.get(key) ?? []), { signIn, account }]);
  }
  return {
    groups: [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, rows]) => ({
        key,
        rows: [...rows].sort((left, right) => left.account.label.localeCompare(right.account.label)),
      })),
    unplaced: list.accounts.filter(account => !placed.has(account.id)),
  };
}

/** "GitHub · kirinnee": how a row names an account. */
export const accountTitle = (account: Pick<AccountSummary, 'label' | 'username'>): string =>
  account.username === undefined ? account.label : `${account.label} · ${account.username}`;

/** Which secret fields exist, as words and never a value. */
export const fieldsWords = (account: Pick<AccountSummary, 'fields'>): string =>
  account.fields.password ? 'password saved' : 'no password saved';

// ── 2FA keys ───────────────────────────────────────────────────────────────────────────────────────────────

export const KEY_KIND_OPTIONS: readonly { readonly kind: Exclude<TwoFactorKind, 'totp'>; readonly label: string }[] = [
  { kind: 'sms', label: 'Text message' },
  { kind: 'email', label: 'Email code' },
  { kind: 'push', label: 'Approve on a phone' },
  { kind: 'security-key', label: 'Security key' },
];

export const PUSH_APP_WORDS: Readonly<Record<PushApp, string>> = {
  'okta-verify': 'Okta Verify',
  'microsoft-authenticator': 'Microsoft Authenticator',
  google: 'Google',
  duo: 'Duo',
  other: 'Another app',
};

export const keyKindWords = (kind: TwoFactorKind): string =>
  ({
    totp: 'Authenticator app',
    sms: 'Text message',
    email: 'Email code',
    push: 'Approve on a phone',
    'security-key': 'Security key',
  })[kind];

/** What a key says of itself in plain facts: where the code goes, or who makes it. Never a seed. */
export function keyFacts(key: TwoFactorKeySummary): string {
  switch (key.kind) {
    case 'totp':
      return key.automatic ? 'Ferretry makes the codes' : 'You type the codes yourself';
    case 'sms':
      return key.endsWith === undefined ? 'Code sent by text' : `Code sent to ••${key.endsWith}`;
    case 'email':
      return key.to === undefined ? 'Code sent by email' : `Code sent to ${key.to}`;
    case 'push':
      return key.app === undefined ? 'You approve it on your phone' : `Approve in ${PUSH_APP_WORDS[key.app]}`;
    case 'security-key':
      return 'You tap it yourself';
  }
}

export type KeyState = 'verified' | 'unverified' | 'failed';

/**
 * Whether a key Ferretry makes codes from went through, as the daemon saw it. A key only the owner holds is not
 * checked by use, so it has no state at all.
 */
export function keyState(key: TwoFactorKeySummary): KeyState | undefined {
  if (key.kind !== 'totp' || !key.automatic) return undefined;
  if (key.verified === undefined) return 'unverified';
  return key.verified.worked ? 'verified' : 'failed';
}

export function keyStateWords(key: TwoFactorKeySummary): string | undefined {
  const state = keyState(key);
  if (state === undefined || key.kind !== 'totp') return undefined;
  const day = key.verified?.at.slice(0, 10);
  if (state === 'verified') return `Worked on ${day ?? ''}`;
  if (state === 'failed') return `Did not work on ${day ?? ''}: check the key`;
  return 'Not tried yet';
}

/** The whole account's 2FA in one line for its row: "2 keys, Ferretry makes codes for 1". */
export function factorsWords(account: Pick<AccountSummary, 'factors'>): string {
  const count = account.factors.length;
  if (count === 0) return 'no 2FA keys';
  const automatic = account.factors.filter(key => key.automatic).length;
  const keys = `${String(count)} 2FA key${count === 1 ? '' : 's'}`;
  return automatic === 0 ? keys : `${keys}, Ferretry makes ${String(automatic)} of the codes`;
}

/** The last 2 to 4 digits an SMS key may name; `undefined` when the text is not that, so nothing wrong is sent. */
export const smsDigits = (text: string): string | undefined => {
  const digits = text.trim().replace(/^[•*]+/u, '');
  return /^[0-9]{2,4}$/u.test(digits) ? digits : undefined;
};

// ── Sign-ins ───────────────────────────────────────────────────────────────────────────────────────────────

/** "Password", or "Sign in with Google via 'Google (kirin@…)'" — the provider is named from the daemon's own list. */
export const signInMethodWords = (signIn: SignInSummary): string =>
  loginMethodSentence(signIn.method, signIn.via?.account.label);

/** A place as a heading: its hosts, or a terminal's `tool@host`. */
export const placeTitle = (place: Place): string => placeHosts(place).join(', ');

// ── Defaults (config/account-defaults.yaml) ──────────────────────────────────────────────────────────────

export type DefaultsRead =
  | { readonly kind: 'read'; readonly file: AccountDefaultsFile }
  | { readonly kind: 'unreadable'; readonly why: string };

/** The defaults file's text as lines. A file that does not parse is said to be so, never read as "no defaults". */
export function readDefaultsText(text: string, exists: boolean): DefaultsRead {
  if (!exists || text.trim() === '') return { kind: 'read', file: {} };
  let document: unknown;
  try {
    document = parse(text);
  } catch {
    return { kind: 'unreadable', why: 'account-defaults.yaml is not valid YAML' };
  }
  if (document === null || document === undefined) return { kind: 'read', file: {} };
  const shaped = AccountDefaultsFileSchema.safeParse(document);
  return shaped.success
    ? { kind: 'read', file: shaped.data }
    : { kind: 'unreadable', why: 'account-defaults.yaml does not say what a defaults file says' };
}

/**
 * The keys a default can be set for at this sign-in: every host the place NAMES, a site's `match` hosts included.
 * The daemon's check reads the same list (`placeHosts`), so a default on a host the sign-in is only FOR is not refused.
 */
export const defaultKeysOf = (place: Place): readonly string[] => placeHosts(place);

/** The machine-wide line for a key, if any. */
export const siteDefaultFor = (file: AccountDefaultsFile, key: string): AccountId | undefined => file.sites?.[key];

/** Lines in a project or folder scope that name this account on one of these keys: shown, and removable, here. */
export function scopedLinesFor(
  file: AccountDefaultsFile,
  account: AccountId,
  keys: readonly string[],
): readonly AccountDefaultLine[] {
  return accountDefaultLines(file).filter(
    line => line.scope !== 'sites' && line.account === account && keys.includes(line.key),
  );
}

/** What a refusal of the default line becomes, in the daemon's own words where it gave them. */
export const DEFAULT_ONLY_ORDERS =
  'A default only decides which account a sign-in card lists first. Nothing signs in until you tap it.';

// ── Look-alikes ──────────────────────────────────────────────────────────────────────────────────────────

/** Groups of two or more accounts that look like one, keeping only accounts still on the list. */
export function lookAlikeGroups(
  groups: readonly (readonly AccountId[])[],
  list: Pick<AccountList, 'accounts'>,
): readonly (readonly AccountSummary[])[] {
  const byId = new Map(list.accounts.map(account => [account.id, account]));
  return groups.map(group => group.flatMap(id => byId.get(id) ?? [])).filter(group => group.length >= 2);
}

/** Every pair in a group: "keep apart" is said of two accounts at a time. */
export function pairsOf<T>(items: readonly T[]): readonly (readonly [T, T])[] {
  return items.flatMap((one, index) => items.slice(index + 1).map(other => [one, other] as const));
}
