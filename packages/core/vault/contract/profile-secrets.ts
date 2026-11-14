import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * The secret NAMES a runtime's profile binds to its environment (`${secret:NAME}`), asked of Runtimes, which owns them.
 * Names only, never a value. The Vault uses the answer for ONE act: letting a plugin that declares
 * `permissions.profileSecrets` (MCP's check) put exactly those names into the one child it starts for that runtime,
 * through `VaultApi.childEnvironmentForRuntime` (the same secrets the runtime's own launch already puts into the same
 * server). Absent, unavailable or throwing, the answer is no names: the grant fails closed.
 */
export interface ProfileSecretReferences {
  references(runtime: string): Promise<readonly string[]>;
}

export const ProfileSecrets = defineHook('secrets.profile-references', {
  mode: 'provide',
  key: z.literal('profiles'),
  value: z.custom<ProfileSecretReferences>(),
  takers: ['runtimes'],
});
