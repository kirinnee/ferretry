import { defineConfig, neverLoosens } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * `config/vault.yaml` (§7.1): the operator's reusable environment recipes, owner-written YAML. Today's
 * `secretEnvironment` block of `config/daemon.json`, key for key and unchanged in meaning: a converter carries the block
 * to the same key here.
 *
 *     secretEnvironment:
 *       AUTH_HEADER: "Bearer ${secret:TOKEN}"
 *
 * A value is a spelling an operator writes once. THE VALUE OF A SECRET IS NEVER HERE: the file names a secret as
 * `${secret:NAME}` and Vault resolves it when it spawns a child. A raw value in the file is refused by the kernel's
 * config service exactly like any other declared file (a known key shape, or a high-entropy value under a key that
 * names a credential), and the last good version stays in effect.
 *
 * A recipe is injected only when EVERY secret it names is one the caller explicitly asked for, so adding or widening
 * one can never hand a child a secret it did not ask for: nothing here loosens spend or authority.
 */
export const VaultConfigSchema = z.strictObject({
  secretEnvironment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()).default({}),
});
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

export const VaultConfigFile = defineConfig({
  file: 'vault.yaml',
  schema: VaultConfigSchema,
  axis: 'configure',
  loosens: neverLoosens,
});
