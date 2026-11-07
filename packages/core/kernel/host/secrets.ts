/**
 * `kernel.secrets` for one plugin (lead decision J). The order is the contract: the manifest names it, the plugin's
 * own configuration in effect names it as a `${secret:NAME}` reference, and only then is the Vault asked, through the
 * kernel-only {@link SecretResolver}. Nothing a caller sends is read: the reference set comes from the config
 * service, the name list from the manifest.
 */
import type { SecretResolver } from '../contract/bound.ts';
import { OwnSecret, SECRET_REFERENCE_SOURCE, type SecretsPort } from '../contract/secrets.ts';

const WHOLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Every `${secret:NAME}` named by any string anywhere in a configuration value. */
export function secretReferencesIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(new RegExp(SECRET_REFERENCE_SOURCE, 'gu')))
      if (match[1] !== undefined) into.add(match[1]);
  } else if (Array.isArray(value)) for (const item of value) secretReferencesIn(item, into);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value as Record<string, unknown>)) secretReferencesIn(item, into);
  return into;
}

/**
 * The sentence for each `${secret:NAME}` that `after` names and `before` (what is in effect) does not: adding one is
 * the OWNER's to do, so an edit that adds one waits for the owner (NN2), whatever the file's own `loosens` says.
 */
export function addedSecretReferenceSentences(before: unknown, after: unknown): readonly string[] {
  const had = secretReferencesIn(before);
  return [...secretReferencesIn(after)]
    .filter(name => !had.has(name))
    .sort()
    .map(name => `names the secret ${name}, which only the owner may add to a configuration`);
}

export function ownSecretsPort(
  declared: readonly string[],
  references: () => ReadonlySet<string> | Promise<ReadonlySet<string>>,
  resolver: () => SecretResolver | undefined,
): SecretsPort {
  const names = new Set(declared);
  return Object.freeze({
    resolve: async (name: string) => {
      if (!WHOLE_NAME.test(name) || !names.has(name)) return { refused: 'not_declared' as const };
      let named: ReadonlySet<string>;
      try {
        named = await references();
      } catch {
        return { refused: 'not_configured' as const };
      }
      if (!named.has(name)) return { refused: 'not_configured' as const };
      const vault = resolver();
      let value: string | undefined;
      try {
        value = vault === undefined ? undefined : await vault.resolve(name);
      } catch {
        value = undefined;
      }
      return value === undefined ? { refused: 'unknown' as const } : new OwnSecret(name, value);
    },
  });
}
