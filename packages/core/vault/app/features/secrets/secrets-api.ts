/**
 * The app's half of the secret store.
 *
 * THERE IS NO READ HERE, and there is nothing to add: the daemon serves no route that returns a value, so a browser
 * cannot obtain one however it asks. What this module can do is list what exists, replace one, and delete one —
 * write-only in, masked forever after.
 *
 * Every call goes through the machine's plugin client. A secret belongs to a MACHINE, so nothing here is cached at
 * module scope and every function takes the client it speaks through.
 */
import {
  PutSecretBodySchema,
  RemovedSecretSchema,
  type SecretList,
  SecretListSchema,
  type SecretSummary,
  SecretSummarySchema,
} from '../../../contract/index.ts';
import type { VaultClient } from '../../shell.tsx';

const LIST_ROUTE = 'GET /v1/secrets';
const PUT_ROUTE = 'POST /v1/secrets';
const REMOVE_ROUTE = 'DELETE /v1/secrets/:name';

export async function listSecrets(client: VaultClient): Promise<SecretList> {
  return SecretListSchema.parse(await client.call(LIST_ROUTE));
}

/** Stores or replaces a value. There is no matching read, by design. */
export async function putSecret(client: VaultClient, name: string, value: string): Promise<SecretSummary> {
  return SecretSummarySchema.parse(await client.call(PUT_ROUTE, { body: PutSecretBodySchema.parse({ name, value }) }));
}

export async function removeSecret(client: VaultClient, name: string): Promise<void> {
  RemovedSecretSchema.parse(await client.call(REMOVE_ROUTE, { params: { name } }));
}

/**
 * What the screen renders for a value. It is a constant rather than a length-derived run of dots: the length of a
 * credential narrows a guess, and the daemon does not send it anyway.
 */
export const SECRET_MASK = '••••••••••••';

/**
 * The sentence that must appear beside the store. "Agents cannot see these" is FALSE and someone who believes it will
 * hand an untrusted agent a production credential. This is the true version, exported so the surface and its test
 * cannot drift apart on the wording.
 */
export const SECRET_PROMISE =
  'Env vars for the programs ferrets run. The value goes into the command Ferretry runs, never into the agent. Values never reach this browser and never appear in a transcript.';

export const SECRET_LIMIT =
  'This does not stop an agent that is deliberately trying to leak a secret it is allowed to use. It is the boundary sudo has.';
