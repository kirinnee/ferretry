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
 * That report reaches a person through {@link fleetSecretReferences}: every secret an account reaches
 * for is a row in the daemon's secret listing whose origin names the account, the variable, the slot
 * that set it and the slots it beat. There is deliberately no per-variable composition surface beyond
 * that — see `docs/fleet-env-profiles.md`, which declares its absence rather than shipping a report
 * nothing renders.
 *
 * Pure throughout: no filesystem, no environment, no clock, no store.
 */
import {
  type FleetProfileDeclaration,
  secretReference,
  secretReferencesIn,
  SECRET_REFERENCE_SOURCE,
  type SecretName,
} from '@ferretry/protocol';
import type { AccountRoute, Agent, EnvMap, FleetConfig } from './config.ts';
import { HARNESS_CREDENTIAL_ENV } from './credential-source.ts';
import type { HarnessKind } from './manifest.ts';
import {
  BASE_PROFILE_NAME,
  compositionSlots,
  flattenForKind,
  type CompositionOrigin,
  type ResolvedAccount,
} from './profiles.ts';
import { envReferenceName } from './wrappers.ts';

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
 * Which slot won this variable and — when it was contested — what it beat, as one clause.
 *
 * The second half is not decoration. "Which profile set my API key" is the question this whole report
 * exists to answer, and a reader told only the winner cannot tell a deliberate override from a name
 * they typed into two profiles by mistake.
 */
function describeContest(binding: EnvBinding): string {
  const overridden =
    binding.overrode.length === 0
      ? ''
      : `, overriding ${binding.overrode.map(describeCompositionOrigin).join(' and ')}`;
  return `set by ${describeCompositionOrigin(binding.from)}${overridden}`;
}

// ─── the profiles this fleet declares, as a surface has to offer them ──────────────────────────

/** The harness kinds, annotated so a new one is a compile error here rather than a silent omission. */
const HARNESS_KINDS: readonly HarnessKind[] = ['claude', 'codex'];

/** One variable a profile sets: flat when `harness` is absent, from that harness's overlay when it is. */
export interface ProfileVariableEntry {
  readonly variable: string;
  readonly shape: EnvValueShape;
  readonly harness?: HarnessKind;
}

/**
 * One declared profile, in the facts a surface that OFFERS it needs and none it does not.
 *
 * Shapes rather than values, for the reason this whole module carries: see {@link envValueShape}. The
 * two derived fields are the ones a browser cannot answer for itself — which accounts already compose
 * this profile, and whether it can authenticate an account of a given harness with no login at all.
 */
export interface ProfileCatalogEntry {
  readonly name: string;
  /** True for `base`, the profile every account composes first. Not a choice anybody makes. */
  readonly appliesToEveryAccount: boolean;
  readonly variables: readonly ProfileVariableEntry[];
  /** Wrappers whose account composes this profile, in fleet order. */
  readonly accounts: readonly string[];
  /** Harnesses whose credential variable this profile sets. Empty means it authenticates nothing. */
  readonly authenticates: readonly HarnessKind[];
}

/** Every variable one profile sets, flat entries first and each harness's overlay after them. */
function profileVariables(config: FleetConfig, name: string): readonly ProfileVariableEntry[] {
  const profile = config.profiles[name];
  if (profile === undefined) return [];
  const sorted = (env: Readonly<EnvMap> | undefined): readonly (readonly [string, string])[] =>
    Object.entries(env ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return [
    ...sorted(profile.env).map(([variable, value]) => ({ variable, shape: envValueShape(value) })),
    ...HARNESS_KINDS.flatMap(harness =>
      sorted((harness === 'claude' ? profile.claude : profile.codex)?.env).map(([variable, value]) => ({
        variable,
        shape: envValueShape(value),
        harness,
      })),
    ),
  ];
}

/**
 * Which harnesses this profile can authenticate an account of, with no login at all.
 *
 * The question a surface has to answer before it offers "no login": a profile that sets
 * `ANTHROPIC_API_KEY` authenticates a Claude account, and one that sets only a base URL authenticates
 * nothing — an account bound to it still needs its sign-in, and a screen that said otherwise would be
 * sending somebody to an account that cannot start. Asked per harness through {@link flattenForKind},
 * because the overlay is exactly where a cross-harness profile puts the key that differs.
 *
 * `HARNESS_CREDENTIAL_ENV` is read rather than restated: it is `./credential-source.ts`'s list of the
 * variables that stand in for a login, and a second copy would be the one that missed a variable.
 */
function profileAuthenticates(config: FleetConfig, name: string): readonly HarnessKind[] {
  const profile = config.profiles[name];
  if (profile === undefined) return [];
  return HARNESS_KINDS.filter(harness => {
    const env = flattenForKind(profile, harness).env ?? {};
    return HARNESS_CREDENTIAL_ENV[harness].some(variable => env[variable] !== undefined);
  });
}

/**
 * Every profile this fleet declares, with the accounts already composing each one.
 *
 * The membership half reads {@link compositionSlots} rather than the `profiles:` arrays directly, so
 * "which accounts compose this" cannot come to disagree with what those accounts actually resolve —
 * an agent's list and a variant's list are two ways in, and a report that read one of them would
 * quietly omit the other.
 */
export function profileCatalog(config: FleetConfig): readonly ProfileCatalogEntry[] {
  const members = new Map<string, string[]>();
  for (const agent of config.agents) {
    for (const [variantName, route] of Object.entries(agent.routes)) {
      for (const slot of compositionSlots(config, agent, variantName, route)) {
        if (slot.origin.kind === 'variant' || slot.origin.kind === 'agent' || slot.origin.kind === 'account') continue;
        const held = members.get(slot.origin.name);
        if (held === undefined) members.set(slot.origin.name, [route.wrapper]);
        else if (!held.includes(route.wrapper)) held.push(route.wrapper);
      }
    }
  }
  return Object.keys(config.profiles)
    .sort()
    .map(name => ({
      name,
      appliesToEveryAccount: name === BASE_PROFILE_NAME,
      variables: profileVariables(config, name),
      accounts: members.get(name) ?? [],
      authenticates: profileAuthenticates(config, name),
    }));
}

/**
 * The environment map one DECLARED profile carries, composed from the three spellings a caller may ask
 * for.
 *
 * The single producer of `${secret:NAME}` on the write path, through `secretReference`, which is the
 * whole reason a caller declares a secret by name rather than sending text: a near miss like
 * `${secret:work_key}` matches nothing, stays a literal, and authenticates a child with the eighteen
 * characters of the reference itself. A shape that cannot say it cannot make that mistake.
 *
 * It composes an ordinary `env` map and nothing else, so a declared profile is byte-for-byte the kind
 * of document somebody could have written by hand — there is no second kind of profile.
 */
export function declaredProfileEnv(declaration: FleetProfileDeclaration): EnvMap {
  const env: Record<string, string> = {};
  for (const entry of declaration.variables) {
    if (entry.from === 'secret') env[entry.variable] = secretReference(entry.secret);
    else if (entry.from === 'environment') env[entry.variable] = `$${entry.source}`;
    else env[entry.variable] = entry.value;
  }
  return env;
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
            origin: `fleet account ${route.wrapper} → ${binding.variable}, ${describeContest(binding)}`,
          });
        }
      }
    }
  }
  return references;
}
