/**
 * Profile layering — the pure core every later unit reads a profile through
 * (docs/design/account-model.md §3.4, E14, E18, E19, E22, E23).
 *
 * A profile is an ordered stack of layers, oldest first, and the newer layer always overrides the
 * older (P1, P2). This module owns the three answers a profile gives and nothing else:
 *
 * 1. **Flattening** ({@link flattenProfile}): the profile's bases expanded in place, so the result is
 *    a list of components only. The same component reached twice counts once, at its **newest**
 *    position. A profile that reaches itself is refused (P3, E19) rather than expanded forever.
 * 2. **Applicability** (P5, E14, E22): a runtime's harness keeps only the layers that belong to it.
 *    A harness-narrowed component of the other harness is skipped, a model set with no model of this
 *    harness is skipped, and a profile in which nothing applies is unavailable, with the reason.
 * 3. **Merging** ({@link resolveProfile}), per kind, exactly as the §3.4 table says:
 *
 *    | Kind         | Merge                                                                  |
 *    | ------------ | ---------------------------------------------------------------------- |
 *    | Instructions | all apply, oldest → newest                                             |
 *    | MCP servers  | union by server name, the later replacing the earlier                  |
 *    | Skills       | union by item name, the later replacing the earlier                    |
 *    | Settings     | `file` deep-merged (later key wins), `flags` appended oldest first,    |
 *    |              | `env` merged by variable (later wins)                                  |
 *    | Hooks        | all apply, in layer order                                              |
 *    | Model set    | the newest APPLICABLE set is the runtime's set; earlier ones never mix |
 *
 *    Every key two layers set to different values is a **conflict** (P4, E18): information naming
 *    the key, the winning layer and every layer it beat, never an error.
 *
 * WHICH HARNESS A MODEL SET IS FOR. A model set carries no harness, so it is derived from its ids:
 * every model id belongs to exactly one harness ({@link modelHarness}, the one owner of that
 * mapping), and a set applies to a runtime when it holds at least one model of the runtime's
 * harness, filtered to those. That is deterministic on purpose: which set wins never depends on
 * what a login can use today. Live availability (E23) only marks models WITHIN the winning set and
 * moves the default to the first available one when the declared default is not.
 *
 * READING FILES IS NOT HERE. A settings component's `file` is IO, so the caller hands in each body
 * already parsed; a component whose body was not supplied is merged as empty and named in
 * `settings.unread`, so a missing read is never silent. Instructions and hooks are returned as the
 * ordered components they are, for the adapter (`./adapt.ts`) to read and write.
 *
 * The fixed layer an agent runtime gets last is `./fixed-layer.ts`'s, and is applied on top of a
 * {@link ResolvedProfile}, never inside it.
 *
 * Pure and total throughout: no filesystem, no environment, no clock, and every failure is a value.
 */
import type { HarnessKind } from '../manifest.ts';
import { deepMergeSettings, type SettingsObject } from '../settings.ts';
import {
  type AccountModel,
  type ComponentKind,
  type ComponentOf,
  type HooksComponent,
  type InstructionsComponent,
  type LayerReferenceText,
  layerReferenceText,
  type McpComponent,
  parseLayerReference,
} from './schema.ts';

// ── Model ids ────────────────────────────────────────────────────────────────────────────────────

/** Claude Code's own model aliases, accepted by `--model` in place of a full id. */
const CLAUDE_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

/**
 * The harness a model id belongs to, or `undefined` for an id neither harness is known to run.
 *
 * The ONE owner of this mapping: a Claude id is `claude-…` or one of Claude Code's aliases (each
 * optionally with a context suffix such as `[1m]`); a Codex id is `gpt-…`, `codex-…` or an `o<n>…`
 * reasoning model. An id that is neither belongs to no harness, so a model set holding only such
 * ids applies nowhere and says so.
 */
export function modelHarness(id: string): HarnessKind | undefined {
  const bare = id.replace(/\[[^\]]*\]$/, '').toLowerCase();
  if (bare.startsWith('claude-') || CLAUDE_ALIASES.has(bare)) return 'claude';
  if (bare.startsWith('gpt-') || bare.startsWith('codex-') || /^o\d/.test(bare)) return 'codex';
  return undefined;
}

// ── Flattening ───────────────────────────────────────────────────────────────────────────────────

/** One component in a flattened stack. */
export interface FlatLayer {
  readonly reference: LayerReferenceText;
  readonly componentKind: ComponentKind;
  readonly name: string;
  /**
   * The layer of the profile being flattened that brought this component in: the component itself
   * when the profile names it directly, or the `profile/<base>` it arrived through. This is the
   * "(from _layer_)" a conflict names (E18).
   */
  readonly origin: LayerReferenceText;
  /** The bases it came through, outermost first. Empty when the profile names it directly. */
  readonly via: readonly string[];
}

/** Why a profile could not be flattened. Each is a document the schema would also refuse. */
type FlattenFailure =
  | { readonly kind: 'unknown-profile'; readonly profile: string; readonly via: readonly string[] }
  | { readonly kind: 'unknown-component'; readonly reference: LayerReferenceText; readonly via: readonly string[] }
  | { readonly kind: 'invalid-layer'; readonly text: string; readonly via: readonly string[] }
  /** P3, E19. `cycle` starts and ends with the same profile: `['a', 'b', 'a']`. */
  | { readonly kind: 'loop'; readonly cycle: readonly string[] }
  /** The stack of bases is deeper than {@link MAX_STACK_DEPTH}. */
  | { readonly kind: 'too-deep'; readonly limit: number }
  /** A profile expands to more than {@link MAX_STACK_LAYERS} layers. */
  | { readonly kind: 'too-large'; readonly limit: number };

export type FlattenResult =
  | { readonly ok: true; readonly layers: readonly FlatLayer[] }
  | { readonly ok: false; readonly failure: FlattenFailure };

type Catalogue = Pick<AccountModel, 'profiles' | 'components'>;

/**
 * Flatten profile `name` into its components, oldest first (P1), with every base expanded where it
 * stands and each component kept once, at its newest position (P2).
 *
 * The schema already refuses a document with an unknown layer or a loop, but this is total over any
 * catalogue, so a caller holding one it built itself — a profile being edited — gets a value back.
 */
export function flattenProfile(catalogue: Catalogue, name: string): FlattenResult {
  const stack = expandStack<{ readonly componentKind: ComponentKind; readonly name: string }, FlattenLayerFailure>(
    profile => catalogue.profiles[profile]?.layers,
    text => {
      const reference = parseLayerReference(text);
      if (reference === undefined) return { kind: 'fail', failure: { kind: 'invalid-layer', text } };
      if (reference.kind === 'profile') return { kind: 'base', name: reference.name };
      const canonical = layerReferenceText(reference);
      if (catalogue.components[reference.componentKind][reference.name] === undefined) {
        return { kind: 'fail', failure: { kind: 'unknown-component', reference: canonical } };
      }
      return { kind: 'leaf', key: canonical, item: { componentKind: reference.componentKind, name: reference.name } };
    },
    name,
  );
  if (!stack.ok) return { ok: false, failure: flattenFailureOf(stack.failure) };
  return {
    ok: true,
    layers: stack.entries.map(entry => ({
      reference: entry.key as LayerReferenceText,
      componentKind: entry.item.componentKind,
      name: entry.item.name,
      origin:
        entry.via.length === 0
          ? (entry.key as LayerReferenceText)
          : layerReferenceText({ kind: 'profile', name: entry.via[0] as string }),
      via: entry.via,
    })),
  };
}

type FlattenLayerFailure =
  | { readonly kind: 'invalid-layer'; readonly text: string }
  | { readonly kind: 'unknown-component'; readonly reference: LayerReferenceText };

/** `chain` is the profile whose layer failed, start first: the bases it came through are everything after the start. */
function flattenFailureOf(failure: StackFailure<FlattenLayerFailure>): FlattenFailure {
  switch (failure.kind) {
    case 'unknown-profile':
      return { kind: 'unknown-profile', profile: failure.profile, via: failure.chain.slice(1, -1) };
    case 'loop':
      return { kind: 'loop', cycle: failure.cycle };
    case 'layer':
      return { ...failure.failure, via: failure.chain.slice(1) };
    case 'too-deep':
      return { kind: 'too-deep', limit: failure.limit };
    case 'too-large':
      return { kind: 'too-large', limit: failure.limit };
  }
}

// ── Expansion ────────────────────────────────────────────────────────────────────────────────────

/** Deepest chain of bases a profile may sit under (the start counts as one). A second line of defence. */
export const MAX_STACK_DEPTH = 64;

/** Most layers one profile may expand to, before it is cut to one copy of each. A second line of defence. */
export const MAX_STACK_LAYERS = 10_000;

/** One component of an expanded stack: `via` is the bases it came through, relative to the profile asked about. */
interface StackEntry<T> {
  readonly key: string;
  readonly item: T;
  readonly via: readonly string[];
}

/** What one layer text of a profile is, as the caller reads it. */
export type StackLayer<T, F> =
  | { readonly kind: 'base'; readonly name: string }
  | { readonly kind: 'leaf'; readonly key: string; readonly item: T }
  | { readonly kind: 'fail'; readonly failure: F };

/** Why a stack could not be expanded. `chain` runs from the profile asked about down to the profile concerned. */
export type StackFailure<F> =
  | { readonly kind: 'unknown-profile'; readonly profile: string; readonly chain: readonly string[] }
  | { readonly kind: 'loop'; readonly profile: string; readonly cycle: readonly string[] }
  | { readonly kind: 'layer'; readonly failure: F; readonly chain: readonly string[] }
  | { readonly kind: 'too-deep'; readonly limit: number }
  | { readonly kind: 'too-large'; readonly profile: string; readonly limit: number };

export type StackExpansion<T, F> =
  | { readonly ok: true; readonly entries: readonly StackEntry<T>[] }
  | { readonly ok: false; readonly failure: StackFailure<F> };

/**
 * THE one place a profile's bases are expanded (P1, P2, P3): every `profile/<base>` layer is replaced where it
 * stands, each component is kept once at its NEWEST position, and a profile that reaches itself is refused.
 *
 * A base is expanded ONCE, however many profiles reach it: its expansion does not depend on who reached it, so it is
 * remembered with each `via` relative to the base and the parent prefixes it when splicing it in. Keeping only the
 * newest copy of a component per profile before the parent concatenates gives the same list as keeping it once at the
 * end. Only a base whose whole subtree resolved is remembered, and everything below such a base is known to be free of
 * loops, so a remembered base can never hide one. The depth and size bounds keep the answer small however the
 * profile files are written.
 *
 * A reader that can never answer `fail` (its layers cannot fail to parse) gets an expansion whose failure has no
 * 'layer' arm, so the caller narrows by type rather than by cast; a reader that gains a `fail` answer stops matching
 * that overload and the caller stops compiling.
 */
export function expandStack<T>(
  layersOf: (profile: string) => readonly string[] | undefined,
  read: (text: string) => StackLayer<T, never>,
  start: string,
):
  | { readonly ok: true; readonly entries: readonly StackEntry<T>[] }
  | { readonly ok: false; readonly failure: Exclude<StackFailure<never>, { readonly kind: 'layer' }> };
export function expandStack<T, F>(
  layersOf: (profile: string) => readonly string[] | undefined,
  read: (text: string) => StackLayer<T, F>,
  start: string,
): StackExpansion<T, F>;
export function expandStack<T, F>(
  layersOf: (profile: string) => readonly string[] | undefined,
  read: (text: string) => StackLayer<T, F>,
  start: string,
): StackExpansion<T, F> {
  interface Done {
    readonly entries: readonly StackEntry<T>[];
    /** The profiles on the longest chain of bases below, itself included. */
    readonly height: number;
  }
  type Expanded =
    | { readonly ok: true; readonly done: Done }
    | { readonly ok: false; readonly failure: StackFailure<F> };
  const remembered = new Map<string, Done>();
  const tooDeep: Expanded = { ok: false, failure: { kind: 'too-deep', limit: MAX_STACK_DEPTH } };

  const expand = (name: string, chain: readonly string[]): Expanded => {
    if (chain.length > MAX_STACK_DEPTH) return tooDeep;
    const layers = layersOf(name);
    if (layers === undefined) return { ok: false, failure: { kind: 'unknown-profile', profile: name, chain } };
    const raw: StackEntry<T>[] = [];
    let height = 1;
    for (const text of layers) {
      const layer = read(text);
      if (layer.kind === 'fail') return { ok: false, failure: { kind: 'layer', failure: layer.failure, chain } };
      if (layer.kind === 'leaf') {
        raw.push({ key: layer.key, item: layer.item, via: [] });
        continue;
      }
      const base = layer.name;
      if (chain.includes(base)) {
        return {
          ok: false,
          failure: { kind: 'loop', profile: name, cycle: [...chain.slice(chain.indexOf(base)), base] },
        };
      }
      let inner = remembered.get(base);
      if (inner === undefined) {
        const fresh = expand(base, [...chain, base]);
        if (!fresh.ok) return fresh;
        inner = fresh.done;
      } else if (chain.length + inner.height > MAX_STACK_DEPTH) {
        return tooDeep;
      }
      height = Math.max(height, inner.height + 1);
      for (const entry of inner.entries) raw.push({ key: entry.key, item: entry.item, via: [base, ...entry.via] });
    }
    if (raw.length > MAX_STACK_LAYERS) {
      return { ok: false, failure: { kind: 'too-large', profile: name, limit: MAX_STACK_LAYERS } };
    }
    const newest = new Map<string, number>();
    raw.forEach((entry, index) => {
      newest.set(entry.key, index);
    });
    const done: Done = { entries: raw.filter((entry, index) => newest.get(entry.key) === index), height };
    remembered.set(name, done);
    return { ok: true, done };
  };

  const stack = expand(start, [start]);
  return stack.ok ? { ok: true, entries: stack.done.entries } : stack;
}

// ── Applicability ────────────────────────────────────────────────────────────────────────────────

/**
 * A layer a harness does not use (P5): a component narrowed to the other harness, or a model set
 * with no model of this harness.
 */
export interface SkippedLayer {
  readonly layer: FlatLayer;
  readonly reason: 'other-harness' | 'no-model-for-harness';
  /** The harness the component belongs to, when it names one. */
  readonly harness?: HarnessKind;
}

/**
 * A component this harness honours only in part (K5, E22). Which components those are is the
 * adapter's declared table (`./adapt.ts`, §8.3); layering carries the facts through to the runtime.
 */
export interface PartialSupport {
  readonly reference: LayerReferenceText;
  readonly harness: HarnessKind;
  /** The plain-language reason, e.g. "release-notes limits which tools it may use". */
  readonly reason: string;
}

/** Whether a profile can be used with a credential of this harness at all (P5, E14). */
type ProfileAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      /** `empty`: the profile has no layers. `nothing-applies`: every layer was skipped. */
      readonly reason: 'empty' | 'nothing-applies';
    };

// ── Merge results ────────────────────────────────────────────────────────────────────────────────

/** A component that took part in the merge, with the layer that supplied it. */
export interface Contribution<T> {
  readonly layer: FlatLayer;
  readonly component: T;
}

/** One skill item and the newest layer that selected it. */
interface SkillItem {
  readonly item: string;
  readonly layer: FlatLayer;
}

/** One leaf of the merged settings document and the layer whose value survived. */
export interface SettingLeaf {
  readonly path: readonly string[];
  readonly key: string;
  readonly value: unknown;
  readonly layer: FlatLayer;
}

/** One launch flag and the layer that added it. */
export interface FlagContribution {
  readonly flag: string;
  readonly layer: FlatLayer;
}

/** One environment variable and the layer whose value won. */
interface EnvContribution {
  readonly value: string;
  readonly layer: FlatLayer;
}

/** One value a layer set, as a conflict reports it. */
interface Setter {
  readonly value: unknown;
  readonly layer: FlatLayer;
}

/**
 * Two or more layers setting one key, per harness, to different values (P4, E18). Information, not
 * an error: `winner` is what the runtime gets, `overridden` every value it beat, oldest first.
 *
 * `field` says which part of the merge the key is in, because a settings document's own `env` block
 * and a settings component's `env` are both spelled `env.NAME`.
 */
export interface Conflict {
  readonly harness: HarnessKind;
  readonly field: 'settings' | 'env' | 'model';
  readonly key: string;
  readonly path: readonly string[];
  readonly winner: Setter;
  readonly overridden: readonly Setter[];
}

/** One model of the winning set, marked against what this login can use (E23). */
interface ModelChoice {
  readonly id: string;
  readonly available: boolean;
}

/**
 * The runtime's model set (§3.4, K8, E23).
 *
 * - `harness-default` — no model set in the stack applies, so the harness picks its own model.
 * - `model-set` — the newest applicable set, filtered to this harness's models. `default` is what
 *   the runtime launches with: the set's own default when this login can use it, otherwise the first
 *   model it can (`fellBack`), or `undefined` when it can use none (`noneAvailable`).
 */
export type ResolvedModelSet =
  | { readonly source: 'harness-default' }
  | {
      readonly source: 'model-set';
      readonly layer: FlatLayer;
      readonly models: readonly ModelChoice[];
      readonly declaredDefault: string;
      readonly default: string | undefined;
      readonly fellBack: boolean;
      readonly noneAvailable: boolean;
    };

/** A profile resolved for one harness: everything a runtime of that harness gets from it. */
export interface ResolvedProfile {
  readonly profile: string;
  readonly harness: HarnessKind;
  /** The whole flattened stack, oldest first, before any harness filtering. */
  readonly layers: readonly FlatLayer[];
  /** The layers this harness uses, oldest first. */
  readonly applied: readonly FlatLayer[];
  readonly skipped: readonly SkippedLayer[];
  readonly availability: ProfileAvailability;
  /** Applied components this harness honours only in part. */
  readonly partial: readonly PartialSupport[];
  /** Oldest first, so newer guidance is read last. */
  readonly instructions: readonly Contribution<InstructionsComponent>[];
  /** One per server name, in the order each name first appeared. */
  readonly mcp: readonly Contribution<McpComponent>[];
  /** One per item name, in the order each item first appeared. */
  readonly skills: readonly SkillItem[];
  readonly settings: {
    readonly value: SettingsObject;
    readonly leaves: readonly SettingLeaf[];
    /** Settings components with a `file` whose body the caller did not supply. */
    readonly unread: readonly string[];
  };
  /** Appended oldest first. */
  readonly flags: readonly FlagContribution[];
  readonly env: Readonly<Record<string, EnvContribution>>;
  /** All apply, in layer order. */
  readonly hooks: readonly Contribution<HooksComponent>[];
  readonly modelSet: ResolvedModelSet;
  readonly conflicts: readonly Conflict[];
}

export type ResolveResult =
  | { readonly ok: true; readonly resolved: ResolvedProfile }
  | { readonly ok: false; readonly failure: FlattenFailure };

export interface ResolveInput {
  readonly model: Catalogue;
  readonly profile: string;
  readonly harness: HarnessKind;
  /** Each settings component's parsed `file`, by component name. */
  readonly settingsBodies?: Readonly<Record<string, SettingsObject>>;
  /**
   * The model ids the runtime's credential can use (E23). Absent when nobody knows, in which case
   * every model counts as available.
   */
  readonly availableModels?: readonly string[];
  /** The adapter's partial-support table (K5, E22). */
  readonly partialSupport?: readonly PartialSupport[];
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────────

const componentOf = <K extends ComponentKind>(catalogue: Catalogue, kind: K, name: string): ComponentOf<K> =>
  // Present by construction: flattening refused every unknown component.
  catalogue.components[kind][name] as ComponentOf<K>;

/** The harness a component is narrowed to, or `undefined` for a generic one. */
const componentHarness = (catalogue: Catalogue, layer: FlatLayer): HarnessKind | undefined => {
  if (layer.componentKind === 'modelSets') return undefined;
  return componentOf(catalogue, layer.componentKind, layer.name).harness;
};

/**
 * Resolve profile `profile` for a runtime of `harness`: flatten it, keep what applies, and merge
 * each kind by the §3.4 table.
 */
export function resolveProfile(input: ResolveInput): ResolveResult {
  const flattened = flattenProfile(input.model, input.profile);
  if (!flattened.ok) return flattened;
  const { harness } = input;
  const catalogue = input.model;

  const applied: FlatLayer[] = [];
  const skipped: SkippedLayer[] = [];
  for (const layer of flattened.layers) {
    const owner = componentHarness(catalogue, layer);
    if (owner !== undefined && owner !== harness) {
      skipped.push({ layer, reason: 'other-harness', harness: owner });
      continue;
    }
    if (layer.componentKind === 'modelSets') {
      const set = componentOf(catalogue, 'modelSets', layer.name);
      if (!set.models.some(id => modelHarness(id) === harness)) {
        skipped.push({ layer, reason: 'no-model-for-harness' });
        continue;
      }
    }
    applied.push(layer);
  }

  const availability: ProfileAvailability =
    flattened.layers.length === 0
      ? { available: false, reason: 'empty' }
      : applied.length === 0
        ? { available: false, reason: 'nothing-applies' }
        : { available: true };

  const appliedReferences = new Set(applied.map(layer => layer.reference));
  const partial = (input.partialSupport ?? []).filter(
    entry => entry.harness === harness && appliedReferences.has(entry.reference),
  );

  const conflicts: Conflict[] = [];
  const ofKind = (kind: ComponentKind) => applied.filter(layer => layer.componentKind === kind);

  const instructions = ofKind('instructions').map(layer => ({
    layer,
    component: componentOf(catalogue, 'instructions', layer.name),
  }));
  const hooks = ofKind('hooks').map(layer => ({ layer, component: componentOf(catalogue, 'hooks', layer.name) }));
  // A server's name is its component's name, unique per kind, and P2 keeps each component once —
  // so the union by name is the applied list itself.
  const mcp = ofKind('mcp').map(layer => ({ layer, component: componentOf(catalogue, 'mcp', layer.name) }));

  const skills = new Map<string, SkillItem>();
  for (const layer of ofKind('skills')) {
    for (const item of componentOf(catalogue, 'skills', layer.name).items) {
      // An item is a name in the skills store, so two layers selecting it select the same thing:
      // the newer one is recorded as the source and there is nothing to conflict over.
      skills.set(item, { item, layer });
    }
  }

  const settings = mergeSettings(catalogue, ofKind('settings'), input.settingsBodies ?? {}, harness, conflicts);
  const modelSet = resolveModelSet(catalogue, ofKind('modelSets'), harness, input.availableModels, conflicts);

  return {
    ok: true,
    resolved: {
      profile: input.profile,
      harness,
      layers: flattened.layers,
      applied,
      skipped,
      availability,
      partial,
      instructions,
      mcp,
      skills: [...skills.values()],
      settings: settings.settings,
      flags: settings.flags,
      env: settings.env,
      hooks,
      modelSet,
      conflicts,
    },
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is SettingsObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEmptyObject = (value: unknown): boolean => isPlainObject(value) && Object.keys(value).length === 0;

const SIMPLE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * A settings path as one dotted key. A segment that would be ambiguous in a dotted key — a folder
 * path under Codex's `projects`, say — is quoted, so `projects."/home/me/x".trust_level` reads as
 * three segments.
 */
export function settingsKey(path: readonly string[]): string {
  return path.map(segment => (SIMPLE_SEGMENT.test(segment) ? segment : JSON.stringify(segment))).join('.');
}

/**
 * The leaves of a settings document: every value that is not a non-empty plain object, which is
 * exactly what `deepMergeSettings` replaces wholesale (arrays included).
 */
export function settingsLeaves(
  document: SettingsObject,
  prefix: readonly string[] = [],
): readonly (readonly [readonly string[], unknown])[] {
  return Object.entries(document).flatMap(([key, value]) => {
    const path = [...prefix, key];
    return isPlainObject(value) && Object.keys(value).length > 0
      ? settingsLeaves(value, path)
      : [[path, value] as const];
  });
}

/** Whether `a` is `b` or a path above or below it: a value at one replaces the other. */
export const pathsOverlap = (a: readonly string[], b: readonly string[]): boolean => {
  const shorter = Math.min(a.length, b.length);
  for (let index = 0; index < shorter; index++) if (a[index] !== b[index]) return false;
  return true;
};

const samePath = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && pathsOverlap(a, b);

/** Structural equality over parsed settings values: what JSON and TOML can express. */
export function sameSettingsValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameSettingsValue(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => key in b && sameSettingsValue(a[key], b[key]));
  }
  return Object.is(a, b);
}

function mergeSettings(
  catalogue: Catalogue,
  layers: readonly FlatLayer[],
  bodies: Readonly<Record<string, SettingsObject>>,
  harness: HarnessKind,
  conflicts: Conflict[],
) {
  let value: SettingsObject = {};
  let leaves: SettingLeaf[] = [];
  const unread: string[] = [];
  const flags: FlagContribution[] = [];
  const env: Record<string, EnvContribution> = {};
  const envSetters = new Map<string, Setter[]>();

  for (const layer of layers) {
    const component = componentOf(catalogue, 'settings', layer.name);
    if (component.file !== undefined || component.document !== undefined) {
      const body = bodies[layer.name];
      if (body === undefined) unread.push(layer.name);
      else {
        for (const [path, leafValue] of settingsLeaves(body)) {
          const replaced = leaves.filter(leaf => pathsOverlap(leaf.path, path));
          // An empty table merges into a table already there and changes nothing.
          if (isEmptyObject(leafValue) && replaced.some(leaf => leaf.path.length > path.length)) continue;
          const differing = replaced.filter(
            leaf =>
              !(samePath(leaf.path, path) && sameSettingsValue(leaf.value, leafValue)) &&
              // A key landing inside an empty table fills it rather than overriding it.
              !(isEmptyObject(leaf.value) && leaf.path.length < path.length),
          );
          const winner: SettingLeaf = { path, key: settingsKey(path), value: leafValue, layer };
          if (differing.length > 0) {
            conflicts.push({
              harness,
              field: 'settings',
              key: winner.key,
              path,
              winner: { value: leafValue, layer },
              overridden: differing.map(leaf => ({ value: leaf.value, layer: leaf.layer })),
            });
          }
          leaves = [...leaves.filter(leaf => !replaced.includes(leaf)), winner];
        }
        value = deepMergeSettings(value, body);
      }
    }
    for (const flag of component.flags ?? []) flags.push({ flag, layer });
    for (const [name, envValue] of Object.entries(component.env ?? {})) {
      env[name] = { value: envValue, layer };
      envSetters.set(name, [...(envSetters.get(name) ?? []), { value: envValue, layer }]);
    }
  }

  for (const [name, setters] of envSetters) {
    const winner = setters[setters.length - 1] as Setter;
    const overridden = setters.slice(0, -1).filter(setter => setter.value !== winner.value);
    if (overridden.length === 0) continue;
    conflicts.push({ harness, field: 'env', key: settingsKey(['env', name]), path: ['env', name], winner, overridden });
  }

  return { settings: { value, leaves, unread }, flags, env };
}

// ── Model set ────────────────────────────────────────────────────────────────────────────────────

function resolveModelSet(
  catalogue: Catalogue,
  layers: readonly FlatLayer[],
  harness: HarnessKind,
  availableModels: readonly string[] | undefined,
  conflicts: Conflict[],
): ResolvedModelSet {
  const candidates = layers.map(layer => {
    const set = componentOf(catalogue, 'modelSets', layer.name);
    const ids = set.models.filter(id => modelHarness(id) === harness);
    // A mixed set's own default may be the other harness's model: the first of ours stands in.
    const declaredDefault = ids.includes(set.default) ? set.default : (ids[0] as string);
    return { layer, ids, declaredDefault };
  });
  const winner = candidates[candidates.length - 1];
  if (winner === undefined) return { source: 'harness-default' };

  const overridden = candidates
    .slice(0, -1)
    .filter(candidate => candidate.declaredDefault !== winner.declaredDefault)
    .map(candidate => ({ value: candidate.declaredDefault, layer: candidate.layer }));
  if (overridden.length > 0) {
    conflicts.push({
      harness,
      field: 'model',
      key: 'model',
      path: ['model'],
      winner: { value: winner.declaredDefault, layer: winner.layer },
      overridden,
    });
  }

  const usable = availableModels === undefined ? undefined : new Set(availableModels);
  const models = winner.ids.map(id => ({ id, available: usable === undefined || usable.has(id) }));
  const declaredAvailable = models.some(model => model.id === winner.declaredDefault && model.available);
  const chosen = declaredAvailable ? winner.declaredDefault : models.find(model => model.available)?.id;
  return {
    source: 'model-set',
    layer: winner.layer,
    models,
    declaredDefault: winner.declaredDefault,
    default: chosen,
    fellBack: !declaredAvailable && chosen !== undefined,
    noneAvailable: chosen === undefined,
  };
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

/** The product's name for each harness. */
export const HARNESS_DISPLAY_NAMES: Readonly<Record<HarnessKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** The layer a conflict names: a component or base by its name, the way Profiles show it. */
const layerName = (layer: FlatLayer): string => (parseLayerReference(layer.origin) as { name: string }).name;

/**
 * A conflict in the product's words (P4, E18):
 * "`permissions.defaultMode` · Claude Code: acceptEdits (from agent) overrides plan (from default)".
 */
export function describeConflict(conflict: Conflict): string {
  const beaten = conflict.overridden
    .map(setter => `${shown(setter.value)} (from ${layerName(setter.layer)})`)
    .join(', ');
  return `\`${conflict.key}\` · ${HARNESS_DISPLAY_NAMES[conflict.harness]}: ${shown(conflict.winner.value)} (from ${layerName(conflict.winner.layer)}) overrides ${beaten}`;
}
