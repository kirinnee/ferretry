import { join } from 'node:path';

/**
 * Where a `store: ferretry` credential lives, with no imports beyond `node:path`: a thread that only
 * reads a credential's files names them without carrying the account schema.
 */

/** The directory, under the fleet root, that holds every `store: ferretry` credential. */
export const CREDENTIALS_DIRECTORY = 'credentials';

/** `<fleet>/credentials/<id>`, the one home of a `store: ferretry` credential. */
export function ferretryCredentialDirectory(fleetRoot: string, id: string): string {
  return join(fleetRoot, CREDENTIALS_DIRECTORY, id).normalize('NFC');
}
