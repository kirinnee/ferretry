/**
 * Profiles as an alternative to logging in: a named, reusable set of environment variables that
 * authenticates an account, with the credential itself held in this daemon's secret store.
 *
 * ## There is no second profile system
 *
 * A profile already exists. `./config.ts` declares one, `./profiles.ts` composes several of them
 * into one account, and `env` has always been one of the fields they compose. What was missing was
 * never the entity — it was a way for a profile to carry a CREDENTIAL, because every value a profile
 * held was written into a generated wrapper script in plain text. So this module adds one spelling
 * to the value grammar and nothing else: `${secret:NAME}`, the same reference `config/daemon.json`
 * already uses, resolved against the same store, by the same rule.
 *
 * That is why composition needed no work at all. Profiles compose right-overriding-left through the
 * chain {@link compositionSlots} owns, `env` merges key by key, and a variable a later profile sets
 * replaces the earlier one. A secret-backed variable composes exactly as a literal one does; the
 * only difference is where the value is when the wrapper runs.
 *
 * ## Use, never read
 *
 * `docs/secrets.md` is the contract and this module obeys it rather than reinterpreting it:
 *
 * - **No function here returns a credential.** {@link resolveSecretEnvironment} builds the map that
 *   goes straight into one child's environment and is handed to nothing else; every other function
 *   answers in names, origins and shapes.
 * - **A profile document holds a reference, never a value.** A fleet configuration copied to another
 *   machine names `WORK_KEY`; it does not carry it.
 * - **A generated wrapper never contains one either.** {@link renderWrapperScript} refuses to emit a
 *   secret-backed value as a literal — see `./wrappers.ts` for what it emits instead.
 *
 * If that makes some surface awkward, the surface is what changes. A getter added so a screen could
 * show the value would delete the property the whole subsystem exists for.
 *
 * ## Composition is visible or it is not composition
 *
 * A composed value whose origin cannot be explained is worse than no composition, so
 * {@link envComposition} answers, per variable, which slot supplied the value that won and which
 * slots it overrode. It reports the SHAPE — literal, or backed by these named secrets — and never
 * the value, so it is safe to render anywhere a name is safe to render.
 *
 * Pure throughout: no filesystem, no environment, no clock, no store.
 */
import { secretReferencesIn, SECRET_REFERENCE_SOURCE, type SecretName } from '@ferretry/protocol';
import type { AccountRoute, Agent, EnvMap, FleetConfig } from './config.ts';
import { compositionSlots, flattenForKind, type CompositionOrigin, type ResolvedAccount } from './profiles.ts';
import { envReferenceName } from './wrappers.ts';

/** Every secret an account's composed environment names, in variable order then reference order. */
export function accountSecretNames(env: Readonly<EnvMap>): readonly SecretName[] {
  const names: SecretName[] = [];
  for (const value of Object.values(env)) {
    for (const name of secretReferencesIn(value)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

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
  account: Pick<ResolvedAccount, 'id' | 'env'>,
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

/**
 * What one composed variable is, without saying what it holds.
 *
 * `literal` carries no text on purpose. Most literals are harmless — a base URL, a model name — but
 * some are not, and a shape that reported "harmless" values would need a rule deciding which is
 * which. There is no such rule that stays right, so this reports neither.
 */
export type EnvValueShape =
  | { readonly shape: 'literal' }
  /** Resolved from the process environment the wrapper is launched with; see `./wrappers.ts`. */
  | { readonly shape: 'environment-reference'; readonly variable: string }
  | { readonly shape: 'secret'; readonly secrets: readonly SecretName[] };

/** Where one composed variable's winning value came from, and what it had to override to get there. */
export interface EnvBinding {
  readonly variable: string;
  readonly shape: EnvValueShape;
  /** The composition slot that supplied the value that won. */
  readonly from: CompositionOrigin;
  /** Earlier slots that set this variable, in precedence order. Empty when nothing was overridden. */
  readonly overrode: readonly CompositionOrigin[];
}

/**
 * The shape of one configured value.
 *
 * The environment-reference half is asked of `./wrappers.ts` rather than recognised here, because
 * that module is what actually renders one and a second copy of the rule would eventually describe a
 * value differently from the way the wrapper treats it.
 */
export function envValueShape(value: string): EnvValueShape {
  const secrets = secretReferencesIn(value);
  if (secrets.length > 0) return { shape: 'secret', secrets };
  const variable = envReferenceName(value);
  return variable === undefined ? { shape: 'literal' } : { shape: 'environment-reference', variable };
}

/**
 * Every environment variable one route composes, with the slot that supplied it and the slots it
 * overrode, in sorted variable order.
 *
 * It reads the chain through {@link compositionSlots} rather than repeating the precedence order, so
 * this report and the resolution in `./profiles.ts` cannot drift into describing two different rules.
 * The two would disagree exactly where it matters most — an account whose credential is not the one
 * the report says it is.
 */
export function envComposition(
  config: FleetConfig,
  agent: Agent,
  variantName: string,
  route: AccountRoute,
): readonly EnvBinding[] {
  const contributions = new Map<string, { value: string; origins: CompositionOrigin[] }>();
  for (const slot of compositionSlots(config, agent, variantName, route)) {
    for (const [variable, value] of Object.entries(flattenForKind(slot.layer, agent.kind).env ?? {})) {
      const existing = contributions.get(variable);
      if (existing === undefined) contributions.set(variable, { value, origins: [slot.origin] });
      else {
        existing.value = value;
        existing.origins.push(slot.origin);
      }
    }
  }
  return [...contributions.entries()]
    .map(([variable, { value, origins }]): EnvBinding => {
      // The last contributor won; everything before it was overridden, in the order it was applied.
      const from = origins[origins.length - 1] ?? { kind: 'account' };
      return { variable, shape: envValueShape(value), from, overrode: origins.slice(0, -1) };
    })
    .sort((left, right) => (left.variable < right.variable ? -1 : left.variable > right.variable ? 1 : 0));
}

/**
 * One composition slot, in the words a person reads.
 *
 * Deliberately says "profile", "variant", "agent" and "this account" — never "layer" and never
 * "lane". Both were removed from every screen after the owner asked what a layer was and said it was
 * far too complicated, and a sentence explaining where somebody's API key came from is the last place
 * to reintroduce a word nobody could define.
 */
export function describeCompositionOrigin(origin: CompositionOrigin): string {
  switch (origin.kind) {
    case 'base-profile':
      return 'the base profile';
    case 'agent-profile':
    case 'variant-profile':
      return `the profile "${origin.name}"`;
    case 'variant':
      return `the variant "${origin.name}"`;
    case 'agent':
      return `the agent "${origin.name}"`;
    default:
      return 'this account';
  }
}

/**
 * One binding as a sentence, for a listing an operator reads.
 *
 * Says where the value came from and — when it was contested — what it beat, because "which profile
 * set my API key" is the question this whole report exists to answer and a reader who is only told
 * the winner cannot tell a deliberate override from a name they typed twice.
 */
export function describeEnvBinding(binding: EnvBinding): string {
  const source =
    binding.shape.shape === 'secret'
      ? `this daemon's secret store (${binding.shape.secrets.length === 1 ? 'secret' : 'secrets'} ${binding.shape.secrets.join(', ')})`
      : binding.shape.shape === 'environment-reference'
        ? `$${binding.shape.variable} in the environment that launches it`
        : 'the fleet configuration';
  const overridden =
    binding.overrode.length === 0
      ? ''
      : `, overriding ${binding.overrode.map(describeCompositionOrigin).join(' and ')}`;
  return `${binding.variable} comes from ${source}, set by ${describeCompositionOrigin(binding.from)}${overridden}`;
}

/** One account's secret-backed variables with the slot each was set by, for a management listing. */
export interface FleetSecretReference {
  readonly name: SecretName;
  /** The account this reference belongs to, by its published wrapper name. */
  readonly account: string;
  readonly variable: string;
  /** The one-line origin a management surface shows beside the name. */
  readonly origin: string;
}

/**
 * Every secret this fleet's accounts name, with an origin an operator can go and edit.
 *
 * This is what turns "a missing secret refuses the launch" into something visible BEFORE anything is
 * launched: the daemon's secret listing already shows each configured reference and whether the store
 * holds it, and a fleet account is now one of the places a reference can come from. An account whose
 * credential is missing is therefore a line on a screen rather than a session that dies at start.
 *
 * Duplicates are kept: two accounts sharing one secret are two facts, and collapsing them would hide
 * that deleting the secret breaks both.
 */
export function fleetSecretReferences(config: FleetConfig): readonly FleetSecretReference[] {
  const references: FleetSecretReference[] = [];
  for (const agent of config.agents) {
    for (const [variantName, route] of Object.entries(agent.routes)) {
      for (const binding of envComposition(config, agent, variantName, route)) {
        if (binding.shape.shape !== 'secret') continue;
        for (const name of binding.shape.secrets) {
          references.push({
            name,
            account: route.wrapper,
            variable: binding.variable,
            origin: `fleet account ${route.wrapper} → ${binding.variable}, set by ${describeCompositionOrigin(binding.from)}`,
          });
        }
      }
    }
  }
  return references;
}
