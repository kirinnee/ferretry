import { providedFor } from '../manifest/implement.ts';
import type { Manifest, Needer, SpawnEntry } from '../manifest/types.ts';
import { effectivePermissions } from './permissions.ts';

/**
 * The needer a per-needer `provides` entry is built for: the plugin's id and the permissions the kernel's own ports
 * enforce for it, so a `'*'` from a piece that is not core reaches nothing through a provider either.
 */
export function neederOf(
  manifest: Manifest,
  owned: () => ReadonlySet<string> = () => new Set(),
  mayReach?: (hostname: string, host: string) => boolean,
): Needer {
  const declared = manifest.permissions ?? {};
  return Object.freeze({
    id: manifest.id,
    permissions: Object.freeze({
      ...declared,
      network: effectivePermissions(manifest.id, declared.network ?? []),
      spawn: effectivePermissions(manifest.id, declared.spawn ?? []) as readonly SpawnEntry[],
      secrets: declared.secrets ?? [],
    }),
    ownedSecretReferences: owned,
    ...(mayReach === undefined ? {} : { mayReach }),
  });
}

/** The kernel itself, binding a kernel-bound port: a core caller. */
export const KERNEL_NEEDER: Needer = Object.freeze({
  id: 'kernel',
  permissions: Object.freeze({}),
  ownedSecretReferences: () => new Set<string>(),
});

/**
 * What each needer was handed for each provided entry: a per-needer factory runs ONCE per (provider, key, needer),
 * and every later bind of that port for the same needer gets the same value. A shared value is not cached.
 */
export class ProvidedPerNeeder {
  private readonly built = new Map<string, unknown>();

  valueFor(provider: string, key: string, value: unknown, needer: Needer): unknown {
    const cacheKey = `${provider}\u0000${key}\u0000${needer.id}`;
    if (this.built.has(cacheKey)) return this.built.get(cacheKey);
    const answer = providedFor(value, needer);
    if (answer !== value) this.built.set(cacheKey, answer);
    return answer;
  }
}
