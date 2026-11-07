import { CORE_IDS } from '@ferretry/kernel/contract';
import { neederMayReach, neederMayRun, type Needer } from '@ferretry/kernel/manifest';
import {
  optionalSecretReferenceOf,
  secretReferencesIn,
  type SecretName,
  type SecretUseCommand,
} from '../../../contract/index.ts';

/**
 * WHAT A PLUGIN MAY REACH THROUGH THE VAULT (§3.7). The Vault holds `'*'` for spawn and network because a use runs
 * whatever program a `${secret:NAME}` command names and a fetch goes to whichever host a secret's allowlist names;
 * handed to every needer unchanged, that `'*'` would let any plugin that needs the Vault reach any host, secret or
 * program. So the kernel builds the port once per needer ({@link Needer}), and a NON-core needer is held to what its
 * own manifest and its own records already allow. A core caller keeps the Vault's own reach.
 */
export const isCoreNeeder = (needer: Needer): boolean => (CORE_IDS as readonly string[]).includes(needer.id);

/**
 * THE ONE PLACE a needer's allowed secret names are decided. Today there are two sources:
 *
 *   1. the secret names its manifest declares (`permissions.secrets`), and
 *   2. the `${secret:NAME}` references written in the config defs the plugin's manifest MARKS as credential records
 *      (`credentialRecords`: Logins' login records, MCP's server entries), as they are in effect: a reference added by a
 *      plugin or a hand edit is held for the owner and is NOT in effect, so only an owner-written reference counts. A
 *      reference in any other file the plugin owns (Logins' endpoints and models) counts for nothing.
 *
 * A caller never supplies this list; a third source is added here and nowhere else.
 */
export function allowedSecretNames(needer: Needer): ReadonlySet<string> {
  return new Set([...(needer.permissions.secrets ?? []), ...needer.ownedSecretReferences()]);
}

/** Whether `needer` may put the secret `name` to use. */
export const mayUseSecret = (needer: Needer, name: string): boolean => allowedSecretNames(needer).has(name);

/**
 * Whether `name` is one the needer MINTS itself: a name its manifest's `permissions.mintedSecrets` pattern matches
 * whole (MCP's OAuth access tokens, in today's exact shape). A plugin that declares none mints none.
 */
export const isMintedSecret = (needer: Needer, name: string): boolean =>
  (needer.permissions.mintedSecrets ?? []).some(source => new RegExp(`^(?:${source})$`, 'u').test(name));

/**
 * Whether `needer` may put, remove, list or ask for the secret `name`: one it may use ({@link allowedSecretNames}) or one
 * it mints ({@link isMintedSecret}). The write reach of a non-core needer is exactly this and no more.
 */
export const mayTouchSecret = (needer: Needer, name: string): boolean =>
  mayUseSecret(needer, name) || isMintedSecret(needer, name);

/**
 * Whether the needer's `names()` is held to {@link mayTouchSecret}. ONE switch: a needer whose manifest declares the
 * secret-name picker (`permissions.secretNamePicker`, Catalogs' install mapping) is listed every NAME, never a value;
 * the plugin gates who may see that list (the secrets-use grant). Every other non-core needer is narrowed.
 */
export const namesAreNarrowed = (needer: Needer): boolean => needer.permissions.secretNamePicker !== true;

/** Every secret a run names: the ones it lists, and every `${secret:NAME}` or `${secret?:NAME}` in its environment. */
export function secretsNamedBy(command: Pick<SecretUseCommand, 'secrets' | 'env'>): readonly SecretName[] {
  const named = new Set<SecretName>(command.secrets);
  for (const value of Object.values(command.env)) {
    for (const name of secretReferencesIn(value)) named.add(name);
    const optional = optionalSecretReferenceOf(value);
    if (optional !== undefined) named.add(optional);
  }
  return [...named];
}

/** The hosts of `hostAllowlist` the needer's own network entries allow (an allowlist entry may carry a port). */
export function reachableHosts(needer: Needer, hostAllowlist: readonly string[]): readonly string[] {
  return hostAllowlist.filter(entry => neederMayReach(needer, hostnameOf(entry)));
}

/** Whether the needer may run `program` (by its manifest's own `permissions.spawn`). */
export const mayRunProgram = (needer: Needer, program: string): boolean => neederMayRun(needer, program);

/** `host:port` → `host`; a bracketed IPv6 literal keeps its brackets, as a URL's hostname does. */
function hostnameOf(entry: string): string {
  if (entry.startsWith('[')) return entry.slice(0, entry.indexOf(']') + 1);
  const colon = entry.lastIndexOf(':');
  return colon === -1 ? entry : entry.slice(0, colon);
}

/** The refusal for a secret a non-core needer may neither write nor remove: the Vault's own sentence for it. */
export class UndeclaredSecretError extends Error {
  constructor(needer: Needer, name: string, verb: 'write' | 'remove') {
    super(`${needer.id} may not ${verb} the secret ${name}: its manifest does not declare it.`);
    this.name = 'PermissionError';
  }
}

/**
 * The refusal for a program the needer's manifest does not declare: the kernel's own sentence for it
 * (`restrictSpawn`'s), under the name the kernel gives it, so a caller meets the same refusal either way.
 */
export class UndeclaredProgramError extends Error {
  constructor(needer: Needer, program: string) {
    super(`${needer.id} may not run ${program.slice(program.lastIndexOf('/') + 1)}: its manifest does not declare it.`);
    this.name = 'PermissionError';
  }
}
