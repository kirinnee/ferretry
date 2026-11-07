import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** TODO(vault contract): replace with Vault's export when rebuild/port-vault-masks reaches the base.
 * Lead-approved shape: Vault offers this provide hook, Accounts supplies its source. Vault retains the last masks
 * when the provider disappears or throws; these values never enter general secret names/run/child environments.
 */
export interface MaskSource {
  values(): Promise<ReadonlyMap<string, string>>;
}

export const RedactionSources = defineHook('redaction.sources', {
  mode: 'provide',
  key: z.literal('source'),
  value: z.custom<MaskSource>(),
  takers: ['accounts'],
});
