/**
 * The three things a remote caller may ask the fleet configuration to become.
 *
 * A caller never sends a configuration document. It sends one named intent, and the daemon derives
 * the next configuration from the current one — which is what makes the change reviewable: an
 * arbitrary whole-config replacement can differ from what was previewed in ways nobody reads, while
 * "create this account" has one meaning and one derivation.
 *
 * Identity is minted here too. A client-supplied account id would let one caller collide with, or
 * silently re-point, an account it does not own; the wrapper and home names are derived from the
 * declared account name for the same reason, and every derivation is checked by the shared
 * configuration schema before it can be previewed.
 */
import {
  type AccountModel,
  AccountModelSchema,
  type ComponentKind,
  componentFilePath,
  declaredProfileEnv,
  derivedWrapperName,
  type FleetConfig,
  FleetConfigSchema,
  type FleetManifestModel,
  freeName,
  HARNESS_DISPLAY_NAMES,
  type HarnessKind,
  isRuntimeName,
  looksSecret,
  orphanedSharedDocuments,
  parseLayerReference,
  parseSettings,
  resolveProfile,
  SafeNameSchema,
  type SettingsFormat,
  slugName,
  wouldIncludeItself,
} from '@ferretry/fleet';
import {
  type FleetAccountChange,
  type FleetComponentInput,
  type FleetEnvInput,
  type FleetModelDeclaration,
  type FleetMutation,
  FleetMutationSchema,
} from '@ferretry/protocol';
import {
  componentUsage,
  counted,
  editConsequence,
  listed,
  profileUsage,
  runtimesUsingCredential,
  runtimesUsingProfile,
} from './catalog.ts';
import { planSharedAssetUnlink, sharedAssetLinkPath } from './sharing.ts';

/**
 * The wire shape is the shared one. This module owns what a mutation *means* — how it derives the
 * next configuration — not how it is spelled on the wire, and two spellings would drift.
 */
export { FleetMutationSchema, type FleetMutation };

/** The lane an account occupies when the caller does not name one. */
const DEFAULT_VARIANT = 'default';

/** A refusal the caller can act on, rather than a schema violation or a daemon defect. */
export class FleetMutationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetMutationRefusal';
  }
}

/** One lane a create asks for, with the default this module supplies for a lane that names none. */
interface CreateLane {
  readonly variant: string;
  readonly mode?: 'interactive' | 'auto';
}

/**
 * The lanes a create names, each with its variant defaulted. Defaulted here rather than in the wire
 * schema, because the fallback lane is a fact about this fleet and not about the wire.
 */
const lanesOf = (mutation: Extract<FleetMutation, { kind: 'create-account' }>): readonly CreateLane[] =>
  mutation.lanes.map(lane => ({
    variant: lane.variant ?? DEFAULT_VARIANT,
    ...(lane.mode === undefined ? {} : { mode: lane.mode }),
  }));

/**
 * Every wrapper name one create-account will publish, in the order its lanes were named.
 *
 * Exported because the route that SUMMARIZES a staged change has to say what it will add, and a
 * summary that named one wrapper for a change adding two would be a one-line description a person
 * approves that is not what happens. It reads {@link derivedWrapperName} rather than restating the
 * naming rule, and it is the one thing a caller outside this module needs from a create.
 */
export function createdWrapperNames(mutation: Extract<FleetMutation, { kind: 'create-account' }>): readonly string[] {
  return lanesOf(mutation).map(lane => derivedWrapperName(mutation.harness, mutation.name, lane.variant));
}

/** Availability defaults to true: an account nobody said was down is up. */
const availabilityOf = (mutation: Extract<FleetMutation, { kind: 'create-account' }>): boolean =>
  mutation.available ?? true;

/**
 * One model declaration, from what the account already says about it and what this change says.
 *
 * ABSENT MEANS "LEAVE IT ALONE" ONE LEVEL BELOW THE FIELD. A surface that lists a model without an
 * opinion about its availability is the ordinary case — a ticked card knows an identifier and nothing
 * else — and reading that silence as "available" is what put a model back into service and threw away
 * the reason somebody wrote for taking it out.
 *
 * The refusal at the end is the one rule the wire schema cannot check, because it depends on what the
 * account already declares: a model may be taken out of service without repeating a reason it already
 * carries, but one that has never had a reason must be given one here.
 */
function declaredModel(existing: FleetManifestModel | undefined, change: FleetModelDeclaration): FleetManifestModel {
  const displayName = change.displayName === null ? undefined : (change.displayName ?? existing?.displayName);
  const named = displayName === undefined ? {} : { displayName };
  if (change.available ?? existing?.available ?? true) return { id: change.id, available: true, ...named };
  const carried = existing?.available === false ? existing.unavailableReason : undefined;
  const unavailableReason = change.unavailableReason ?? carried;
  if (unavailableReason === undefined) {
    throw new FleetMutationRefusal(
      `model "${change.id}" is declared unavailable but does not say why — give it an unavailableReason`,
    );
  }
  return { id: change.id, available: false, unavailableReason, ...named };
}

/** A change that names one model twice has two answers for it and no way to say which won. */
function assertModelsNamedOnce(changes: readonly FleetModelDeclaration[]): void {
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.id)) {
      throw new FleetMutationRefusal(`this change names the model "${change.id}" twice`);
    }
    seen.add(change.id);
  }
}

/**
 * The model list an account has after a change that names some of them.
 *
 * A NAMED MODEL IS MERGED over what the account already declared. An UNNAMED one is kept when it is
 * out of service and dropped when it is in service, and that asymmetry is the whole fix: the surface
 * sending the list is a set of ticked cards, and by design a card is never offered for a model the
 * account cannot serve, so the list arrives already missing every unavailable entry. Replacing the
 * list with it deleted those entries and the reasons written on them, and the result was a legal
 * configuration, so nothing anywhere complained.
 *
 * Removing an out-of-service model is therefore two changes rather than none — put it back into
 * service, then leave it out — which is the right way round: one request cannot both fail to mention a
 * model and mean to delete it.
 *
 * Order is the account's, not the change's. An existing model keeps its position and only genuinely
 * new ones are appended, so a change that alters one entry does not read as a reordering of the rest
 * in the roster diff a person approves.
 */
function mergedModels(
  existing: readonly FleetManifestModel[],
  changes: readonly FleetModelDeclaration[],
): readonly FleetManifestModel[] {
  assertModelsNamedOnce(changes);
  const named = new Map(changes.map(change => [change.id, change]));
  const kept = existing.flatMap(model => {
    const change = named.get(model.id);
    if (change !== undefined) return [declaredModel(model, change)];
    return model.available ? [] : [model];
  });
  const before = new Set(existing.map(model => model.id));
  const added = changes.filter(change => !before.has(change.id)).map(change => declaredModel(undefined, change));
  return [...kept, ...added];
}

/**
 * The fields every route this create produces carries, plus the one that is the LANE's.
 *
 * Everything but the mode is shared: one provider account, one model list, one overlay, one display
 * name. The mode is per lane because that is what distinguishes the accounts — an unattended lane
 * publishes `auto` so consumers know it may be driven without a person, and the interactive one does
 * not.
 */
const createFields = (
  mutation: Extract<FleetMutation, { kind: 'create-account' }>,
  lane: CreateLane,
): Record<string, unknown> => ({
  // Through the same merge an edit uses, against nothing: a create has no prior list, so every
  // declaration is new and the normalization is all that is left of it.
  models: mergedModels([], mutation.models),
  available: availabilityOf(mutation),
  ...(mutation.displayName === undefined ? {} : { displayName: mutation.displayName }),
  ...(lane.mode === undefined ? {} : { mode: lane.mode }),
  ...(mutation.defaultModel === undefined ? {} : { defaultModel: mutation.defaultModel }),
  ...(mutation.unavailableReason === undefined ? {} : { unavailableReason: mutation.unavailableReason }),
  ...(mutation.layer === undefined || mutation.layer === null ? {} : { layer: mergedLayer({}, mutation.layer) }),
});

/** Absent leaves a field alone, `null` removes it, anything else replaces it. */
function patched(existing: Record<string, unknown>, changes: Record<string, unknown | null | undefined>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null) delete existing[key];
    else existing[key] = value;
  }
}

/**
 * Merge an overlay patch into the overlay an account already has.
 *
 * Replacing it outright would erase every field the editor sending the patch does not display —
 * flags, hooks, the per-harness overlays — so an account that had them would silently lose them the
 * first time somebody changed its instructions. Absent keeps, `null` removes, and the `claude` and
 * `codex` overlays merge by the same rule one level down.
 */
function mergedLayer(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete next[key];
      continue;
    }
    if (key === 'claude' || key === 'codex') {
      next[key] = mergedLayer((next[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    next[key] = value;
  }
  return next;
}

/** An available account has to be able to serve something, and name which of it is the default. */
function assertServable(mutation: Extract<FleetMutation, { kind: 'create-account' }>): void {
  if (!availabilityOf(mutation)) {
    if (mutation.unavailableReason === undefined) {
      throw new FleetMutationRefusal('an unavailable account must say why it is unavailable');
    }
    return;
  }
  // What it can SERVE, not what it lists. A create may declare a model already out of service — that
  // is the whole point of the declaration — and an account whose every model is down can serve
  // nothing, however long its list is.
  const servable = mutation.models.filter(model => model.available !== false).map(model => model.id);
  if (servable.length === 0) {
    throw new FleetMutationRefusal('an available account must list at least one model it can serve');
  }
  if (mutation.defaultModel === undefined) {
    throw new FleetMutationRefusal('an available account must name the default model it serves');
  }
  if (!servable.includes(mutation.defaultModel)) {
    // The two are a different mistake with a different remedy: one model is missing from the list and
    // the other is in it and declared down, so a single sentence for both would send half the readers
    // to fix the wrong thing. The choice is a value rather than an argument spanning lines, because a
    // `throw new X(\n <ternary> \n)` leaves its own closing line unreachable and the ledger says so.
    const remedy = mutation.models.some(model => model.id === mutation.defaultModel)
      ? 'is one this account declares unavailable'
      : 'is not one of the models this account lists';
    throw new FleetMutationRefusal(`the default model "${mutation.defaultModel}" ${remedy}`);
  }
}

/**
 * Every lane this create asks for, refused before ANY of them is added when one cannot be.
 *
 * The order is the point. A create naming two lanes derives two routes, and a check that ran per
 * route as it was built would refuse the second after the first had already been folded into the
 * candidate — the derivation would be abandoned, but the refusal would name a collision half a change
 * away from the one the caller wrote. So every lane is checked against the fleet and against the
 * lanes beside it first, and the refusal names the lane that earned it.
 *
 * The duplicate check is not redundant with the "already has this lane" one below. Two lanes of one
 * mutation collide with EACH OTHER — nothing on the fleet has that variant yet — so the existing
 * routes cannot see it, and the second write would silently replace the first in the object literal.
 */
function assertLanesAddable(
  config: FleetConfig,
  name: string,
  lanes: readonly CreateLane[],
  existing: Readonly<Record<string, unknown>>,
): void {
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (config.variants[lane.variant] === undefined) {
      throw new FleetMutationRefusal(
        `this fleet does not declare a "${lane.variant}" lane; declare it before adding an account to it`,
      );
    }
    if (seen.has(lane.variant)) {
      throw new FleetMutationRefusal(
        `this change names the "${lane.variant}" lane twice; one lane is one account, so two of them cannot be the same`,
      );
    }
    seen.add(lane.variant);
    if (existing[lane.variant] !== undefined) {
      throw new FleetMutationRefusal(`account "${name}" already has a "${lane.variant}" lane on this fleet`);
    }
  }
}

/**
 * The profiles a create DECLARES, folded into the configuration before anything names them.
 *
 * A name this fleet already declares is REFUSED rather than merged into, and the refusal is the point
 * of the function. Merging would rewrite a document every account naming that profile composes — so a
 * change whose one-line summary says it adds an account would silently re-credential accounts nobody
 * mentioned. The remedy is in the sentence: pick the profile that is already there.
 *
 * `declaredProfileEnv` composes the env map, so `${secret:NAME}` has exactly one producer and a
 * caller cannot spell a near miss of the reference grammar.
 */
function withDeclaredProfiles(
  config: FleetConfig,
  mutation: Extract<FleetMutation, { kind: 'create-account' }>,
): FleetConfig {
  const declarations = mutation.declareProfiles ?? [];
  if (declarations.length === 0) return config;
  const profiles: Record<string, unknown> = { ...config.profiles };
  const declared = new Set<string>();
  for (const declaration of declarations) {
    const name = SafeNameSchema.parse(declaration.name);
    if (config.profiles[name] !== undefined) {
      throw new FleetMutationRefusal(
        `this fleet already declares a profile named "${name}"; name the existing one instead of declaring a second`,
      );
    }
    if (declared.has(name)) {
      throw new FleetMutationRefusal(`this change declares the profile "${name}" twice; one name is one profile`);
    }
    declared.add(name);
    profiles[name] = { env: declaredProfileEnv(declaration) };
  }
  return { ...config, profiles } as FleetConfig;
}

/**
 * The profiles list a created account's login composes, refused before it can become a schema error.
 *
 * The configuration schema already cross-checks an unknown profile name, but its message names a path
 * in a document the caller never wrote. This names the profile and says what to do, which is the
 * difference between a person fixing their own typo and a person reading `agents.0.profiles.1`.
 */
function assertProfilesDeclared(config: FleetConfig, profiles: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of profiles) {
    if (config.profiles[name] === undefined) {
      throw new FleetMutationRefusal(
        `this fleet declares no profile named "${name}"; declare it with this change, or name one it has`,
      );
    }
    if (seen.has(name)) {
      throw new FleetMutationRefusal(
        `this change names the profile "${name}" twice; a profile applies once, wherever it sits in the order`,
      );
    }
    seen.add(name);
  }
}

/**
 * One provider account, one route per named lane, derived in a single pass.
 *
 * ONE AGENT AND NOT N. The lanes are two homes for one provider login, which is what makes ticking
 * both modes worth doing at all: signing in once makes both usable. Two agents would be two logins
 * for one account.
 *
 * The profiles a create names are the AGENT's, because `AccountRoute` has no `profiles` field and
 * inventing one would be a new slot in a precedence chain that has exactly one owner. So both lanes of
 * one create compose the same profiles — the same property that makes one sign-in reach both — and a
 * create naming a login this fleet already has REPLACES that login's list, which changes what every
 * account on it composes. That is a real consequence of a real request rather than a mistake to be
 * guarded against: the surface says so before it is sent, and the plan the operator approves shows the
 * accounts it changes.
 */
function createAccount(
  config: FleetConfig,
  mutation: Extract<FleetMutation, { kind: 'create-account' }>,
  mintId: () => string,
): unknown {
  // The name becomes a path component and an executable name, so it is held to the same rule the
  // configuration schema applies rather than only to the wire schema's "non-empty".
  const name = SafeNameSchema.parse(mutation.name);
  assertServable(mutation);
  // Declared first, so a list naming a profile this same change adds is an ordinary list rather than
  // an unknown name — which is what makes "add one and use it" a single reviewed change.
  const declared = withDeclaredProfiles(config, mutation);
  if (mutation.profiles !== undefined) assertProfilesDeclared(declared, mutation.profiles);
  // An absent list leaves a login's profiles alone; an empty one is a declared "none", which is how a
  // login stops composing one. `undefined` and `[]` are therefore not interchangeable here.
  const bound = mutation.profiles === undefined ? {} : { profiles: [...mutation.profiles] };

  const agents = declared.agents as unknown as Record<string, unknown>[];
  const index = agents.findIndex(agent => agent.name === name && agent.kind === mutation.harness);
  const agent = index < 0 ? undefined : (agents[index] as { routes: Record<string, unknown> });
  const lanes = lanesOf(mutation);
  assertLanesAddable(declared, name, lanes, agent?.routes ?? {});

  const added = Object.fromEntries(
    lanes.map(lane => {
      const wrapper = derivedWrapperName(mutation.harness, name, lane.variant);
      return [lane.variant, { id: mintId(), wrapper, home: wrapper, ...createFields(mutation, lane) }];
    }),
  );

  if (agent === undefined) {
    return { ...declared, agents: [...agents, { name, kind: mutation.harness, ...bound, routes: added }] };
  }
  const next = { ...agent, ...bound, routes: { ...agent.routes, ...added } };
  return { ...declared, agents: agents.map((existing, at) => (at === index ? next : existing)) };
}

/**
 * Rewrite one account's route in place, found by id, and hand back the whole configuration.
 *
 * One walk shared by every mutation that changes an existing account, because "find the agent whose
 * routes hold this id, replace that one route, leave every other agent alone" is fiddly enough that a
 * second copy of it would eventually differ — and the way it would differ is by editing the wrong
 * account.
 */
function withRoute(
  config: FleetConfig,
  accountId: string,
  rewrite: (route: Record<string, unknown>, kind: string) => Record<string, unknown>,
): unknown {
  const agents = config.agents as unknown as Record<string, unknown>[];
  for (const [index, agent] of agents.entries()) {
    const routes = agent.routes as Record<string, Record<string, unknown>>;
    const entry = Object.entries(routes).find(([, route]) => route.id === accountId);
    if (entry === undefined) continue;
    const [variant, route] = entry;
    const next = rewrite({ ...route }, agent.kind as string);
    // Identity is never edited: the id, its wrapper and its home are what every consumer joins on,
    // and changing them here would silently repoint an account rather than change it.
    next.id = route.id;
    next.wrapper = route.wrapper;
    next.home = route.home;
    const updated = { ...agent, routes: { ...routes, [variant]: next } };
    return { ...config, agents: agents.map((existing, at) => (at === index ? updated : existing)) };
  }
  throw new FleetMutationRefusal(`this fleet declares no account with id "${accountId}"`);
}

/**
 * Set one asset field in an account's own overlay, and clear the harness overlay that would beat it.
 *
 * The second half is not tidiness. Within one slot a `claude:` / `codex:` overlay is applied *after*
 * the flat fields, so an account whose layer carries `claude: { memory: … }` would keep using that
 * document however the flat field was set — the operation would report success and change nothing.
 * Only this account's own harness is touched: the other overlay belongs to no account of this kind.
 *
 * That is the whole reason a write here takes effect. `route.layer` is the LAST slot of the
 * composition chain — `compositionSlots` owns that order — so once the overlay inside it is out of the
 * way, nothing else can override the value. Both operations' tests assert the resolved state after the
 * derivation rather than trusting that, because the ordering is the load-bearing part.
 */
function layerWithAsset(
  route: Record<string, unknown>,
  kind: string,
  field: string,
  value: string | readonly string[],
): Record<string, unknown> {
  const layer = mergedLayer((route.layer ?? {}) as Record<string, unknown>, { [field]: value });
  const overlay = layer[kind] as Record<string, unknown> | undefined;
  if (overlay !== undefined && field in overlay) {
    const { [field]: _replaced, ...rest } = overlay;
    // An overlay emptied by this is dropped rather than left as `claude: {}`, which the schema accepts
    // but which reads as a per-harness override that is not there.
    if (Object.keys(rest).length === 0) {
      const { [kind]: _empty, ...withoutOverlay } = layer;
      return { ...route, layer: withoutOverlay };
    }
    return { ...route, layer: { ...layer, [kind]: rest } };
  }
  return { ...route, layer };
}

function editAccount(config: FleetConfig, mutation: Extract<FleetMutation, { kind: 'edit-account' }>): unknown {
  // Start from what the account already is, so an edit that names one field changes one field.
  return withRoute(config, mutation.accountId, next => {
    patched(next, {
      displayName: mutation.displayName,
      mode: mutation.mode,
      // Merged rather than replaced, for the same reason the layer below is: an editor showing some
      // of what an account declares must not delete the rest. `mergedModels` owns which of the
      // unnamed entries survive and why.
      models:
        mutation.models === undefined
          ? undefined
          : mergedModels((next.models ?? []) as readonly FleetManifestModel[], mutation.models),
      defaultModel: mutation.defaultModel,
      available: mutation.available,
      unavailableReason: mutation.unavailableReason,
      // The layer merges rather than replaces: an editor showing four of its fields must not erase
      // the four it does not show. `null` still removes the whole overlay, and absent keeps it.
      layer:
        mutation.layer === undefined || mutation.layer === null
          ? mutation.layer
          : mergedLayer((next.layer ?? {}) as Record<string, unknown>, mutation.layer),
    });
    return next;
  });
}

/**
 * Point one account's field at a declared shared document.
 *
 * The reference is written into the account's own overlay rather than by removing whatever earlier
 * slot supplied a different one: an account may be linked to a document no slot above it names, and
 * removing an override cannot express that. The cost is that the account then names the shared
 * document explicitly — which is honest, and is why the report classifies sharing by the *document*
 * rather than by which slot it came from.
 */
function linkSharedAsset(
  config: FleetConfig,
  mutation: Extract<FleetMutation, { kind: 'link-shared-asset' }>,
): unknown {
  const path = sharedAssetLinkPath(config, mutation.accountId, mutation.field, mutation.name);
  // `skills` holds a selection, so a link there means "select exactly this one item" and is written as
  // the one-entry list it is. Spelling the list out rather than leaving a bare string for the schema to
  // normalize is what keeps the stored configuration saying what happened: this verb names ONE
  // document, so it can only ever produce a selection of one, and a surface adding a second item edits
  // the list rather than sending a second link.
  const value = mutation.field === 'skills' ? [path] : path;
  return withRoute(config, mutation.accountId, (route, kind) => layerWithAsset(route, kind, mutation.field, value));
}

/**
 * Give one account its own copy of the document it currently shares.
 *
 * Only the configuration half is here. The copy itself is a text document the mount composes from the
 * shared source and writes inside the provisioner's rollback boundary, so the account never points at
 * a path that does not exist — and the shared document is not touched at all, which is what makes this
 * safe for everybody else still using it.
 */
function unlinkSharedAsset(
  config: FleetConfig,
  mutation: Extract<FleetMutation, { kind: 'unlink-shared-asset' }>,
): unknown {
  const unlink = planSharedAssetUnlink(config, mutation.accountId, mutation.field);
  return withRoute(config, mutation.accountId, (route, kind) =>
    layerWithAsset(route, kind, mutation.field, unlink.destination),
  );
}

/**
 * Refuse a change that stops offering a store item accounts are still using.
 *
 * The schema cannot catch this and neither can the plan builder: a path an account names is legal
 * whether or not the registry declares it, so a deleted item leaves a configuration that parses, plans,
 * and then fails the apply on a path nobody typed — or, worse, plans cleanly while the surface goes on
 * showing those accounts as configured. It is checked here because this is the one place that holds BOTH
 * the configuration as it is and the one a change would produce, which is what makes a deletion visible
 * at all.
 *
 * The refusal names the accounts rather than counting them: the remedy is to move each of them off the
 * item first, and a count sends somebody looking for who they are.
 *
 * Exported as well as called below, and deliberately so. No verb removes a store item today, so the
 * call in {@link applyFleetMutation} is a guard that cannot yet fire — it is there so that the verb
 * which does, whenever it arrives, cannot arrive without it. The export is for a surface that wants to
 * refuse before it builds a proposal at all, and it is the named thing to call rather than a rule to
 * re-derive.
 */
export function assertNoOrphanedSharedDocuments(before: FleetConfig, after: FleetConfig): void {
  const orphaned = orphanedSharedDocuments(before, after);
  if (orphaned.length === 0) return;
  const described = orphaned
    .map(
      document =>
        `shared ${document.field} "${document.name}" (${document.path}), used by ${document.accounts.join(', ')}`,
    )
    .join('; ');
  throw new FleetMutationRefusal(
    `this change would stop offering ${described}; point those accounts at another document, or give each its own copy, before removing it`,
  );
}

/**
 * Derive the configuration a mutation asks for, validated by the shared schema.
 *
 * Every cross-reference the schema checks — duplicate ids, duplicate wrappers, duplicate homes,
 * unknown variants, a default model an account cannot serve — is therefore checked here, before the
 * candidate is ever planned, let alone written.
 */
export function applyFleetMutation(config: FleetConfig, mutation: FleetMutation, mintId: () => string): FleetConfig {
  if (mutation.kind === 'initialize') {
    throw new FleetMutationRefusal('initialization does not derive a configuration; it scaffolds one');
  }
  const candidate = derived(config, mutation, mintId);
  const parsed = FleetConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new FleetMutationRefusal(`the resulting fleet configuration would be invalid:\n${issues}`);
  }
  // After the parse, because it compares two parsed configurations — and every verb reaches it, so a
  // store-item deletion cannot arrive through a new verb that forgot to ask.
  assertNoOrphanedSharedDocuments(config, parsed.data);
  return parsed.data;
}

function derived(
  config: FleetConfig,
  mutation: Exclude<FleetMutation, { kind: 'initialize' }>,
  mintId: () => string,
): unknown {
  if (mutation.kind === 'create-account') return createAccount(config, mutation, mintId);
  if (mutation.kind === 'link-shared-asset') return linkSharedAsset(config, mutation);
  if (mutation.kind === 'unlink-shared-asset') return unlinkSharedAsset(config, mutation);
  return editAccount(config, mutation);
}

// ── The account model's changes ──────────────────────────────────────────────────────────────────
//
// The same rule as above, for version 2: a caller names ONE intent and this derives the next model
// from the current one. A component's file path is never accepted from a caller — it is
// `components/<kind>/<name>.<ext>` in the asset tree — and the candidate is validated by the shared
// schema last, so every cross-reference the model has is checked once, in its own words.

/** The changes that derive a new configuration. Sign-out, setup and clone run their own executors. */
export type AccountPlanChange = Exclude<
  FleetAccountChange,
  { kind: 'credential.signout' } | { kind: 'setup.import' } | { kind: 'clone.import' }
>;

/** The kinds that are not a configuration edit. */
const EXECUTED_KINDS: ReadonlySet<FleetAccountChange['kind']> = new Set([
  'credential.signout',
  'setup.import',
  'clone.import',
]);

/** Whether this change derives a new configuration (and so goes through the plan and its apply). */
export const isAccountPlanChange = (change: FleetAccountChange): change is AccountPlanChange =>
  !EXECUTED_KINDS.has(change.kind);

/** One component document a change writes, relative to the asset tree. */
export interface AccountComponentFile {
  readonly file: string;
  readonly content: string;
}

/** The model a change produces, the files it writes, and what the person approving it is told. */
export interface AccountModelEdit {
  readonly model: AccountModel;
  readonly files: readonly AccountComponentFile[];
  readonly summary: string;
  /** The sentences a confirm card shows (E15, E20, E21, E32). */
  readonly consequences: readonly string[];
}

/** What a derivation needs to know about the machine that is not in its configuration. */
export interface AccountChangeFacts {
  readonly machineName: string;
  readonly runningSessions: number;
}

/** The document format each harness's settings file is in. */
const SETTINGS_FORMAT: Readonly<Record<HarnessKind, SettingsFormat>> = { claude: 'json', codex: 'toml' };

/** The extension each kind's file is written with. */
const componentExtension = (input: FleetComponentInput): string | undefined => {
  if (input.kind === 'instructions') return 'md';
  if (input.kind === 'settings') return SETTINGS_FORMAT[input.harness];
  if (input.kind === 'hooks') return 'json';
  return undefined;
};

/** The product's word for each kind, singular. */
const KIND_WORDS: Readonly<Record<ComponentKind, string>> = {
  instructions: 'instructions',
  mcp: 'MCP server',
  skills: 'skills',
  settings: 'settings',
  hooks: 'hooks',
  modelSets: 'model set',
};

const refuse = (message: string): never => {
  throw new FleetMutationRefusal(message);
};

/**
 * E16: a name that is taken or does not fit R1, refused with the name to use instead. A name that is
 * not in the grammar is offered its nearest slug; a name that is taken is offered `-2`, `-3`, ….
 */
function assertFreeRuntimeName(
  name: string,
  taken: (candidate: string) => boolean,
  what: 'runtime' | 'login',
  machineName: string,
): void {
  if (!isRuntimeName(name)) {
    const suggestion = freeName(slugName(name, what === 'runtime' ? 'runtime' : 'login'), taken);
    refuse(`Use only letters, digits and dashes. Use ${suggestion}?`);
  }
  if (taken(name)) {
    refuse(`${name} is already a ${what} on ${machineName}. Use ${freeName(name, taken)}?`);
  }
}

/** The environment an edit asks for, with every "keep" resolved against what the component has. */
function resolvedEnv(
  input: FleetEnvInput | undefined,
  existing: Readonly<Record<string, string>> | undefined,
  owner: string,
): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string') {
      const kept = existing?.[name];
      if (kept === undefined) refuse(`${owner} has no value for ${name} to keep; type one`);
      env[name] = kept as string;
      continue;
    }
    // K4, E7: a secret value never sits in a component, only a reference to the secret store.
    if (looksSecret(name, value)) {
      refuse(
        `${name} looks like a secret, and a secret never sits in a component. Save it in this machine's secret store and write \${secret:NAME} here instead.`,
      );
    }
    env[name] = value;
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

/** A parsed settings or hooks document, or a refusal naming what is wrong with it. */
function assertDocument(text: string, format: SettingsFormat, what: string): void {
  try {
    parseSettings(text, format);
  } catch (error) {
    refuse(
      `the ${what} text is not valid ${format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The component as the configuration stores it, and the file it writes. */
function componentOf(
  name: string,
  input: FleetComponentInput,
  content: string | undefined,
  existing: Record<string, unknown> | undefined,
): { readonly component: Record<string, unknown>; readonly file?: AccountComponentFile } {
  const extension = componentExtension(input);
  const ownFile = extension === undefined ? undefined : componentFilePath(input.kind, name, extension);
  const written = content === undefined || ownFile === undefined ? undefined : { file: ownFile, content };
  const keptFile = typeof existing?.file === 'string' ? existing.file : undefined;
  const file = written?.file ?? keptFile;
  const owner = `${KIND_WORDS[input.kind]} ${name}`;
  const existingEnv = existing?.env as Readonly<Record<string, string>> | undefined;
  const harness = 'harness' in input && input.harness !== undefined ? { harness: input.harness } : {};
  switch (input.kind) {
    case 'instructions':
      if (file === undefined) refuse(`${owner} needs its text`);
      return { component: { file, ...harness }, ...(written === undefined ? {} : { file: written }) };
    case 'mcp': {
      const env = resolvedEnv(input.env, existingEnv, owner);
      return {
        component: {
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.args === undefined ? {} : { args: [...input.args] }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(env === undefined ? {} : { env }),
          ...harness,
        },
      };
    }
    case 'skills':
      return { component: { items: [...input.items], ...harness } };
    case 'settings': {
      if (content !== undefined) assertDocument(content, SETTINGS_FORMAT[input.harness], owner);
      const env = resolvedEnv(input.env, existingEnv, owner);
      return {
        component: {
          harness: input.harness,
          ...(file === undefined ? {} : { file }),
          ...(input.flags === undefined || input.flags.length === 0 ? {} : { flags: [...input.flags] }),
          ...(env === undefined ? {} : { env }),
        },
        ...(written === undefined ? {} : { file: written }),
      };
    }
    case 'hooks': {
      if (content !== undefined) assertDocument(content, 'json', owner);
      const directory =
        typeof existing?.directory === 'string' && written === undefined ? existing.directory : undefined;
      if (directory !== undefined) {
        return { component: { harness: input.harness, directory } };
      }
      if (file === undefined) refuse(`${owner} needs its hooks document`);
      return { component: { harness: input.harness, file }, ...(written === undefined ? {} : { file: written }) };
    }
    default:
      return { component: { models: [...input.models], default: input.default } };
  }
}

/** The plain words for a layer in a refusal: "profile base", "instructions main". */
const layerWords = (text: string): string => {
  const reference = parseLayerReference(text);
  if (reference === undefined) return text;
  return reference.kind === 'profile'
    ? `profile ${reference.name}`
    : `${KIND_WORDS[reference.componentKind]} ${reference.name}`;
};

/** The layers a profile edit asks for, checked against what exists and against P3 (E19). */
function assertLayers(model: AccountModel, name: string, layers: readonly string[]): void {
  const seen = new Set<string>();
  for (const text of layers) {
    const reference = parseLayerReference(text);
    if (reference === undefined) {
      refuse(`"${text}" is not a layer — write <kind>/<name> or profile/<name>`);
      return;
    }
    if (seen.has(text)) refuse(`${layerWords(text)} is in the layers twice`);
    seen.add(text);
    if (reference.kind === 'profile') {
      if (model.profiles[reference.name] === undefined) refuse(`no profile ${reference.name} exists on this machine`);
      if (wouldIncludeItself(model.profiles, name, reference.name)) {
        refuse(`profile ${reference.name} would include itself: it is ${name} or is built on it`);
      }
      continue;
    }
    if (model.components[reference.componentKind][reference.name] === undefined) {
      refuse(`no ${KIND_WORDS[reference.componentKind]} ${reference.name} exists on this machine`);
    }
  }
}

/** A label two logins of one harness may not share (C9, E26). */
function assertLabelFree(model: AccountModel, id: string, harness: HarnessKind, label: string | undefined): void {
  if (label === undefined) return;
  const clash = Object.entries(model.credentials).find(
    ([other, credential]) => other !== id && credential.harness === harness && credential.label === label,
  );
  if (clash !== undefined) {
    refuse(`another ${HARNESS_DISPLAY_NAMES[harness]} login is already labelled ${label}; pick a different label`);
  }
}

type Draft = {
  machine: Record<string, unknown>;
  credentials: Record<string, Record<string, unknown>>;
  components: Record<ComponentKind, Record<string, Record<string, unknown>>>;
  profiles: Record<string, { layers: string[] }>;
  runtimes: Record<string, Record<string, unknown>>;
} & Record<string, unknown>;

/**
 * Derive the model one change asks for, validated by the shared schema, with the files it writes and
 * the sentences the person approving it reads. Throws {@link FleetMutationRefusal} for anything the
 * change cannot do, in words naming what to do instead.
 */
export function deriveAccountChange(
  model: AccountModel,
  change: AccountPlanChange,
  facts: AccountChangeFacts,
): AccountModelEdit {
  const draft = structuredClone(model) as unknown as Draft;
  const files: AccountComponentFile[] = [];
  const consequences: string[] = [];
  const summary = applyAccountChange(model, draft, change, facts, files, consequences);
  const parsed = AccountModelSchema.safeParse(draft);
  if (!parsed.success) {
    refuse(`this change would leave the setup invalid: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  }
  return { model: (parsed as { data: AccountModel }).data, files, summary, consequences };
}

function applyAccountChange(
  model: AccountModel,
  draft: Draft,
  change: AccountPlanChange,
  facts: AccountChangeFacts,
  files: AccountComponentFile[],
  consequences: string[],
): string {
  switch (change.kind) {
    case 'runtime.put':
      return putRuntime(model, draft, change, facts, consequences);
    case 'runtime.remove': {
      if (model.runtimes[change.name] === undefined) refuse(`no runtime ${change.name} exists on this machine`);
      delete draft.runtimes[change.name];
      consequences.push('Running sessions of it keep going until they end. Its past sessions stay in history.');
      return `Remove runtime ${change.name}`;
    }
    case 'profile.put':
      return putProfile(model, draft, change, facts, consequences);
    case 'profile.remove':
      return removeProfile(model, draft, change, consequences);
    case 'component.put':
      return putComponent(model, draft, change, facts, files, consequences);
    case 'component.remove':
      return removeComponent(model, draft, change, consequences);
    case 'credential.add': {
      assertFreeRuntimeName(change.id, id => model.credentials[id] !== undefined, 'login', facts.machineName);
      assertLabelFree(model, change.id, change.harness, change.label);
      draft.credentials[change.id] = {
        harness: change.harness,
        store: 'ferretry',
        ...(change.label === undefined ? {} : { label: change.label }),
      };
      consequences.push('It starts as an empty login that needs sign-in.');
      return `Add a ${HARNESS_DISPLAY_NAMES[change.harness]} login ${change.id}`;
    }
    case 'credential.label': {
      const credential = model.credentials[change.id];
      if (credential === undefined) return refuse(`no login ${change.id} exists on this machine`);
      const target = draft.credentials[change.id] as Record<string, unknown>;
      if (change.label === null) {
        delete target.label;
        return `Remove the label from login ${change.id}`;
      }
      assertLabelFree(model, change.id, credential.harness, change.label);
      target.label = change.label;
      return `Label login ${change.id} ${change.label}`;
    }
    case 'credential.remove': {
      const credential = model.credentials[change.id];
      if (credential === undefined) return refuse(`no login ${change.id} exists on this machine`);
      // C10: a runtime on it would have nothing to launch with.
      const users = runtimesUsingCredential(model, change.id);
      if (users.length > 0) {
        refuse(
          `${counted(users.length, 'runtime')} still ${users.length === 1 ? 'uses' : 'use'} this login (${listed(users)}). Move ${users.length === 1 ? 'it' : 'them'} to another login first.`,
        );
      }
      delete draft.credentials[change.id];
      if (credential.store === 'host') {
        consequences.push(
          `Your own ${credential.harness} in your terminal keeps its login; Ferretry only stops using it.`,
        );
      } else if (credential.store === 'ferretry') {
        consequences.push('Its saved login stays on this machine until you sign it out.');
      }
      return `Remove login ${change.id}`;
    }
    default: {
      const previous = model.machine.agentPermissions;
      draft.machine.agentPermissions = change.agentPermissions;
      // E32: the setting is read at launch, so a running session keeps the mode it started with.
      const running = facts.runningSessions;
      consequences.push(
        running === 0
          ? 'Applies to new sessions.'
          : `Applies to new sessions. ${counted(running, 'running session')} ${running === 1 ? 'keeps' : 'keep'} the old mode (${AGENT_PERMISSION_WORDS[previous]}) until restarted.`,
      );
      return `Set agent permissions to ${AGENT_PERMISSION_WORDS[change.agentPermissions]}`;
    }
  }
}

/** The product's words for each Agent permissions choice (F4). */
const AGENT_PERMISSION_WORDS: Readonly<Record<'auto' | 'skip', string>> = {
  auto: 'Auto mode',
  skip: 'Skip all permission checks',
};

function putRuntime(
  model: AccountModel,
  draft: Draft,
  change: Extract<AccountPlanChange, { kind: 'runtime.put' }>,
  facts: AccountChangeFacts,
  consequences: string[],
): string {
  const exists = model.runtimes[change.name] !== undefined;
  if (change.create) {
    const commands = new Set(model.advanced.commands.map(command => command.wrapper));
    assertFreeRuntimeName(
      change.name,
      name => model.runtimes[name] !== undefined || commands.has(name),
      'runtime',
      facts.machineName,
    );
  } else if (!exists) {
    refuse(`no runtime ${change.name} exists on this machine`);
  }
  const credential = model.credentials[change.credential];
  if (credential === undefined) return refuse(`no login ${change.credential} exists on this machine`);
  if (model.profiles[change.profile] === undefined)
    return refuse(`no profile ${change.profile} exists on this machine`);
  // P5, E14: a profile with nothing for this login's harness launches nothing of the person's setup.
  const resolved = resolveProfile({ model, profile: change.profile, harness: credential.harness });
  if (resolved.ok && !resolved.resolved.availability.available) {
    refuse(
      `Nothing in profile ${change.profile} applies on ${HARNESS_DISPLAY_NAMES[credential.harness]}. Pick a different profile.`,
    );
  }
  // R4, E15: allowed, but only once the person has seen that it duplicates one.
  const twins = Object.entries(model.runtimes)
    .filter(
      ([name, runtime]) =>
        name !== change.name && runtime.credential === change.credential && runtime.profile === change.profile,
    )
    .map(([name]) => name)
    .toSorted();
  if (twins.length > 0 && change.addAnother !== true) {
    refuse(
      `${listed(twins)} already ${twins.length === 1 ? 'uses' : 'use'} this login and profile. Add another anyway?`,
    );
  }
  if (twins.length > 0)
    consequences.push(`${listed(twins)} already ${twins.length === 1 ? 'uses' : 'use'} this login and profile.`);
  draft.runtimes[change.name] = { credential: change.credential, profile: change.profile, agent: change.agent };
  if (exists) consequences.push('Running sessions keep the old setup until restarted.');
  return exists ? `Change runtime ${change.name}` : `Add runtime ${change.name}`;
}

function putProfile(
  model: AccountModel,
  draft: Draft,
  change: Extract<AccountPlanChange, { kind: 'profile.put' }>,
  facts: AccountChangeFacts,
  consequences: string[],
): string {
  const exists = model.profiles[change.name] !== undefined;
  if (change.create && exists) {
    refuse(
      `${change.name} is already a profile on ${facts.machineName}. Use ${freeName(change.name, name => model.profiles[name] !== undefined)}?`,
    );
  }
  if (!change.create && !exists) refuse(`no profile ${change.name} exists on this machine`);
  assertLayers(model, change.name, change.layers);
  draft.profiles[change.name] = { layers: [...change.layers] };
  if (exists) {
    const consequence = editConsequence(profileUsage(model, change.name));
    if (consequence !== undefined) consequences.push(consequence);
  }
  return exists ? `Change the layers of profile ${change.name}` : `Add profile ${change.name}`;
}

function removeProfile(
  model: AccountModel,
  draft: Draft,
  change: Extract<AccountPlanChange, { kind: 'profile.remove' }>,
  consequences: string[],
): string {
  if (model.profiles[change.name] === undefined) refuse(`no profile ${change.name} exists on this machine`);
  // P6, E21: a base is removed from the profiles built on it first; they would lose what it gave them.
  const usage = profileUsage(model, change.name);
  if (usage.direct.length > 0) {
    refuse(
      `Profile ${change.name} is a base for ${listed(usage.direct)}. Remove it from ${usage.direct.length === 1 ? 'that profile' : 'those profiles'} first.`,
    );
  }
  const runtimes = runtimesUsingProfile(model, change.name);
  if (runtimes.length > 0) {
    const target = change.switchRuntimesTo;
    if (target === undefined) {
      refuse(
        `${counted(runtimes.length, 'runtime')} ${runtimes.length === 1 ? 'uses' : 'use'} profile ${change.name} (${listed(runtimes)}). Pick the profile ${runtimes.length === 1 ? 'it switches' : 'they switch'} to.`,
      );
    }
    if (target === change.name) refuse(`pick a profile other than ${change.name} to switch to`);
    if (model.profiles[target as string] === undefined) refuse(`no profile ${target} exists on this machine`);
    for (const runtime of runtimes) (draft.runtimes[runtime] as Record<string, unknown>).profile = target;
    consequences.push(`Switches ${counted(runtimes.length, 'runtime')} to ${target}.`);
  }
  delete draft.profiles[change.name];
  consequences.push('Its components stay saved.');
  return runtimes.length > 0
    ? `Switch ${counted(runtimes.length, 'runtime')} and delete profile ${change.name}`
    : `Delete profile ${change.name}`;
}

function putComponent(
  model: AccountModel,
  draft: Draft,
  change: Extract<AccountPlanChange, { kind: 'component.put' }>,
  facts: AccountChangeFacts,
  files: AccountComponentFile[],
  consequences: string[],
): string {
  const kind = change.component.kind;
  const existing = model.components[kind][change.name] as Record<string, unknown> | undefined;
  const word = KIND_WORDS[kind];
  if (change.create && existing !== undefined) {
    refuse(
      `${change.name} is already a ${word} on ${facts.machineName}. Use ${freeName(change.name, name => model.components[kind][name] !== undefined)}?`,
    );
  }
  if (!change.create && existing === undefined) refuse(`no ${word} ${change.name} exists on this machine`);
  if (change.content !== undefined && componentExtension(change.component) === undefined) {
    refuse(`a ${word} has no text to save; send its fields instead`);
  }
  const built = componentOf(change.name, change.component, change.content, existing);
  draft.components[kind][change.name] = built.component;
  if (built.file !== undefined) files.push(built.file);
  if (existing !== undefined) {
    // E20: where the edit lands, before the person presses Save for all.
    const consequence = editConsequence(componentUsage(model, `${kind}/${change.name}`));
    if (consequence !== undefined) consequences.push(consequence);
  }
  return existing === undefined ? `Add ${word} ${change.name}` : `Change ${word} ${change.name}`;
}

function removeComponent(
  model: AccountModel,
  draft: Draft,
  change: Extract<AccountPlanChange, { kind: 'component.remove' }>,
  consequences: string[],
): string {
  const kind = change.componentKind;
  const word = KIND_WORDS[kind];
  if (model.components[kind][change.name] === undefined) refuse(`no ${word} ${change.name} exists on this machine`);
  const reference = `${kind}/${change.name}` as const;
  const usage = componentUsage(model, reference);
  if (usage.direct.length > 0) {
    // K7, E21: blocked while a profile has it as a layer, naming those profiles and the runtimes behind them.
    if (change.removeFromProfiles !== true) {
      const behind = usage.runtimes.length === 0 ? '' : ` (used by ${listed(usage.runtimes)})`;
      refuse(
        `${word.charAt(0).toUpperCase()}${word.slice(1)} ${change.name} is a layer in ${listed(usage.direct)}${behind}. Remove it from those first.`,
      );
    }
    for (const profile of usage.direct) {
      const layers = (draft.profiles[profile] as { layers: string[] }).layers.filter(layer => layer !== reference);
      if (layers.length === 0) {
        refuse(
          `removing ${word} ${change.name} would leave profile ${profile} with no layers; add another layer to it first`,
        );
      }
      (draft.profiles[profile] as { layers: string[] }).layers = layers;
    }
    consequences.push(
      `Removes it from ${listed(usage.direct)}${usage.runtimes.length === 0 ? '' : `, which changes ${counted(usage.runtimes.length, 'runtime')}`}. Running sessions keep the old version until restarted.`,
    );
  }
  delete draft.components[kind][change.name];
  return `Delete ${word} ${change.name}`;
}
