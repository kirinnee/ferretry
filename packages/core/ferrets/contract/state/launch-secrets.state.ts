import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** The names the actual composed launch references, recorded before Vault resolves them. Never values. */
export const FerretLaunchSecretFiles = defineState({
  name: 'launch-references',
  path: '*/launch-references.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ names: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)) }),
  mode: 0o600,
});
