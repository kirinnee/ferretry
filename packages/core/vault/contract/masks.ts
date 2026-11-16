import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * Daemon-only values to MASK, never to use. Labels are `login:<ID>:<field>` or `2fa:<ID>`;
 * these entries are not Vault secrets and must never enter names, child environments or OwnSecret.
 * Nothing is retained (S20): Vault asks `values()` fresh for every read and every run, and the snapshot lives only for
 * that one read or run, as today opened the login vault and 2FA seeds on every read. A DECLARED provider that throws,
 * is unavailable or has been removed REFUSES the read or run (fail closed, S19), so turning Accounts off can never
 * leave a saved value unmasked; an UNDECLARED provider masks nothing.
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
