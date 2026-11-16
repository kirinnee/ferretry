/**
 * What the Browser tab asks of the daemon, and nothing wider: a client that can `call` a route by key. The tab is
 * handed the half's own client, so a call meant for machine A is never sent to machine B.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';

export type CallClient = Pick<PluginClient, 'call'>;

/** The daemon's refusal as a sentence a person can read, or a stand-in when it said nothing. */
export const reasonOf = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return message === '' ? 'This machine did not answer.' : message;
};

/** The names of the secrets filed on this machine; a value is never listed (`GET /v1/secrets`, the Vault's). */
const SecretNamesSchema = z.looseObject({
  health: z.enum(['ready', 'damaged']),
  secrets: z.array(z.looseObject({ name: z.string().min(1) })),
});
export type SecretNames = { readonly health: 'ready' | 'damaged'; readonly names: ReadonlySet<string> };

export async function listSecretNames(client: CallClient): Promise<SecretNames> {
  const list = SecretNamesSchema.parse(await client.call('GET /v1/secrets'));
  return { health: list.health, names: new Set(list.secrets.map(secret => secret.name)) };
}

/** Files or replaces a secret (`POST /v1/secrets`). There is no matching read, by design. */
export async function putSecret(client: CallClient, name: string, value: string): Promise<void> {
  await client.call('POST /v1/secrets', { body: { name, value } });
}
