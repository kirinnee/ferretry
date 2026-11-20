/**
 * A preset form's secret slot holds a REFERENCE (`${secret:NAME}`), never a key. A value that is not one is treated
 * as a key pasted by mistake: the field masks it and the form refuses to send it.
 *
 * The judgement is the daemon's own, not a second grammar: the reference grammar is the Vault contract's
 * (`secretReferencesIn`, `malformedSecretReference`) and what a stored variable may hold is this plugin's
 * `storedEnvironmentIssue` — the very checks `login.add` runs. The value is judged and dropped; no sentence here
 * ever carries it.
 */

import { malformedSecretReference, secretReferencesIn } from '@ferretry/core-vault/contract';
import { storedEnvironmentIssue } from '../../contract/index.ts';

/** What the form says when a secret slot holds something that is not a reference. Never carries the value. */
export const SECRET_VALUE_SENTENCE =
  'That looks like a secret value. Put the value in a secret with fy secret set NAME and enter the name here.';

/** Whether a secret slot's text is empty or a reference the daemon would accept: the only text shown as plain text. */
export function isSecretReference(name: string, value: string): boolean {
  const text = value.trim();
  if (text === '') return true;
  return (
    secretReferencesIn(text).length > 0 &&
    malformedSecretReference(text) === undefined &&
    storedEnvironmentIssue(name, text) === undefined
  );
}

/** The names of the secret slots whose text is not a reference, in the order the form lists them. */
export function nonReferenceSlots(slots: readonly string[], env: Readonly<Record<string, string>>): readonly string[] {
  return slots.filter(name => !isSecretReference(name, env[name] ?? ''));
}
