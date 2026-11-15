/**
 * What this half does with the Vault's secrets route (`POST /v1/secrets`, `GET /v1/secrets`), both governed by the Vault:
 *
 * - {@link heldSecretNames}: the NAMES the Vault already holds, so a pasted key never lands on one without the person's say-so.
 * - {@link saveSecret}: a key a person pasted, filed under the secret NAME the preset gives it.
 *
 * A value goes in the request body and nowhere else: it is not returned, logged, kept in a field or put in a login
 * file — the login only ever holds the `${secret:NAME}` reference. The list answer is parsed by the Vault's own strict
 * schema, so an answer that carries a value is refused here rather than held in browser memory.
 */

import { SecretListSchema } from '@ferretry/core-vault/contract';
import type { LoginsClient } from './client.ts';

const PUT_ROUTE = 'POST /v1/secrets' as const;
const LIST_ROUTE = 'GET /v1/secrets' as const;

/** The names of the secrets the Vault holds. Never a value. */
export async function heldSecretNames(client: LoginsClient): Promise<ReadonlySet<string>> {
  return new Set(SecretListSchema.parse(await client.call(LIST_ROUTE)).secrets.map(secret => secret.name));
}

/** Files `value` under `name` in the Vault, replacing one already filed there: callers ask the person first. */
export async function saveSecret(client: LoginsClient, name: string, value: string): Promise<void> {
  await client.call(PUT_ROUTE, { body: { name, value } });
}
