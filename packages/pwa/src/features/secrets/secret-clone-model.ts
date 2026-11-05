/**
 * What the "copy secrets to another machine" panel shows and says, as pure functions over what the two
 * machines answered (docs/secrets.md).
 *
 * NAMES ONLY. A row is a secret's name, where the SOURCE's configuration uses it, and whether the TARGET
 * already holds one by that name — every fact a person needs to choose, none of them a value.
 */

import { isSignInSecretName, type SecretImportResult, type SecretList } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';

/** One secret the source could copy. */
export interface SecretCopyRow {
  readonly name: string;
  /** Where the source's configuration names it — "config/daemon.json → AUTH_HEADER", "login glm-env". */
  readonly uses: readonly string[];
  /** The target already holds a secret by this name, so a copy keeps the one there and does not write this one. */
  readonly onTarget: boolean;
  /** A sign-in token a server filed itself. It is never copied: sign in on the other machine (docs/secrets.md). */
  readonly signIn: boolean;
}

/**
 * Every secret the source holds, sorted by name, with its uses and whether the target has one.
 *
 * `targetNames` is `null` when the target's list could not be read: then no row can claim to be new or
 * a replacement, and none is marked as either — saying "new" over a store nobody read would be a guess.
 */
export function secretCopyRows(source: SecretList, targetNames: ReadonlySet<string> | null): readonly SecretCopyRow[] {
  return source.secrets
    .map(secret => ({
      name: secret.name,
      uses: source.references.filter(reference => reference.name === secret.name).map(reference => reference.origin),
      onTarget: targetNames?.has(secret.name) === true,
      signIn: isSignInSecretName(secret.name),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** The rows a person may tick: every one but a sign-in. */
export function copyableRows(rows: readonly SecretCopyRow[]): readonly SecretCopyRow[] {
  return rows.filter(row => !row.signIn);
}

/** The names to start with ticked: the ones asked for that the source actually holds, or none. */
export function initialPicks(rows: readonly SecretCopyRow[], preselect: readonly string[]): readonly string[] {
  return copyableRows(rows)
    .filter(row => preselect.includes(row.name))
    .map(row => row.name);
}

const count = (n: number): string => `${n} ${n === 1 ? 'secret' : 'secrets'}`;

/** The button: "Copy 3 secrets", or the instruction when none is picked. */
export function copyButtonLabel(picked: number): string {
  return picked === 0 ? 'Pick secrets to copy' : `Copy ${count(picked)}`;
}

/**
 * What a finished copy says: how many arrived, and which ones `target` already held and kept as they were. A copy
 * never replaces a secret, so the way to change one is named: the person's own `fy secret set NAME`.
 */
export function copiedSentence(result: SecretImportResult, target: string): string {
  const copied =
    result.imported.length === 0 ? 'Nothing was copied.' : `${count(result.imported.length)} copied to ${target}.`;
  if (result.kept.length === 0) return copied;
  const names = result.kept.join(', ');
  const kept =
    result.kept.length === 1
      ? `${names} was already on ${target} and was left as it is.`
      : `${String(result.kept.length)} were already on ${target} and were left as they are: ${names}.`;
  return `${copied} ${kept} To replace one, run \`fy secret set NAME\` on ${target}.`;
}

/**
 * Why a copy did not happen, in words a person can act on. Codes this flow names get their own sentence;
 * anything else is the general refusal wording, which already reads the daemon's own message.
 */
const COPY_REFUSALS: Readonly<Record<string, string>> = {
  grant_step_up_required: 'Nothing was copied: the passkey wasn’t confirmed. Try again and confirm it.',
  offer_expired: 'Nothing was copied: the other machine stopped waiting after 5 minutes. Try again.',
  import_unknown: 'Nothing was copied: the machine receiving the secrets restarted or stopped waiting. Try again.',
  import_spent: 'Nothing was copied this time: that copy was already used. Try again.',
  bundle_invalid: 'Nothing was copied: what arrived did not open for this copy. Try again.',
  offer_invalid: 'Nothing was copied: the receiving machine’s offer did not check out. Try again.',
  same_machine: 'Nothing was copied: pick a different machine from this one.',
  identity_unavailable:
    'Nothing was copied: one of the machines cannot read its own identity. Restart it and try again.',
};

export function copyRefusalSentence(error: unknown): string {
  if (error instanceof FyHttpError && error.code !== undefined) {
    const known = COPY_REFUSALS[error.code];
    if (known !== undefined) return known;
  }
  return changeRefusalSentence(error);
}

/** What the panel promises, in one line, beside the button. Says the true thing and no more. */
export const SECRET_COPY_PROMISE =
  'The sending machine encrypts the values for the receiving one. This browser carries them and cannot read them. You confirm with your passkey every time.';
