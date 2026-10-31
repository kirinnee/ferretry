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
  COMPONENT_KIND_WORDS,
  type ComponentKind,
  type Conflict,
  componentPartialSupport,
  componentScope,
  describeConflict,
  describePartialSupport,
  describeScopeConflict,
  type FixedEntry,
  type FlatLayer,
  fixedLayerFor,
  flattenProfile,
  freeName,
  HARNESS_DISPLAY_NAMES,
  type HarnessKind,
  type LayerReferenceText,
  layersScope,
  layerWords,
  loginModelCatalog,
  looksSecret,
  type ModelCatalogSources,
  type PartialSupport,
  type ProfileScope,
  parseLayerReference,
  profileScope,
  type ResolvedProfile,
  resolveDefaultRuntime,
  resolveProfile,
  runtimeDisable,
  runtimeHarness,
  runtimeModels,
  type SettingsObject,
  type SkippedLayer,
  wouldIncludeItself,
} from '@ferretry/fleet';
import type {
  AutoResumeSummary,
  FleetCatalogAct,
  FleetCatalogFormat,
  FleetComponentCatalog,
  FleetComponentContent,
  FleetComponentDetail,
  FleetCredentialStatusWord,
  FleetEnvEntry,
  FleetFixedLayerView,
  FleetLayerConflict,
  FleetLayeredProfileCatalog,
  FleetMachineAuthority,
  FleetMachineView,
  FleetProfileDraftRequest,
  FleetProfileDraftView,
  FleetProfileScope,
  FleetRuntimeCatalog,
  FleetRuntimeModelSet,
  FleetRuntimeModels,
  FleetSettingsEntry,
  FleetStackView,
} from '@ferretry/protocol';
import { claudeFastSupport } from '../session/harness/fast-mode.ts';
import { runtimeDisabledView } from './disabled-view.ts';
import { resolvedEntries } from './resolved-view.ts';

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
// What `GET /v1/fleet/machine`, `/components`, `/profiles` and `/runtimes` answer, as values: the
// layering module decides what a stack IS; these only say it in the product's words (§4.2).

/** The facts a projection reads that the configuration does not hold. */
export interface CatalogFacts {
  readonly format: FleetCatalogFormat;
  readonly machineName: string;
  /** The command each harness resolves to on this machine, `undefined` when it is not installed. */
  readonly tools: Readonly<Record<HarnessKind, string | undefined>>;
  readonly runningSessions: number;
  /** Each runtime's stable id from `ids.json`, by name. A runtime the last apply never published has none. */
  readonly runtimeIds?: Readonly<Record<string, string>>;
  /** Each settings component's parsed file, by component name, so conflicts are real ones. */
  readonly settingsBodies?: Readonly<Record<string, SettingsObject>>;
  /** Instructions text and skill frontmatter, for partial support (K5). */
  readonly instructionBodies?: Readonly<Record<string, string>>;
  readonly skillFrontmatter?: Readonly<Record<string, readonly string[]>>;
  /** Each hooks component's file text, for the edit screen and E30. */
  readonly hooksTexts?: Readonly<Record<string, string>>;
  /** This machine's user home: a path under it is not one to check (E30). */
  readonly userHome: string;
  /** MCP commands this machine does not have (K6, E8). */
  readonly missingCommands?: ReadonlySet<string>;
  /** Each credential's status word, from the credentials surface's own reading. */
  readonly credentialStatus?: Readonly<Record<string, FleetCredentialStatusWord>>;
  /** Whether the installed Claude accepts Auto mode (O4). Measured on the pinned version; nothing is launched to find out. */
  readonly acceptsAutoPermissionMode: boolean;
  /** The model catalogs and presets in effect (docs/model-catalog.md); absent, runtimes show their model set only. */
  readonly modelCatalogs?: ModelCatalogSources;
  /** What the last auto-resume pass did, or `null`/absent when none has run. */
  readonly lastAutoResume?: AutoResumeSummary | null;
  /** The instant (ms) a `disabled.until` is read against; absent, no switch has expired. */
  readonly now?: number;
}

const HARNESSES: readonly HarnessKind[] = ['claude', 'codex'];

const act = (reason: string | undefined): FleetCatalogAct =>
  reason === undefined ? { available: true } : { available: false, reason };

/** `GET /v1/fleet/machine`, with what the caller asking may do to it. */
export function machineView(
  model: AccountModel,
  facts: CatalogFacts,
  authority: FleetMachineAuthority,
): FleetMachineView {
  const runtimeCount = Object.keys(model.runtimes).length;
  return {
    name: facts.machineName,
    format: facts.format,
    setUp: runtimeCount > 0,
    agentPermissions: model.machine.agentPermissions,
    defaultRuntime: resolveDefaultRuntime(model) ?? null,
    agentControl: { ...model.machine.agentControl },
    browserMode: model.machine.browserMode,
    browserProxy: model.machine.browserProxy ?? null,
    browserPorts: model.machine.browserPorts,
    browserFirewallFailure: model.machine.browserFirewallFailure,
    autoResume: model.machine.autoResume,
    agendaMode: model.machine.agendaMode,
    lastAutoResume: facts.lastAutoResume ?? null,
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
    authority,
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
        ...(component.auth === 'oauth' ? { auth: 'oauth' as const } : {}),
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

// ── Component content ────────────────────────────────────────────────────────────────────────────
//
// What a component's file says, for the edit screen: instructions and hooks as text, settings as
// dotted entries. Every value `looksSecret` flags is cut out before it leaves, the same rule the
// environment rows follow (K4), so a credential pasted into a file never reaches a browser.

/** What a hidden value is replaced by in a component's text. */
const HIDDEN_TEXT = '‹hidden›';

/** `NAME=value`, `name: value`, `"name": "value"` — a value with the name that says what it is. */
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]+)/gu;

/** One bare word of text, for a value whose own shape says it is a token. */
const WORD = /[^\s"'`,;()[\]{}<>]+/gu;

/** A component's text with every secret-looking value replaced by {@link HIDDEN_TEXT}. */
export function redactText(text: string): { readonly text: string; readonly redacted: boolean } {
  let redacted = false;
  const named = text.replace(ASSIGNMENT, (whole, name: string, separator: string, value: string) => {
    if (!looksSecret(name, value)) return whole;
    redacted = true;
    return `${name}${separator}${HIDDEN_TEXT}`;
  });
  const bare = named.replace(WORD, word => {
    if (!looksSecret('', word)) return word;
    redacted = true;
    return HIDDEN_TEXT;
  });
  return { text: bare, redacted };
}

const isTable = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;

/**
 * A settings document as dotted keys, sorted: an object nests, and an array, a scalar or `{}` is one
 * entry. The inverse of what an edit by entry builds.
 */
export function flattenSettings(settings: SettingsObject): readonly (readonly [string, unknown])[] {
  const entries: (readonly [string, unknown])[] = [];
  const walk = (prefix: string, value: unknown): void => {
    if (prefix !== '' && !isTable(value)) {
      entries.push([prefix, value]);
      return;
    }
    for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      walk(prefix === '' ? key : `${prefix}.${key}`, child);
    }
  };
  walk('', settings);
  return entries.toSorted(([left], [right]) => byName(left, right));
}

/** A settings value in words: a string as it is, anything else as its JSON text. */
export const settingsValueText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

function settingsEntries(settings: SettingsObject): FleetSettingsEntry[] {
  return flattenSettings(settings).map(([key, value]) => {
    const text = settingsValueText(value);
    return looksSecret(key, text) ? { key, hidden: true as const } : { key, value: text };
  });
}

function componentContent(kind: ComponentKind, name: string, facts: CatalogFacts): FleetComponentContent | undefined {
  if (kind === 'settings') {
    const body = facts.settingsBodies?.[name];
    return body === undefined ? undefined : { form: 'entries', entries: settingsEntries(body) };
  }
  const text =
    kind === 'instructions' ? facts.instructionBodies?.[name] : kind === 'hooks' ? facts.hooksTexts?.[name] : undefined;
  return text === undefined ? undefined : { form: 'text', ...redactText(text) };
}

/** A path under a person's home on macOS or Linux, as it appears in text (U15's clone uses the same). */
const HOME_PATH = /\/(?:Users|home)\/[^\s"'`,;)}\]]+/gu;

/**
 * E30: the first path this component names under somebody else's home — a component copied from
 * another machine still pointing there. A path under this machine's own home is not one.
 */
function checkPathOf(kind: ComponentKind, name: string, component: Record<string, unknown>, facts: CatalogFacts) {
  const texts: string[] = [];
  if (kind === 'instructions') texts.push(facts.instructionBodies?.[name] ?? '');
  if (kind === 'hooks') texts.push(facts.hooksTexts?.[name] ?? '');
  if (kind === 'settings') {
    // A hidden value is never searched: its path would say what it was.
    const entries = settingsEntries(facts.settingsBodies?.[name] ?? {});
    texts.push(...entries.flatMap(entry => ('value' in entry ? [entry.value] : [])));
  }
  if (kind === 'mcp') {
    for (const field of ['command', 'url'] as const) {
      if (typeof component[field] === 'string') texts.push(component[field] as string);
    }
    if (Array.isArray(component.args)) texts.push(...(component.args as string[]));
  }
  const home = facts.userHome;
  for (const text of texts) {
    for (const match of redactText(text).text.matchAll(HOME_PATH)) {
      const path = match[0];
      if (path !== home && !path.startsWith(`${home}/`)) return path;
    }
  }
  return undefined;
}

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
          const content = componentContent(group.kind, name, facts);
          const checkPath = checkPathOf(group.kind, name, component, facts);
          return {
            reference,
            kind: group.kind,
            name,
            ...(harness === undefined ? {} : { harness }),
            scope: componentScope(group.kind, component),
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
            ...(content === undefined ? {} : { content }),
            ...(checkPath === undefined ? {} : { checkPath }),
            ...(typeof component.clonedFrom === 'string' ? { clonedFrom: component.clonedFrom } : {}),
            ...(typeof component.clonedFromDaemon === 'string' ? { clonedFromDaemon: component.clonedFromDaemon } : {}),
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

/** A profile's derived scope as the wire carries it: a mixed one as the sentence naming its layers. */
const scopeView = (scope: ProfileScope, name: string | undefined): FleetProfileScope =>
  scope.kind === 'mixed' ? { kind: 'mixed', sentence: describeScopeConflict(scope, name) } : scope;

/** `GET /v1/fleet/profiles`. */
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
          scope: scopeView(profileScope(model, name), name),
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
  return {
    source: 'model-set',
    name: set.layer.name,
    models: set.models.map(model => ({ id: model.id, available: model.available })),
    declaredDefault: set.declaredDefault,
    ...(set.default === undefined ? {} : { default: set.default }),
  };
}

/** What a runtime offers from its login's model catalog (docs/model-catalog.md), when it reads one. */
function modelsView(
  resolved: ResolvedProfile | undefined,
  harness: HarnessKind,
  credential: AccountModel['credentials'][string],
  sources: ModelCatalogSources | undefined,
): { readonly models?: FleetRuntimeModels } {
  if (sources === undefined) return {};
  const derived = runtimeModels({
    harness,
    modelSet: resolved?.modelSet,
    ...loginModelCatalog(credential, harness, sources),
  });
  if (derived.catalog === undefined) return {};
  return {
    models: {
      catalog: derived.catalog,
      choices: derived.models.map(model => ({
        ...model,
        efforts: [...model.efforts],
        // Claude's fast mode is a rule on the model id; Codex's is the live account's to say.
        ...(harness === 'claude' ? { fast: claudeFastSupport(model.id) } : {}),
      })),
      ...(derived.default === undefined ? {} : { default: derived.default }),
      ...(derived.local === undefined ? {} : { local: derived.local }),
    },
  };
}

/** A fixed-layer entry in words: trust and onboarding by what they switch off. */
const FIXED_ENTRY_WORDS: Readonly<Partial<Record<FixedEntry['purpose'], { key: string; value: string }>>> = {
  trust: { key: 'trust prompt', value: 'off' },
  onboarding: { key: 'onboarding screens', value: 'off' },
  'remote-control': { key: 'Remote Control at startup', value: 'off' },
  'one-time-prompts': { key: 'one-time prompts (nudges, upsells, notices)', value: 'off' },
  tools: { key: 'Ferretry tools (terminals and browsers)', value: 'on' },
  instructions: { key: 'Ferretry tools instruction', value: 'on' },
};

/** The folder the read-only view is computed for: entries naming a folder are shown by purpose. */
const VIEW_FOLDER = '/ferretry-launch-folder';

/** The `fy` the read-only view shows the tools server running as; the wrapper names the real path. */
const VIEW_FY_COMMAND = 'fy';

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
          fyCommand: VIEW_FY_COMMAND,
        })
      : fixedLayerFor({
          harness,
          agentPermissions: model.machine.agentPermissions,
          cwd: VIEW_FOLDER,
          fyCommand: VIEW_FY_COMMAND,
        });
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
      // One row per thing switched off: several keys share a purpose, and the person reads the purpose.
      entries: fixed.entries
        .map(entry => FIXED_ENTRY_WORDS[entry.purpose] ?? { key: entry.key, value: shown(entry.value) })
        .filter((row, index, rows) => rows.findIndex(other => other.key === row.key) === index),
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
        // A login that drives both CLIs runs the one this runtime is for.
        const harness = runtimeHarness(model, runtime) as HarnessKind;
        const resolved = resolvedFor(model, runtime.profile, harness, facts, partial);
        const stack = stackView(resolved, harness);
        const fixed = runtime.agent ? fixedLayerView(model, harness, resolved, facts) : {};
        const status = facts.credentialStatus?.[runtime.credential];
        const off = runtimeDisable(model, name, facts.now ?? 0, VIEW_FY_COMMAND);
        const blocked =
          off !== undefined
            ? off.clauses.join('. ')
            : facts.tools[harness] === undefined
              ? `Install ${HARNESS_DISPLAY_NAMES[harness]} to launch`
              : status === 'needs_sign_in'
                ? 'Sign in to launch'
                : stack.available.available
                  ? fixed.refusal
                  : stack.available.reason;
        return [
          {
            // A runtime whose apply never landed has no id yet; its name stands in, and it cannot have
            // a session for any other id to name.
            id: facts.runtimeIds?.[name] ?? name,
            name,
            // The wrapper is named after the runtime (`<bin>/<name>`), and `fy start --agent` takes that name.
            wrapper: name,
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
            ...modelsView(resolved, harness, credential, facts.modelCatalogs),
            ...(fixed.view === undefined ? {} : { fixedLayer: fixed.view }),
            launch: act(blocked),
            ...(off === undefined ? {} : { disabled: runtimeDisabledView(off) }),
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

// ── Layers ───────────────────────────────────────────────────────────────────────────────────────

/** The product's word for each kind, singular, as a sentence uses it. The fleet's, so a scope refusal and a layer refusal say a layer the same way. */
export const KIND_WORDS = COMPONENT_KIND_WORDS;

/** The plain words for a layer in a refusal: "profile base", "instructions main". */
export { layerWords };

/**
 * Why profile `name` cannot have these layers — one that is not a layer, is there twice, does not
 * exist, would include the profile itself (P3, E19), or would make it both Claude only and Codex only
 * (P7) — or `undefined` when it can. The one reading a save refuses with and a draft preview reports.
 * `named` is false for a draft that has no name yet, so its sentence says "A profile".
 */
export function layersRefusal(
  model: AccountModel,
  name: string,
  layers: readonly string[],
  named = true,
): string | undefined {
  const seen = new Set<string>();
  for (const text of layers) {
    const reference = parseLayerReference(text);
    if (reference === undefined) return `"${text}" is not a layer — write <kind>/<name> or profile/<name>`;
    if (seen.has(text)) return `${layerWords(text)} is in the layers twice`;
    seen.add(text);
    if (reference.kind === 'profile') {
      if (model.profiles[reference.name] === undefined) return `no profile ${reference.name} exists on this machine`;
      if (wouldIncludeItself(model.profiles, name, reference.name)) {
        return `profile ${reference.name} would include itself: it is ${name} or is built on it`;
      }
      continue;
    }
    if (model.components[reference.componentKind][reference.name] === undefined) {
      return `no ${KIND_WORDS[reference.componentKind]} ${reference.name} exists on this machine`;
    }
  }
  const scope = layersScope(model, layers, name);
  return scope.kind === 'mixed' ? describeScopeConflict(scope, named ? name : undefined) : undefined;
}

/** The name a draft that is not an edit stands under: one no profile has. */
const DRAFT_NAME = 'draft';

/**
 * `POST /v1/fleet/profiles/preview`: a profile's layers before they are saved, resolved per
 * harness exactly as {@link profileCatalog} resolves a saved one. The draft stands in a copy of the
 * model under the profile being edited, or a name no profile has.
 */
export function profileDraftView(
  model: AccountModel,
  request: FleetProfileDraftRequest,
  facts: CatalogFacts,
): FleetProfileDraftView {
  const name = request.editing ?? freeName(DRAFT_NAME, candidate => model.profiles[candidate] !== undefined);
  const draft = {
    ...model,
    profiles: { ...model.profiles, [name]: { layers: [...request.layers] as LayerReferenceText[] } },
  } as AccountModel;
  const partial = partialSupportOf(draft, facts);
  const refusal = layersRefusal(model, name, request.layers, request.editing !== undefined);
  const stacks = HARNESSES.map(harness => ({ harness, resolved: resolvedFor(draft, name, harness, facts, partial) }));
  return {
    harnesses: stacks.map(stack => stackView(stack.resolved, stack.harness)),
    resolved: stacks.flatMap(stack => (stack.resolved === undefined ? [] : resolvedEntries(stack.resolved))),
    scope: scopeView(layersScope(model, request.layers, name), request.editing),
    ...(refusal === undefined ? {} : { refusal }),
  };
}
