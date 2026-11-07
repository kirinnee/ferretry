import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * Daemon-only values to MASK, never to use. Labels are `login:<ID>:<field>` or `2fa:<ID>`;
 * these entries are not Vault secrets and must never enter names, child environments or OwnSecret.
 * A successful read replaces the source's previous snapshot. Vault retains that snapshot if the
 * provider throws or becomes unavailable, so turning Accounts off cannot reveal a saved value.
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
