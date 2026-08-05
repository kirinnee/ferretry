/**
 * What a management surface is told: what exists, whether the store can be trusted, and which
 * configured references would fail if something used them right now.
 *
 * DAMAGED IS ITS OWN ANSWER. A store that will not open reports `damaged` with a diagnosis, never an
 * empty list — a person shown "no secrets" over a vault that is merely unreadable will recreate all
 * of them on top of a file that is still there. The list is also what the screen renders, so this is
 * where the honest sentence about what the store can and cannot promise has to be true.
 */

import { SECRET_SCHEMA_VERSION, type SecretList, type SecretReferenceView } from '@ferretry/protocol';
import { SecretStoreError, type SecretReferenceSource } from './types.ts';
import type { SecretDirectory } from './vault.ts';

/** A store with no configured references reports none, which is a fact rather than an absence. */
export const NO_REFERENCES: SecretReferenceSource = { references: async () => [] };

/** Why the store cannot answer, in terms an operator can act on. */
function diagnose(error: SecretStoreError): string {
  switch (error.failure) {
    case 'key_missing':
      return 'this daemon holds sealed secrets and the key that opens them is gone; restore the key file or delete the vault and set the secrets again';
    case 'undecipherable':
      return 'the vault key does not open the stored secrets; it was replaced, or the vault was written by another daemon';
    case 'full':
      return 'the vault is full';
    default:
      return 'the vault document could not be read as this daemon writes it';
  }
}

/**
 * Assembles the whole management view.
 *
 * The references are read even when the store is damaged: knowing WHICH secrets the configuration
 * expects is exactly what a person needs while deciding whether to restore a key or start over, and
 * a damaged store simply resolves none of them.
 */
export async function secretListView(
  directory: SecretDirectory,
  references: SecretReferenceSource,
): Promise<SecretList> {
  const configured = await references.references();
  try {
    const secrets = await directory.list();
    const held = new Set(secrets.map(secret => secret.name));
    return {
      v: SECRET_SCHEMA_VERSION,
      health: 'ready',
      secrets,
      references: configured.map(
        (reference): SecretReferenceView => ({ ...reference, resolved: held.has(reference.name) }),
      ),
    };
  } catch (error) {
    if (!(error instanceof SecretStoreError)) throw error;
    return {
      v: SECRET_SCHEMA_VERSION,
      health: 'damaged',
      diagnosis: diagnose(error),
      secrets: [],
      references: configured.map((reference): SecretReferenceView => ({ ...reference, resolved: false })),
    };
  }
}
