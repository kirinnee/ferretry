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
  declaredProfileEnv,
  derivedWrapperName,
  type FleetConfig,
  FleetConfigSchema,
  type FleetManifestModel,
  orphanedSharedDocuments,
  SafeNameSchema,
} from '@ferretry/fleet';
import { type FleetModelDeclaration, type FleetMutation, FleetMutationSchema } from '@ferretry/protocol';
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
