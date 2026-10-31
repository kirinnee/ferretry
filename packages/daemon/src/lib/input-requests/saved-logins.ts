import {
  fillRoleFor,
  type InputSaved,
  type InputSavedOffer,
  type InputSensitivity,
  type InputTargetFacts,
  type LoginEntrySummary,
  type LoginFieldRole,
  LoginMatchSchema,
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
      matched: matchKey !== undefined && entry.match.includes(matchKey),
      ...(hint === entry.id ? { hinted: true } : {}),
    }))
    .sort(
      (left, right) =>
        Number(right.matched) - Number(left.matched) ||
        Number(right.hinted === true) - Number(left.hinted === true) ||
        left.label.localeCompare(right.label),
    );
  const saves = savedFieldFor(sensitivity);
  const existing = matchKey === undefined ? undefined : entries.find(entry => entry.match.includes(matchKey));
  const suggest =
    existing !== undefined
      ? { id: existing.id, label: existing.label }
      : matchKey !== undefined
        ? { id: suggestedLoginId(matchKey), label: suggestedLoginLabel(matchKey) }
        : undefined;
  return {
    ...(matchKey === undefined ? {} : { match: matchKey }),
    ...(suggest === undefined || saves === undefined ? {} : { suggest }),
    ...(saves === undefined ? {} : { saves }),
    offers,
  };
}
