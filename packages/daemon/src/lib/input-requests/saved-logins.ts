import {
  fillRoleFor,
  type InputSaved,
  type InputSavedOffer,
  type InputSensitivity,
  type InputSignIn,
  type InputTargetFacts,
  type LoginEntrySummary,
  type LoginFieldRole,
  LoginMatchSchema,
  loginDomainsOf,
  loginMethodOf,
  savedRolesOf,
  strongestSensitivity,
  suggestedLoginId,
  suggestedLoginLabel,
} from '@ferretry/protocol';

/**
 * WHICH SAVED LOGIN IS FOR THIS TARGET — decided by the daemon from what IT observed, never by the agent.
 *
 * A terminal's key is `program@host`: the foreground program's name and this machine's short host name
 * (`sudo@kirin-box`). For `ssh`, `scp` and `sftp` the host is the destination on the command line when one
 * can be read (`ssh@build.example.com`), because the password is the remote one. A page's key is its
 * origin's host (`github.com`). Matching is EXACT: a look-alike host or another program is not a match, so
 * it is never the one-tap choice — though the owner can still pick any entry by hand.
 *
 * A TERMINAL key is matched against what an entry is for (`match`). A PAGE's host is matched against where the
 * entry SIGNS IN (its login domains: `accounts.google.com` for a Google login), so the provider's page is where
 * the provider's password is the one-tap choice, and the site that sends the ferret there is not.
 */

const REMOTE_PROGRAMS = new Set(['ssh', 'scp', 'sftp']);
/** ssh's options that take a value, so the destination is not mistaken for one. */
const SSH_VALUE_OPTIONS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));

/** The destination host an ssh-family command line names, lowercased, or `undefined` when it cannot be read. */
export function remoteHostOf(argv: string): string | undefined {
  const words = argv.trim().split(/\s+/u).slice(1);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--') {
      return hostPart(words[index + 1]);
    }
    if (word.startsWith('-')) {
      const option = word.slice(1);
      if (option.length === 1 && SSH_VALUE_OPTIONS.has(option)) index += 1;
      continue;
    }
    return hostPart(word);
  }
  return undefined;
}

function hostPart(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  const withoutScheme = word.replace(/^(?:ssh|sftp):\/\//u, '');
  const afterUser = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1);
  const host = afterUser.replace(/:.*$/u, '').toLowerCase();
  return host === '' ? undefined : host;
}

/** The target's key, or `undefined` when what was seen cannot be named as one a saved login could match. */
export function targetMatchKey(facts: InputTargetFacts, hostName: string): string | undefined {
  let key: string | undefined;
  if (facts.kind === 'secret') return undefined;
  if (facts.kind === 'terminal') {
    const program = facts.foreground.comm.trim().toLowerCase();
    const host = REMOTE_PROGRAMS.has(program) ? remoteHostOf(facts.foreground.argv) : shortHost(hostName);
    key = host === undefined ? undefined : `${program}@${host}`;
  } else {
    try {
      key = new URL(facts.origin).host.toLowerCase();
    } catch {
      key = undefined;
    }
  }
  return key !== undefined && LoginMatchSchema.safeParse(key).success ? key : undefined;
}

/** This machine's name as a key uses it: the first label, lowercase. */
export function shortHost(hostName: string): string | undefined {
  const host = hostName.trim().toLowerCase().split('.')[0] ?? '';
  return host === '' ? undefined : host;
}

/** Which field a typed value is saved as. A one-time code is never saved: its seed is, from Settings. */
export function savedFieldFor(sensitivity: InputSensitivity): Exclude<LoginFieldRole, 'totp'> | undefined {
  return sensitivity === 'private' ? undefined : sensitivity === 'secret' ? 'password' : 'username';
}

/** Whether an entry is for this target's key: a terminal by `match`, a page by its login domains. Exact. */
export function entryIsFor(entry: LoginEntrySummary, matchKey: string | undefined): boolean {
  if (matchKey === undefined) return false;
  return matchKey.includes('@') ? entry.match.includes(matchKey) : loginDomainsOf(entry).includes(matchKey);
}

/**
 * How the entry this target is for signs in, when it is NOT a password: the owner's card says "Sign in with Google
 * via …". An entry is for it by its login domains or by what it is for, so a site that only sends the ferret to a
 * provider still says so.
 */
export function signInFor(
  matchKey: string | undefined,
  entries: readonly LoginEntrySummary[],
): InputSignIn | undefined {
  if (matchKey === undefined) return undefined;
  const entry = entries.find(
    candidate =>
      loginMethodOf(candidate).kind !== 'password' &&
      (entryIsFor(candidate, matchKey) || candidate.match.includes(matchKey)),
  );
  if (entry === undefined) return undefined;
  const method = loginMethodOf(entry);
  const via = method.via === undefined ? undefined : entries.find(candidate => candidate.id === method.via);
  return {
    id: entry.id,
    label: entry.label,
    method,
    ...(via === undefined ? {} : { via: { id: via.id, label: via.label } }),
  };
}

/**
 * A site that signs in THROUGH a provider never has the provider's login typed into its own page: the provider's
 * password belongs on the provider's domain, where it is matched. So its card leaves that entry out (unless the
 * daemon matched it here too, which only an owner's own login domains can do).
 */
function withoutProvider(offers: readonly InputSavedOffer[], signIn: InputSignIn | undefined): InputSavedOffer[] {
  const provider = signIn?.via?.id;
  return offers.filter(offer => offer.id !== provider || offer.matched);
}

function holds(entry: LoginEntrySummary, role: LoginFieldRole): boolean {
  return role === 'username' ? entry.username !== undefined : entry.fields[role];
}

/**
 * What the owner's card may offer: every entry that HOLDS the field this request needs, matched first,
 * then the one the ferret hinted, then by label. Only `matched` is ever the one-tap choice; a hint never
 * makes an entry matched. `suggest` is the entry "Save as" would update (the first matched one) or create.
 */
export function savedFor(
  sensitivity: InputSensitivity,
  matchKey: string | undefined,
  entries: readonly LoginEntrySummary[],
  hint: string | undefined,
): InputSaved {
  const role = fillRoleFor(sensitivity);
  const offers: InputSavedOffer[] = entries
    .filter(entry => holds(entry, role))
    .map(entry => ({
      id: entry.id,
      label: entry.label,
      ...(entry.username === undefined ? {} : { username: entry.username }),
      fills: role,
      matched: entryIsFor(entry, matchKey),
      ...(hint === entry.id ? { hinted: true } : {}),
    }))
    .sort(
      (left, right) =>
        Number(right.matched) - Number(left.matched) ||
        Number(right.hinted === true) - Number(left.hinted === true) ||
        left.label.localeCompare(right.label),
    );
  const saves = savedFieldFor(sensitivity);
  const existing = entries.find(entry => entryIsFor(entry, matchKey));
  const suggest =
    existing !== undefined
      ? { id: existing.id, label: existing.label }
      : matchKey !== undefined
        ? { id: suggestedLoginId(matchKey), label: suggestedLoginLabel(matchKey) }
        : undefined;
  const signIn = signInFor(matchKey, entries);
  return {
    ...(matchKey === undefined ? {} : { match: matchKey }),
    ...(suggest === undefined || saves === undefined ? {} : { suggest }),
    ...(saves === undefined ? {} : { saves }),
    offers: withoutProvider(offers, signIn),
    ...(signIn === undefined ? {} : { signIn }),
  };
}

/**
 * What a card of one or more fields may offer. One field is {@link savedFor}. Several are filled from ONE
 * entry, so only an entry that holds every field's value is offered (a login with a username and a password
 * for "Email" + "Password"). "Save as" keeps the card's username and password together in one entry
 * ({@link savedRolesOf}); it is suggested only for a card that can be kept that way, and `saves` names the
 * password when there is one, else the username.
 */
export function savedForFields(
  fields: readonly { readonly id: string; readonly sensitivity: InputSensitivity }[],
  matchKey: string | undefined,
  entries: readonly LoginEntrySummary[],
  hint: string | undefined,
): InputSaved {
  const [only] = fields;
  if (fields.length === 1 && only !== undefined) return savedFor(only.sensitivity, matchKey, entries, hint);
  const roles = fields.map(field => fillRoleFor(field.sensitivity));
  const complete = entries.filter(entry => roles.every(role => holds(entry, role)));
  const {
    suggest: _suggest,
    saves: _saves,
    ...offered
  } = savedFor(strongestSensitivity(fields), matchKey, complete, hint);
  const signIn = signInFor(matchKey, entries);
  const withSignIn =
    signIn === undefined ? offered : { ...offered, offers: withoutProvider(offered.offers, signIn), signIn };
  const kept = savedRolesOf(fields);
  if (kept === undefined) return withSignIn;
  // The entry Save as would update is one this target already matches, not only one that can fill the card.
  const { suggest } = savedFor('secret', matchKey, entries, hint);
  return {
    ...withSignIn,
    ...(suggest === undefined ? {} : { suggest }),
    saves: [...kept.values()].includes('password') ? 'password' : 'username',
  };
}
