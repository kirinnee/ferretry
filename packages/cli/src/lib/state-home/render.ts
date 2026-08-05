import type { StateHomeAdoption } from './claim.ts';

/**
 * What an adopt says to a person.
 *
 * The entries are listed BEFORE the outcome sentence rather than after it, because the whole
 * justification for adopting a provisioned home — where the daemon's own silent recovery would
 * refuse it — is that a human was shown what they were claiming. A message that reported only
 * "adopted" would make this command exactly the unattended adoption it is allowed not to be.
 */
export function renderAdoption(adoption: StateHomeAdoption): string {
  if (adoption.kind === 'absent') {
    return `no state home at ${adoption.home} — nothing to adopt; it will be created and claimed by the next command that needs it`;
  }
  const found = adoption.entries.length === 0 ? '  (empty)' : adoption.entries.map(entry => `  ${entry}`).join('\n');
  if (adoption.kind === 'already-claimed') {
    return `${adoption.home} is already a claimed Ferretry state home; nothing changed. It holds:\n${found}`;
  }
  return `adopted ${adoption.home} as a Ferretry state home. It holds:\n${found}`;
}

/** The machine shape, so a script can branch on the outcome without parsing the sentence. */
export function renderAdoptionJson(adoption: StateHomeAdoption): string {
  return JSON.stringify(
    adoption.kind === 'absent'
      ? { outcome: adoption.kind, home: adoption.home, entries: [] }
      : { outcome: adoption.kind, home: adoption.home, entries: adoption.entries },
    null,
    2,
  );
}
