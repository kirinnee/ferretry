/**
 * The one write this half makes to the Vault: a key a person pasted, filed under the secret NAME the preset gives it
 * (`POST /v1/secrets`, which the Vault governs and which answers a summary, never a value).
 *
 * The value goes in the request body and nowhere else: it is not returned, logged, kept in a field or put in a login
 * file — the login only ever holds the `${secret:NAME}` reference.
 */

import type { LoginsClient } from './client.ts';

const PUT_ROUTE = 'POST /v1/secrets' as const;

/** Files `value` under `name` in the Vault, replacing one already filed there. */
export async function saveSecret(client: LoginsClient, name: string, value: string): Promise<void> {
  await client.call(PUT_ROUTE, { body: { name, value } });
}
