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
import { type FleetConfig, FleetConfigSchema, SafeNameSchema } from '@ferretry/fleet';
import { type FleetMutation, FleetMutationSchema } from '@ferretry/protocol';
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

/**
 * The wrapper name an account gets. The default lane keeps the bare `<harness>-<name>` a person
 * would type; any other lane is spelled out, so two lanes of one account never collide.
 */
export function derivedWrapperName(harness: string, name: string, variant: string): string {
  return variant === 'default' ? `${harness}-${name}` : `${harness}-${variant}-${name}`;
}

/** The lane a create names, or the default one. Defaulted here rather than in the wire schema. */
const variantOf = (mutation: Extract<FleetMutation, { kind: 'create-account' }>): string =>
  mutation.variant ?? DEFAULT_VARIANT;

/** Availability defaults to true: an account nobody said was down is up. */
const availabilityOf = (mutation: Extract<FleetMutation, { kind: 'create-account' }>): boolean =>
  mutation.available ?? true;

const createFields = (mutation: Extract<FleetMutation, { kind: 'create-account' }>): Record<string, unknown> => ({
  models: [...mutation.models],
  available: availabilityOf(mutation),
  ...(mutation.displayName === undefined ? {} : { displayName: mutation.displayName }),
  ...(mutation.mode === undefined ? {} : { mode: mutation.mode }),
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
  if (mutation.models.length === 0) {
    throw new FleetMutationRefusal('an available account must list at least one model it can serve');
  }
  if (mutation.defaultModel === undefined) {
    throw new FleetMutationRefusal('an available account must name the default model it serves');
  }
  if (!mutation.models.includes(mutation.defaultModel)) {
    throw new FleetMutationRefusal(
      `the default model "${mutation.defaultModel}" is not one of the models this account lists`,
    );
  }
}

function createAccount(
  config: FleetConfig,
  mutation: Extract<FleetMutation, { kind: 'create-account' }>,
  mintId: () => string,
): unknown {
  const variant = variantOf(mutation);
  if (config.variants[variant] === undefined) {
    throw new FleetMutationRefusal(
      `this fleet does not declare a "${variant}" lane; declare it before adding an account to it`,
    );
  }
  // The name becomes a path component and an executable name, so it is held to the same rule the
  // configuration schema applies rather than only to the wire schema's "non-empty".
  const name = SafeNameSchema.parse(mutation.name);
  assertServable(mutation);

  const wrapper = derivedWrapperName(mutation.harness, name, variant);
  const route = { id: mintId(), wrapper, home: wrapper, ...createFields(mutation) };

  const agents = config.agents as unknown as Record<string, unknown>[];
  const index = agents.findIndex(agent => agent.name === name && agent.kind === mutation.harness);
  if (index < 0) {
    return {
      ...config,
      agents: [...agents, { name, kind: mutation.harness, routes: { [variant]: route } }],
    };
  }

  const agent = agents[index] as { routes: Record<string, unknown> };
  if (agent.routes[variant] !== undefined) {
    throw new FleetMutationRefusal(`account "${name}" already has a "${variant}" lane on this fleet`);
  }
  const next = { ...agent, routes: { ...agent.routes, [variant]: route } };
  return { ...config, agents: agents.map((existing, at) => (at === index ? next : existing)) };
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
  path: string,
): Record<string, unknown> {
  const layer = mergedLayer((route.layer ?? {}) as Record<string, unknown>, { [field]: path });
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
      models: mutation.models === undefined ? undefined : [...mutation.models],
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
  return withRoute(config, mutation.accountId, (route, kind) => layerWithAsset(route, kind, mutation.field, path));
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
