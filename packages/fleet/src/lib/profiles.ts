/**
 * Profile resolution — collapse the configuration's composition layers into one flat account per
 * declared route, then project those accounts onto the manifest.
 *
 * Precedence, right overriding left:
 *
 * ```
 * base → agent.profiles → variant.profiles → variant.inline → agent.inline → route.layer
 * ```
 *
 * `route.layer` is last because it belongs to exactly one account. Every earlier slot is shared by
 * construction — an agent's inline fields reach all of that agent's routes — so the only place a
 * single account's instructions, skills, settings or environment can differ is its own layer.
 *
 * Per field: `env` merges key-by-key, `flags` and `settings` **concatenate** (settings layers are
 * deep-merged later, at materialization, so ordering is the whole contract), and every other field
 * is a scalar the last writer replaces.
 *
 * Each slot is flattened for the agent's harness **as it is applied**, so a `claude:` / `codex:`
 * overlay wins inside its own slot while a later slot's flat field still beats an earlier slot's
 * overlay. That ordering is what lets one cross-harness variant vary a per-harness asset without
 * the override leaking onto the other harness.
 *
 * Pure throughout: no filesystem, no environment, no clock.
 */
import type { AccountRoute, Agent, BaseProfile, EnvMap, FleetConfig, Profile, SettingsLayer } from './config.ts';
import type { AccountMode, FleetManifestAccount, FleetManifestModel, HarnessKind } from './manifest.ts';

/** The optional profile applied to every agent before its own. Absent is not an error. */
export const BASE_PROFILE_NAME = 'base';

/** One flat account: a route with its composition layers already collapsed. */
export interface ResolvedAccount {
  /** The only key any consumer joins on. */
  readonly id: string;
  readonly kind: HarnessKind;
  readonly mode: AccountMode;
  readonly wrapper: string;
  readonly home: string;
  readonly displayName: string;
  /** The agent this account belongs to, as declared. Never parsed out of a name. */
  readonly agent: string;
  /** The variant lane this account occupies. */
  readonly variant: string;
  /** The agent whose provider login this account shares. */
  readonly identity: string;
  readonly auth: 'oauth' | 'api-key';
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly defaultModel: string | null;
  readonly models: readonly FleetManifestModel[];
  readonly env: Readonly<EnvMap>;
  readonly flags: readonly string[];
  readonly settings: readonly SettingsLayer[];
  readonly memory: string | undefined;
  readonly skills: string | undefined;
  readonly hooks: string | undefined;
  readonly hooksDir: string | undefined;
  readonly mcp: string | undefined;
}

/** A generated executable that runs one account's wrapper with flags prepended. */
export interface ResolvedCommand {
  readonly wrapper: string;
  /** The account this command runs, by id. */
  readonly target: string;
  readonly flags: readonly string[];
  /** The alias that produced this command, when it was not declared explicitly. */
  readonly alias: string | undefined;
}

/** One slot's settings field as a list, so concatenation is total. A single layer is a list of one. */
export const settingsLayersOf = (settings: BaseProfile['settings']): readonly SettingsLayer[] =>
  settings === undefined ? [] : Array.isArray(settings) ? settings : [settings];

/** Accumulated flat fields. `flags`/`settings` are always lists so concatenation is total. */
interface Accumulated {
  env: EnvMap;
  flags: string[];
  settings: SettingsLayer[];
  memory: string | undefined;
  skills: string | undefined;
  hooks: string | undefined;
  hooksDir: string | undefined;
  mcp: string | undefined;
}

const emptyAccumulator = (): Accumulated => ({
  env: {},
  flags: [],
  settings: [],
  memory: undefined,
  skills: undefined,
  hooks: undefined,
  hooksDir: undefined,
  mcp: undefined,
});

/** Apply one already-flattened layer onto the accumulator, right overriding left. */
const applyLayer = (accumulated: Accumulated, layer: BaseProfile): Accumulated => ({
  env: { ...accumulated.env, ...(layer.env ?? {}) },
  flags: [...accumulated.flags, ...(layer.flags ?? [])],
  settings: [...accumulated.settings, ...settingsLayersOf(layer.settings)],
  memory: layer.memory ?? accumulated.memory,
  skills: layer.skills ?? accumulated.skills,
  hooks: layer.hooks ?? accumulated.hooks,
  hooksDir: layer.hooksDir ?? accumulated.hooksDir,
  mcp: layer.mcp ?? accumulated.mcp,
});

/**
 * Collapse one layer's harness overlay onto its own flat fields and drop both overlay blocks, so
 * the overlay wins within this slot only.
 */
export const flattenForKind = (layer: Profile, kind: HarnessKind): BaseProfile => {
  const { claude, codex, ...flat } = layer;
  const overlay = kind === 'claude' ? claude : codex;
  return overlay === undefined ? flat : applyLayer(applyLayer(emptyAccumulator(), flat), overlay);
};

/**
 * Where one composition slot came from.
 *
 * Named, because "is this account's instructions the shared default or its own copy" is a question
 * about *which slot supplied the value*, and a consumer that had to guess would be reading the
 * precedence order a second time. Every slot except `account` is shared by construction: an agent's
 * inline fields reach all of that agent's routes, and a profile reaches every agent that lists it.
 */
export type CompositionOrigin =
  | { readonly kind: 'base-profile'; readonly name: string }
  | { readonly kind: 'agent-profile'; readonly name: string }
  | { readonly kind: 'variant-profile'; readonly name: string }
  | { readonly kind: 'variant'; readonly name: string }
  | { readonly kind: 'agent'; readonly name: string }
  | { readonly kind: 'account' };

/** One layer of the composition chain, with the slot that contributed it. */
export interface CompositionSlot {
  readonly origin: CompositionOrigin;
  readonly layer: Profile;
}

const namedProfileSlots = (
  config: FleetConfig,
  names: readonly string[],
  kind: 'agent-profile' | 'variant-profile',
): readonly CompositionSlot[] =>
  names.flatMap(name => {
    const profile = config.profiles[name];
    // An unknown name is refused by the configuration schema's cross-reference check, so this is
    // only ever reached by a caller that built a config value by hand rather than by parsing one.
    return profile === undefined ? [] : [{ origin: { kind, name } as CompositionOrigin, layer: profile }];
  });

/**
 * The composition chain for one route, in precedence order, left overridden by right.
 *
 * The single owner of that order. {@link resolveAccounts} reduces it into flat fields and
 * `sharing.ts` reduces it into provenance; two hand-written orderings would be two descriptions of
 * one rule, and the one that drifted would report an account as sharing a document it does not use.
 */
export function compositionSlots(
  config: FleetConfig,
  agent: Agent,
  variantName: string,
  route: AccountRoute,
): readonly CompositionSlot[] {
  const baseProfile = config.profiles[BASE_PROFILE_NAME];
  const variant = config.variants[variantName];
  return [
    ...(baseProfile === undefined
      ? []
      : [{ origin: { kind: 'base-profile', name: BASE_PROFILE_NAME } as CompositionOrigin, layer: baseProfile }]),
    ...namedProfileSlots(config, agent.profiles ?? [], 'agent-profile'),
    ...namedProfileSlots(config, variant?.profiles ?? [], 'variant-profile'),
    ...(variant === undefined
      ? []
      : [{ origin: { kind: 'variant', name: variantName } as CompositionOrigin, layer: inlineOf(variant) }]),
    { origin: { kind: 'agent', name: agent.name } as CompositionOrigin, layer: inlineOf(agent) },
    ...(route.layer === undefined ? [] : [{ origin: { kind: 'account' } as CompositionOrigin, layer: route.layer }]),
  ];
}

const inlineOf = (source: Agent | (Profile & { profiles?: readonly string[]; mode?: AccountMode })): Profile => {
  const { profiles: _profiles, ...rest } = source as Profile & { profiles?: readonly string[] };
  const inline = rest as Record<string, unknown>;
  delete inline.name;
  delete inline.kind;
  delete inline.auth;
  delete inline.identity;
  delete inline.routes;
  delete inline.mode;
  return inline as Profile;
};

const displayNameOf = (route: AccountRoute): string => route.displayName ?? route.wrapper;

const modelsOf = (route: AccountRoute): readonly FleetManifestModel[] =>
  route.models.map(model =>
    model.available
      ? {
          id: model.id,
          available: true as const,
          ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
        }
      : {
          id: model.id,
          available: false as const,
          unavailableReason: model.unavailableReason,
          ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
        },
  );

/**
 * Resolve every declared route into a flat account, in configuration order (agents outer, that
 * agent's routes inner). A route the author did not declare produces no account: participation is
 * opt-in, so adding a variant can never silently mint accounts across the whole fleet.
 */
export function resolveAccounts(config: FleetConfig): readonly ResolvedAccount[] {
  const accounts: ResolvedAccount[] = [];

  for (const agent of config.agents) {
    for (const [variantName, route] of Object.entries(agent.routes)) {
      const variant = config.variants[variantName];
      const resolved = compositionSlots(config, agent, variantName, route).reduce(
        (accumulated, slot) => applyLayer(accumulated, flattenForKind(slot.layer, agent.kind)),
        emptyAccumulator(),
      );

      accounts.push({
        id: route.id,
        kind: agent.kind,
        mode: route.mode ?? variant?.mode ?? 'interactive',
        wrapper: route.wrapper,
        home: route.home,
        displayName: displayNameOf(route),
        agent: agent.name,
        variant: variantName,
        identity: agent.identity ?? agent.name,
        auth: agent.auth,
        available: route.available,
        unavailableReason: route.unavailableReason ?? null,
        defaultModel: route.defaultModel ?? null,
        models: modelsOf(route),
        env: resolved.env,
        flags: resolved.flags,
        settings: resolved.settings,
        memory: resolved.memory,
        skills: resolved.skills,
        hooks: resolved.hooks,
        hooksDir: resolved.hooksDir,
        mcp: resolved.mcp,
      });
    }
  }

  return accounts;
}

const flagList = (flags: string | readonly string[]): readonly string[] =>
  typeof flags === 'string' ? flags.trim().split(/\s+/).filter(Boolean) : flags;

/**
 * Fan each alias out into one command per account of every harness it lists. The generated wrapper
 * name is `<alias>-<account wrapper>`; because two different (alias, wrapper) pairs can compose to
 * the same string, collisions are detected rather than silently overwritten.
 */
export function expandAliases(config: FleetConfig, accounts: readonly ResolvedAccount[]): readonly ResolvedCommand[] {
  const commands: ResolvedCommand[] = [];
  for (const [alias, byKind] of Object.entries(config.aliases)) {
    for (const account of accounts) {
      const flags = byKind[account.kind];
      if (flags === undefined) continue;
      commands.push({
        wrapper: `${alias}-${account.wrapper}`,
        target: account.id,
        flags: flagList(flags),
        alias,
      });
    }
  }
  return commands;
}

/** Raised when two generated executables would claim the same name. */
export class WrapperCollisionError extends Error {
  constructor(
    readonly wrapper: string,
    readonly claimants: readonly string[],
  ) {
    super(`wrapper "${wrapper}" is claimed by more than one generator: ${claimants.join(', ')}`);
    this.name = 'WrapperCollisionError';
  }
}

const claimantOf = (command: ResolvedCommand): string =>
  command.alias === undefined ? `command ${command.wrapper}` : `alias ${command.alias} → ${command.target}`;

/**
 * Every generated command: those declared explicitly, then the alias fan-out. Throws on a name
 * claimed twice — by two aliases, by an alias and a command, or by a command and an account.
 */
export function resolveCommands(config: FleetConfig, accounts: readonly ResolvedAccount[]): readonly ResolvedCommand[] {
  const explicit: readonly ResolvedCommand[] = config.commands.map(command => ({
    wrapper: command.wrapper,
    target: command.target,
    flags: command.flags,
    alias: undefined,
  }));
  const commands = [...explicit, ...expandAliases(config, accounts)];

  const claimants = new Map<string, string[]>();
  for (const account of accounts) claimants.set(account.wrapper, [`account ${account.id}`]);
  for (const command of commands) {
    const existing = claimants.get(command.wrapper);
    if (existing === undefined) claimants.set(command.wrapper, [claimantOf(command)]);
    else existing.push(claimantOf(command));
  }
  for (const [wrapper, owners] of claimants) {
    if (owners.length > 1) throw new WrapperCollisionError(wrapper, owners);
  }

  return commands;
}

/**
 * Project resolved accounts onto the manifest's account shape, ready to be parsed and published.
 *
 * The manifest publishes `wrapper` as the executable's full path, because a consumer must be able to
 * launch an account without knowing where wrappers live or reassembling a name. `binDirectory` is
 * where provisioning writes them.
 */
export function toManifestAccounts(
  accounts: readonly ResolvedAccount[],
  binDirectory: string,
): readonly FleetManifestAccount[] {
  const separator = binDirectory.endsWith('/') ? '' : '/';
  return accounts.map(account => ({
    id: account.id,
    kind: account.kind,
    mode: account.mode,
    wrapper: `${binDirectory}${separator}${account.wrapper}`,
    home: account.home,
    displayName: account.displayName,
    defaultModel: account.defaultModel,
    models: [...account.models],
    available: account.available,
    unavailableReason: account.unavailableReason,
  }));
}

/** Accounts sharing one provider login, keyed by `<kind>:<identity>`. */
export function groupByIdentity(accounts: readonly ResolvedAccount[]): ReadonlyMap<string, readonly ResolvedAccount[]> {
  const groups = new Map<string, ResolvedAccount[]>();
  for (const account of accounts) {
    const key = `${account.kind}:${account.identity}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [account]);
    else existing.push(account);
  }
  return groups;
}
