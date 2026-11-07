/**
 * Secret-backed environment: a `${secret:NAME}` reference in a credential's, a settings component's or
 * an MCP server's `env`, resolved against this daemon's secret store at launch.
 *
 * ## Use, never read
 *
 * `docs/secrets.md` is the contract and this module obeys it rather than reinterpreting it:
 *
 * - **No function here returns a credential to a caller that shows it.** {@link resolveSecretEnvironment}
 *   builds the map that goes straight into one child's environment and is handed to nothing else;
 *   every other function answers in names and origins.
 * - **The configuration holds a reference, never a value.** A configuration file copied to another machine
 *   names `WORK_KEY`; it does not carry it.
 *
 * If that makes some surface awkward, the surface is what changes. A getter added so a screen could
 * show the value would delete the property the whole subsystem exists for.
 *
 * {@link accountSecretReferences} is how a reference reaches a person before anything launches: every
 * secret the configuration names is a row in the daemon's secret listing whose origin says which
 * credential or component to go and edit.
 *
 * Pure throughout: no filesystem, no environment, no clock, no store.
 */
import { SECRET_REFERENCE_SOURCE, type SecretName, secretReferencesIn } from '@ferretry/protocol';
import type { AccountModel } from './account/schema.ts';
import type { EnvMap } from './config.ts';

/** One composed variable whose value the secret store has to supply before the account can run. */
export interface SecretEnvBinding {
  readonly variable: string;
  /** Every secret this one variable names, in first-appearance order. Never empty. */
  readonly secrets: readonly SecretName[];
}

/**
 * The variables of a composed environment that name at least one secret, in sorted variable order.
 *
 * Sorted rather than in object order, so two hosts that composed the same account report the same
 * list and a wrapper re-rendered from an unchanged configuration stays byte-identical.
 */
export function secretEnvBindings(env: Readonly<EnvMap>): readonly SecretEnvBinding[] {
  return Object.entries(env)
    .flatMap(([variable, value]) => {
      const secrets = secretReferencesIn(value);
      return secrets.length === 0 ? [] : [{ variable, secrets }];
    })
    .sort((left, right) => (left.variable < right.variable ? -1 : left.variable > right.variable ? 1 : 0));
}

/**
 * Raised when a launch would have to invent a credential.
 *
 * NEVER AN EMPTY STRING IN ITS PLACE. A blank API key is a 401 twenty minutes later, from a remote
 * service, with nothing on this machine to point at — which is the failure shape the whole secret
 * subsystem is built to avoid. Names EVERY missing secret rather than the first: somebody fixing a
 * configuration wants the list, and one at a time turns one mistake into four round trips.
 */
export class MissingFleetSecretsError extends Error {
  constructor(
    readonly account: string,
    readonly names: readonly SecretName[],
  ) {
    super(
      `account ${account} takes its environment from this daemon's secret store, which holds no secret named ${names.join(', ')}`,
    );
    this.name = 'MissingFleetSecretsError';
  }
}

/**
 * The environment one account's launch must be given: its secret-backed variables, resolved.
 *
 * THE ONLY FUNCTION IN THIS MODULE THAT TOUCHES A VALUE, and the map it returns exists to be handed
 * to exactly one launched child. It is not projected, not logged, not cached and not returned to a
 * caller that will show it to somebody — see this file's header, and `docs/secrets.md` for why a
 * getter added beside it would delete the property rather than extend it.
 *
 * Literal variables are deliberately absent: the generated wrapper already exports those itself, and
 * a second exporter would be a second place they could disagree.
 *
 * `values` is the whole store rather than the subset this account asked for, because the caller that
 * has one has all of them and filtering twice is how the two lists come apart.
 */
export function resolveSecretEnvironment(
  account: { readonly id: string; readonly env: Readonly<EnvMap> },
  values: ReadonlyMap<SecretName, string>,
): Readonly<Record<string, string>> {
  const bindings = secretEnvBindings(account.env);
  const missing: SecretName[] = [];
  for (const binding of bindings) {
    for (const name of binding.secrets) if (!values.has(name) && !missing.includes(name)) missing.push(name);
  }
  if (missing.length > 0) throw new MissingFleetSecretsError(account.id, missing);

  const environment: Record<string, string> = {};
  for (const binding of bindings) {
    // Present for every name: the loop above refused the whole launch otherwise. Read through a
    // fallback rather than asserted, so this stays a total function if somebody reorders it.
    environment[binding.variable] = (account.env[binding.variable] ?? '').replace(
      new RegExp(SECRET_REFERENCE_SOURCE, 'gu'),
      (_match, name: string) => values.get(name) ?? '',
    );
  }
  return environment;
}

/** One secret the configuration names, with where it is named. */
export interface AccountSecretReference {
  readonly name: SecretName;
  /** The one-line origin a management surface shows beside the name: what to go and edit. */
  readonly origin: string;
}

/**
 * Every secret this configuration names — in a credential kept in the environment, a settings
 * component or an MCP server — with an origin an operator can go and edit.
 *
 * This is what turns "a missing secret refuses the launch" into something visible BEFORE anything is
 * launched: the daemon's secret listing shows each reference and whether the store holds it.
 *
 * Duplicates are kept: two places naming one secret are two facts, and collapsing them would hide
 * that deleting the secret breaks both. Ordered by where they are named, then by variable.
 */
export function accountSecretReferences(model: AccountModel): readonly AccountSecretReference[] {
  const named = (where: string, env: Readonly<EnvMap> | undefined): AccountSecretReference[] =>
    secretEnvBindings(env ?? {}).flatMap(binding =>
      binding.secrets.map(name => ({ name, origin: `${where} env ${binding.variable}` })),
    );
  return [
    ...Object.entries(model.credentials).flatMap(([id, credential]) => named(`credential ${id}`, credential.env)),
    ...Object.entries(model.components.settings).flatMap(([name, settings]) => named(`settings/${name}`, settings.env)),
    ...Object.entries(model.components.mcp).flatMap(([name, server]) => named(`mcp/${name}`, server.env)),
  ];
}
