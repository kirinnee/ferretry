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

function editAccount(config: FleetConfig, mutation: Extract<FleetMutation, { kind: 'edit-account' }>): unknown {
  const agents = config.agents as unknown as Record<string, unknown>[];
  for (const [index, agent] of agents.entries()) {
    const routes = agent.routes as Record<string, { id: string; wrapper: string; home: string }>;
    const entry = Object.entries(routes).find(([, route]) => route.id === mutation.accountId);
    if (entry === undefined) continue;
    const [variant, route] = entry;
    // Start from what the account already is, so an edit that names one field changes one field.
    const next: Record<string, unknown> = { ...(route as Record<string, unknown>) };
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
    // Identity is never edited: the id, its wrapper and its home are what every consumer joins on,
    // and changing them here would silently repoint an account rather than change it.
    next.id = route.id;
    next.wrapper = route.wrapper;
    next.home = route.home;
    const updated = { ...agent, routes: { ...routes, [variant]: next } };
    return { ...config, agents: agents.map((existing, at) => (at === index ? updated : existing)) };
  }
  throw new FleetMutationRefusal(`this fleet declares no account with id "${mutation.accountId}"`);
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
  const candidate =
    mutation.kind === 'create-account' ? createAccount(config, mutation, mintId) : editAccount(config, mutation);
  const parsed = FleetConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new FleetMutationRefusal(`the resulting fleet configuration would be invalid:\n${issues}`);
  }
  return parsed.data;
}
