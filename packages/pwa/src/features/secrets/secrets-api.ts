/**
 * The browser's half of the secret store.
 *
 * THERE IS NO READ HERE, and there is nothing to add: the daemon serves no route that returns a
 * value, so a browser cannot obtain one however it asks. What this module can do is list what
 * exists, replace one, and delete one — write-only in, masked forever after.
 *
 * Every call goes through a connection-bound client. A browser can be paired to several daemons and
 * a secret belongs to a MACHINE, so a list fetched for one daemon must never be rendered for
 * another; that is why nothing here is cached at module scope and every function takes a client.
 */

import {
  PutSecretRequestSchema,
  RemovedSecretSchema,
  SecretListSchema,
  SecretSummarySchema,
  type IFyApiClient,
  type SecretList,
  type SecretSummary,
} from '@ferretry/protocol';

/** The only client capability the secret surface uses. */
export type SecretClient = Pick<IFyApiClient, 'request'>;

export const SECRETS_PATH = '/v1/secrets';

export async function listSecrets(client: SecretClient): Promise<SecretList> {
  return await client.request(SECRETS_PATH, SecretListSchema);
}

/** Stores or replaces a value. There is no matching read, by design. */
export async function putSecret(client: SecretClient, name: string, value: string): Promise<SecretSummary> {
  return await client.request(SECRETS_PATH, SecretSummarySchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PutSecretRequestSchema.parse({ name, value })),
  });
}

export async function removeSecret(client: SecretClient, name: string): Promise<void> {
  await client.request(`${SECRETS_PATH}/${encodeURIComponent(name)}`, RemovedSecretSchema, { method: 'DELETE' });
}

/** What the screen renders for a value. It is a constant rather than a length-derived run of dots:
 *  the length of a credential narrows a guess, and the daemon does not send it anyway. */
export const SECRET_MASK = '••••••••••••';

/**
 * The sentence that must appear beside the store.
 *
 * "Agents cannot see these" is FALSE and someone who believes it will hand an untrusted agent a
 * production credential. This is the true version, and it is exported so the surface and its test
 * cannot drift apart on the wording.
 */
export const SECRET_PROMISE =
  'Agents use these without holding one: the value goes into the command Ferretry runs, never into the agent. Values never reach this browser and never appear in a transcript.';

export const SECRET_LIMIT =
  'This does not stop an agent that is deliberately trying to leak a secret it is allowed to use. It is the boundary sudo has.';
