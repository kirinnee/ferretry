/**
 * Who uses what in a machine's account model: the one reading of "used by" that the catalogue shows
 * and every change refuses or warns with (K1, K7, P6, E20, E21), so a list and the refusal of a delete
 * can never count differently.
 *
 * Below the usage helpers are the catalogue's projections — what the machine, component, profile and
 * runtime reads answer — so the layering module decides what a stack IS and this only says it in the
 * product's words (§4.2).
 *
 * Pure.
 */
import {
  type AccountModel,
  applyFixedLayer,
  type ComponentKind,
  type Conflict,
  componentPartialSupport,
  describeConflict,
  describePartialSupport,
  type FixedEntry,
  type FlatLayer,
  fixedLayerFor,
  flattenProfile,
  HARNESS_DISPLAY_NAMES,
  type HarnessKind,
  type LayerReferenceText,
  looksSecret,
  type PartialSupport,
  type ResolvedProfile,
  resolveProfile,
  type SettingsObject,
  type SkippedLayer,
  wouldIncludeItself,
} from '@ferretry/fleet';
import type {
  FleetCatalogAct,
  FleetCatalogFormat,
  FleetComponentCatalog,
  FleetComponentDetail,
  FleetCredentialStatusWord,
  FleetEnvEntry,
  FleetFixedLayerView,
  FleetLayerConflict,
  FleetLayeredProfileCatalog,
  FleetMachineView,
  FleetRuntimeCatalog,
  FleetRuntimeModelSet,
  FleetStackView,
} from '@ferretry/protocol';

const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Who uses one component or profile. */
export interface CatalogUsage {
  /** Profiles that have it as one of their own layers. */
  readonly direct: readonly string[];
  /** Profiles whose stack reaches it, directly or through a base. */
  readonly profiles: readonly string[];
  /** Runtimes whose profile reaches it. */
  readonly runtimes: readonly string[];
}

const runtimesOn = (model: AccountModel, profiles: ReadonlySet<string>): readonly string[] =>
  Object.entries(model.runtimes)
    .filter(([, runtime]) => profiles.has(runtime.profile))
    .map(([name]) => name)
    .toSorted(byName);

/** Who uses the component `reference` (`<kind>/<name>`). */
export function componentUsage(model: AccountModel, reference: LayerReferenceText): CatalogUsage {
  const direct = Object.entries(model.profiles)
    .filter(([, profile]) => profile.layers.includes(reference))
    .map(([name]) => name)
    .toSorted(byName);
  const profiles = Object.keys(model.profiles)
    .filter(name => {
      const flat = flattenProfile(model, name);
      return flat.ok && flat.layers.some(layer => layer.reference === reference);
    })
    .toSorted(byName);
  return { direct, profiles, runtimes: runtimesOn(model, new Set(profiles)) };
}

/**
 * Who uses the profile `name`: the profiles that name it as a base, the profiles whose stack reaches
 * it, and the runtimes on any of those or on it.
 */
export function profileUsage(model: AccountModel, name: string): CatalogUsage {
  const base = `profile/${name}`;
  const direct = Object.entries(model.profiles)
    .filter(([, profile]) => profile.layers.includes(base as LayerReferenceText))
    .map(([other]) => other)
    .toSorted(byName);
  const profiles = Object.keys(model.profiles)
    .filter(other => other !== name && wouldIncludeItself(model.profiles, name, other))
    .toSorted(byName);
  return { direct, profiles, runtimes: runtimesOn(model, new Set([name, ...profiles])) };
}

/** The runtimes that name `profile` themselves, which a delete must move (P6). */
export const runtimesUsingProfile = (model: AccountModel, profile: string): readonly string[] =>
  runtimesOn(model, new Set([profile]));

/** The runtimes on one credential (C10). */
export const runtimesUsingCredential = (model: AccountModel, credential: string): readonly string[] =>
  Object.entries(model.runtimes)
    .filter(([, runtime]) => runtime.credential === credential)
    .map(([name]) => name)
    .toSorted(byName);

/** "1 profile", "3 runtimes". */
export const counted = (count: number, singular: string, pluralWord = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralWord}`;

/** "a, b and c". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) as string}`;
}

/** E20: what an edit says about where it lands, or nothing when nobody else uses it. */
export function editConsequence(usage: CatalogUsage): string | undefined {
  if (usage.profiles.length === 0 && usage.runtimes.length === 0) return undefined;
  return `Used by ${counted(usage.profiles.length, 'profile')} and ${counted(usage.runtimes.length, 'runtime')}. Saving changes it everywhere. Running sessions keep the old version until restarted.`;
}

// ── The catalogue projections ────────────────────────────────────────────────────────────────────
//
// What `GET /v1/fleet/machine`, `/components`, `/profile-stacks` and `/runtimes` answer, as values: the
// layering module decides what a stack IS; these only say it in the product's words (§4.2).

/** The facts a projection reads that the configuration does not hold. */
export interface CatalogFacts {
  readonly format: FleetCatalogFormat;
  readonly machineName: string;
  /** The command each harness resolves to on this machine, `undefined` when it is not installed. */
  readonly tools: Readonly<Record<HarnessKind, string | undefined>>;
  readonly runningSessions: number;
  /** Why changes are refused right now, or `undefined` when this machine accepts them. */
  readonly changesRefusal?: string;
  /** Each settings component's parsed file, by component name, so conflicts are real ones. */
  readonly settingsBodies?: Readonly<Record<string, SettingsObject>>;
  /** Instructions text and skill frontmatter, for partial support (K5). */
  readonly instructionBodies?: Readonly<Record<string, string>>;
  readonly skillFrontmatter?: Readonly<Record<string, readonly string[]>>;
  /** MCP commands this machine does not have (K6, E8). */
  readonly missingCommands?: ReadonlySet<string>;
  /** Each credential's status word, from the credentials surface's own reading. */
  readonly credentialStatus?: Readonly<Record<string, FleetCredentialStatusWord>>;
  /** Whether the installed Claude accepts Auto mode (O4). Measured on the pinned version; nothing is launched to find out. */
  readonly acceptsAutoPermissionMode: boolean;
}

const HARNESSES: readonly HarnessKind[] = ['claude', 'codex'];

const act = (reason: string | undefined): FleetCatalogAct =>
  reason === undefined ? { available: true } : { available: false, reason };

/** `GET /v1/fleet/machine`. */
export function machineView(model: AccountModel, facts: CatalogFacts): FleetMachineView {
  const runtimeCount = Object.keys(model.runtimes).length;
  return {
    name: facts.machineName,
    format: facts.format,
    setUp: runtimeCount > 0,
    agentPermissions: model.machine.agentPermissions,
    tools: HARNESSES.map(harness => {
      const command = facts.tools[harness];
      return {
        harness,
        label: HARNESS_DISPLAY_NAMES[harness],
        installed: command !== undefined,
        ...(command === undefined ? {} : { command }),
      };
    }),
    runtimeCount,
    runningSessions: facts.runningSessions,
    changes: act(facts.changesRefusal),
  };
}

/** The six kinds, in the order the Components tab lists them, with their one-line description. */
const KIND_GROUPS: readonly { readonly kind: ComponentKind; readonly label: string; readonly description: string }[] = [
  { kind: 'instructions', label: 'Instructions', description: 'Guidance every session reads first.' },
  { kind: 'mcp', label: 'MCP servers', description: 'Tools a session can call.' },
  { kind: 'skills', label: 'Skills', description: 'Named abilities a session can use.' },
  { kind: 'settings', label: 'Settings', description: 'Flags, environment and options for one tool.' },
  { kind: 'hooks', label: 'Hooks', description: 'Commands that run at points in a session, for one tool.' },
  { kind: 'modelSets', label: 'Model sets', description: 'The models a runtime offers, and its default.' },
];

/** One environment entry as it may travel: a value only when it is not a secret (K4). */
const envEntries = (env: Readonly<Record<string, string>> | undefined): FleetEnvEntry[] =>
  Object.entries(env ?? {})
    .toSorted(([left], [right]) => byName(left, right))
    .map(([name, value]) => (looksSecret(name, value) ? { name, hidden: true as const } : { name, value }));

function componentDetail(kind: ComponentKind, component: Record<string, unknown>): FleetComponentDetail {
  const env = component.env as Readonly<Record<string, string>> | undefined;
  const text = (key: string) => (typeof component[key] === 'string' ? { [key]: component[key] as string } : {});
  switch (kind) {
    case 'instructions':
      return { kind, file: component.file as string };
    case 'mcp':
      return {
        kind,
        ...text('command'),
        ...(Array.isArray(component.args) ? { args: [...(component.args as string[])] } : {}),
        ...text('url'),
        env: envEntries(env),
      };
    case 'skills':
      return { kind, items: [...(component.items as string[])] };
    case 'settings':
      return {
        kind,
        ...text('file'),
        ...(Array.isArray(component.flags) ? { flags: [...(component.flags as string[])] } : {}),
        env: envEntries(env),
      };
    case 'hooks':
      return { kind, ...text('file'), ...text('directory') };
    default:
      return { kind, models: [...(component.models as string[])], default: component.default as string };
  }
}

/** The partial-support table for this machine's components, from the bodies the caller read. */
const partialSupportOf = (model: AccountModel, facts: CatalogFacts): readonly PartialSupport[] =>
  componentPartialSupport({
    components: model.components,
    ...(facts.instructionBodies === undefined ? {} : { instructionBodies: facts.instructionBodies }),
    ...(facts.skillFrontmatter === undefined ? {} : { skillFrontmatter: facts.skillFrontmatter }),
  });

/** `GET /v1/fleet/components`. */
export function componentCatalog(model: AccountModel, facts: CatalogFacts): FleetComponentCatalog {
  const partial = partialSupportOf(model, facts);
  return {
    format: facts.format,
    kinds: KIND_GROUPS.map(group => ({
      ...group,
      components: Object.entries(model.components[group.kind] as Record<string, Record<string, unknown>>)
        .toSorted(([left], [right]) => byName(left, right))
        .map(([name, component]) => {
          const reference = `${group.kind}/${name}` as LayerReferenceText;
          const usage = componentUsage(model, reference);
          const harness = typeof component.harness === 'string' ? (component.harness as HarnessKind) : undefined;
          const command = typeof component.command === 'string' ? component.command : undefined;
          const missing = command !== undefined && facts.missingCommands?.has(command) === true;
          return {
            reference,
            kind: group.kind,
            name,
            ...(harness === undefined ? {} : { harness }),
            detail: componentDetail(group.kind, component),
            partial: partial
              .filter(entry => entry.reference === reference)
              .map(entry => ({ harness: entry.harness, reason: describePartialSupport(entry) })),
            warnings: missing ? [`Command not found: ${command as string}`] : [],
            usedBy: { profiles: usage.profiles, runtimes: usage.runtimes },
            editNote: editConsequence(usage) ?? 'Nothing uses it yet.',
            remove: act(
              usage.direct.length === 0
                ? undefined
                : `It is a layer in ${listed(usage.direct)}. Remove it from ${usage.direct.length === 1 ? 'that profile' : 'those profiles'} first.`,
            ),
          };
        }),
    })),
  };
}

/** A layer's own name, the way a profile shows it. */
const layerName = (layer: FlatLayer): string => layer.name;

/** A component's words in a skip note: "Settings claude-settings". */
const KIND_LABELS: Readonly<Record<ComponentKind, string>> = {
  instructions: 'Instructions',
  mcp: 'MCP server',
  skills: 'Skills',
  settings: 'Settings',
  hooks: 'Hooks',
  modelSets: 'Model set',
};

function skippedSentence(skip: SkippedLayer, harness: HarnessKind): string {
  const what = `${KIND_LABELS[skip.layer.componentKind]} ${skip.layer.name}`;
  if (skip.reason === 'no-model-for-harness') {
    return `${what} has no ${HARNESS_DISPLAY_NAMES[harness]} model, so it is skipped on ${HARNESS_DISPLAY_NAMES[harness]}.`;
  }
  return `${what} is for ${HARNESS_DISPLAY_NAMES[skip.harness ?? harness]} only, so it is skipped on ${HARNESS_DISPLAY_NAMES[harness]}.`;
}

/** P5, E14: why a profile cannot be used with a login of this harness. */
function unavailableReason(resolved: ResolvedProfile): string | undefined {
  const availability = resolved.availability;
  if (availability.available) return undefined;
  if (availability.reason === 'empty') return 'This profile has no layers yet.';
  const owners = new Set(resolved.skipped.flatMap(skip => (skip.harness === undefined ? [] : [skip.harness])));
  const only = owners.size === 1 ? HARNESS_DISPLAY_NAMES[[...owners][0] as HarnessKind] : undefined;
  return only === undefined
    ? `Nothing here applies on ${HARNESS_DISPLAY_NAMES[resolved.harness]}.`
    : `Only ${only} settings. Nothing here applies on ${HARNESS_DISPLAY_NAMES[resolved.harness]}.`;
}

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

function conflictView(conflict: Conflict): FleetLayerConflict {
  return {
    harness: conflict.harness,
    field: conflict.field,
    key: conflict.key,
    sentence: describeConflict(conflict),
    winner: layerName(conflict.winner.layer),
    overridden: conflict.overridden.map(setter => layerName(setter.layer)),
  };
}

/** A profile resolved for one harness, or `undefined` when it cannot be (a document the schema refused). */
function resolvedFor(
  model: AccountModel,
  profile: string,
  harness: HarnessKind,
  facts: CatalogFacts,
  partial: readonly PartialSupport[],
): ResolvedProfile | undefined {
  const result = resolveProfile({
    model,
    profile,
    harness,
    partialSupport: partial,
    ...(facts.settingsBodies === undefined ? {} : { settingsBodies: facts.settingsBodies }),
  });
  return result.ok ? result.resolved : undefined;
}

function stackView(resolved: ResolvedProfile | undefined, harness: HarnessKind): FleetStackView {
  if (resolved === undefined) {
    return {
      harness,
      available: { available: false, reason: 'This profile cannot be read.' },
      applied: [],
      skipped: [],
      conflicts: [],
      partial: [],
    };
  }
  return {
    harness,
    available: act(unavailableReason(resolved)),
    applied: resolved.applied.map(layer => layer.reference),
    skipped: resolved.skipped.map(skip => ({
      reference: skip.layer.reference,
      sentence: skippedSentence(skip, harness),
    })),
    conflicts: resolved.conflicts.map(conflictView),
    partial: resolved.partial.map(entry => ({ reference: entry.reference, reason: describePartialSupport(entry) })),
  };
}

/** `GET /v1/fleet/profile-stacks`. */
export function profileCatalog(model: AccountModel, facts: CatalogFacts): FleetLayeredProfileCatalog {
  const partial = partialSupportOf(model, facts);
  return {
    format: facts.format,
    profiles: Object.entries(model.profiles)
      .toSorted(([left], [right]) => byName(left, right))
      .map(([name, profile]) => {
        const usage = profileUsage(model, name);
        return {
          name,
          layers: [...profile.layers],
          usedBy: runtimesUsingProfile(model, name),
          baseFor: usage.direct,
          wouldIncludeItself: Object.keys(model.profiles)
            .filter(other => wouldIncludeItself(model.profiles, name, other))
            .toSorted(byName),
          harnesses: HARNESSES.map(harness => stackView(resolvedFor(model, name, harness, facts, partial), harness)),
          remove: act(
            usage.direct.length === 0
              ? undefined
              : `It is a base for ${listed(usage.direct)}. Remove it from ${usage.direct.length === 1 ? 'that profile' : 'those profiles'} first.`,
          ),
        };
      }),
  };
}

function modelSetView(resolved: ResolvedProfile | undefined): FleetRuntimeModelSet {
  const set = resolved?.modelSet;
  if (set === undefined || set.source === 'harness-default') return { source: 'harness-default' };
  const note = set.noneAvailable
    ? 'None of these models is available on this login, so the tool picks its own.'
    : set.fellBack
      ? `${set.declaredDefault} is not available on this login, so ${set.default as string} is the default.`
      : undefined;
  return {
    source: 'model-set',
    name: set.layer.name,
    models: set.models.map(model => ({ id: model.id, available: model.available })),
    declaredDefault: set.declaredDefault,
    ...(set.default === undefined ? {} : { default: set.default }),
    ...(note === undefined ? {} : { note }),
  };
}

/** A fixed-layer entry in words: trust and onboarding by what they switch off. */
const FIXED_ENTRY_WORDS: Readonly<Partial<Record<FixedEntry['purpose'], { key: string; value: string }>>> = {
  trust: { key: 'trust prompt', value: 'off' },
  onboarding: { key: 'onboarding screens', value: 'off' },
};

/** The folder the read-only view is computed for: entries naming a folder are shown by purpose. */
const VIEW_FOLDER = '/ferretry-launch-folder';

const OVERRIDE_SENTENCE = (from: string): string => `From your ${from} · Overridden for agents by Ferretry`;

function fixedLayerView(
  model: AccountModel,
  harness: HarnessKind,
  resolved: ResolvedProfile | undefined,
  facts: CatalogFacts,
): { readonly view?: FleetFixedLayerView; readonly refusal?: string } {
  const result =
    harness === 'claude'
      ? fixedLayerFor({
          harness,
          agentPermissions: model.machine.agentPermissions,
          cwd: VIEW_FOLDER,
          acceptsAutoPermissionMode: facts.acceptsAutoPermissionMode,
        })
      : fixedLayerFor({ harness, agentPermissions: model.machine.agentPermissions, cwd: VIEW_FOLDER });
  if (!result.ok) return { refusal: result.refusal.message };
  const fixed = result.layer;
  const overridden =
    resolved === undefined
      ? []
      : applyFixedLayer(resolved, fixed).overridden.map(entry =>
          entry.kind === 'setting'
            ? {
                key: entry.key,
                value: shown(entry.value),
                from: entry.layer.name,
                sentence: OVERRIDE_SENTENCE(entry.layer.name),
              }
            : {
                key: entry.tokens[0] as string,
                value: entry.tokens.join(' '),
                from: entry.layer.name,
                sentence: OVERRIDE_SENTENCE(entry.layer.name),
              },
        );
  return {
    view: {
      agentPermissions: fixed.agentPermissions,
      entries: fixed.entries.map(
        entry => FIXED_ENTRY_WORDS[entry.purpose] ?? { key: entry.key, value: shown(entry.value) },
      ),
      overridden,
    },
  };
}

/** `GET /v1/fleet/runtimes`. */
export function runtimeCatalog(model: AccountModel, facts: CatalogFacts): FleetRuntimeCatalog {
  const partial = partialSupportOf(model, facts);
  return {
    format: facts.format,
    runtimes: Object.entries(model.runtimes)
      .toSorted(([left], [right]) => byName(left, right))
      .flatMap(([name, runtime]) => {
        const credential = model.credentials[runtime.credential];
        // Present by construction: the schema refused a runtime on an unknown login.
        if (credential === undefined) return [];
        const harness = credential.harness;
        const resolved = resolvedFor(model, runtime.profile, harness, facts, partial);
        const stack = stackView(resolved, harness);
        const fixed = runtime.agent ? fixedLayerView(model, harness, resolved, facts) : {};
        const status = facts.credentialStatus?.[runtime.credential];
        const blocked =
          facts.tools[harness] === undefined
            ? `Install ${HARNESS_DISPLAY_NAMES[harness]} to launch`
            : status === 'needs_sign_in'
              ? 'Sign in to launch'
              : stack.available.available
                ? fixed.refusal
                : stack.available.reason;
        return [
          {
            name,
            harness,
            credential: {
              id: runtime.credential,
              store: credential.store,
              ...(credential.label === undefined ? {} : { label: credential.label }),
              ...(status === undefined ? {} : { status }),
            },
            profile: runtime.profile,
            agent: runtime.agent,
            stack,
            modelSet: modelSetView(resolved),
            ...(fixed.view === undefined ? {} : { fixedLayer: fixed.view }),
            launch: act(blocked),
            sameAs: Object.entries(model.runtimes)
              .filter(
                ([other, peer]) =>
                  other !== name && peer.credential === runtime.credential && peer.profile === runtime.profile,
              )
              .map(([other]) => other)
              .toSorted(byName),
          },
        ];
      }),
  };
}
