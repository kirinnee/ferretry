/**
 * A profile's and a component's **harness scope** — Generic, Claude only or Codex only
 * (docs/design/account-model.md §3.4 P7, K2, K3).
 *
 * The owner's rule, verbatim: "a profile is either generic or CLAUDE only or CODEX only. profiles that
 * import claude only profile (or claude only skill or codex only skill/MCP) will be automatically
 * claude or codex only". So the scope is DERIVED, never stored or hand-set:
 *
 * - **A component's scope** is the harness it belongs to. Settings and Hooks always name one (K2).
 *   Instructions, MCP servers and Skills are generic unless narrowed to one harness (K3). A model set
 *   names no harness, so its scope comes from its ids ({@link modelHarness}): every known id of one
 *   harness makes it that harness's; ids of both, or of neither, leave it generic — exactly when
 *   layering would apply it to both or to neither.
 * - **A profile's scope** is the union of its layers' scopes, a base profile counting as its own
 *   derived scope. Generic + Claude only is Claude only. Claude only + Codex only is **mixed**, which
 *   no save may produce: {@link describeScopeConflict} is the one sentence every refusal says.
 *
 * A mixed profile can still be READ — a configuration written before this rule existed (the first
 * import used to layer both harnesses' settings into one Default profile) must keep loading and
 * launching, P5 still skipping the other harness's layers — so the schema does not refuse one. Every
 * write path refuses to create one or to make one.
 *
 * Pure and total: an unknown layer or a loop (which the schema refuses anyway) reads as generic
 * rather than throwing, so a caller holding a draft it built itself always gets an answer.
 */
import type { HarnessKind } from '../manifest.ts';
import { modelHarness } from './layering.ts';
import {
  type AccountModel,
  type ComponentKind,
  type LayerReferenceText,
  parseLayerReference,
  type ModelSetComponent,
} from './schema.ts';

/** Which harnesses something can be used with: both, or one. */
export type HarnessScope = 'generic' | HarnessKind;

/**
 * A profile's derived scope. `mixed` names the first of its OWN layers that is Claude only and the
 * first that is Codex only — the same layer twice when a base profile is itself mixed.
 */
export type ProfileScope =
  | { readonly kind: 'scoped'; readonly scope: HarnessScope }
  | { readonly kind: 'mixed'; readonly claude: LayerReferenceText; readonly codex: LayerReferenceText };

type Catalogue = Pick<AccountModel, 'profiles' | 'components'>;

/** The product's words for each scope: what a badge says. */
export const HARNESS_SCOPE_WORDS: Readonly<Record<HarnessScope, string>> = {
  generic: 'Generic',
  claude: 'Claude only',
  codex: 'Codex only',
};

/** The product's word for each kind, singular, as a sentence uses it ("settings claude-settings"). */
export const COMPONENT_KIND_WORDS: Readonly<Record<ComponentKind, string>> = {
  instructions: 'instructions',
  mcp: 'MCP server',
  skills: 'skills',
  settings: 'settings',
  hooks: 'hooks',
  modelSets: 'model set',
};

/** A model set's scope, from its ids: one harness's ids only make it that harness's. */
export function modelSetScope(set: Pick<ModelSetComponent, 'models'>): HarnessScope {
  const harnesses = new Set(set.models.flatMap(id => modelHarness(id) ?? []));
  return harnesses.size === 1 ? ([...harnesses][0] as HarnessKind) : 'generic';
}

/** The scope of one component as stored: its `harness` when it names one, else what its kind says. A missing one is generic. */
export function componentScope(kind: ComponentKind, component: unknown): HarnessScope {
  const value = (component ?? {}) as { harness?: unknown; models?: unknown };
  if (value.harness === 'claude' || value.harness === 'codex') return value.harness;
  if (kind === 'modelSets' && Array.isArray(value.models)) return modelSetScope({ models: value.models as string[] });
  return 'generic';
}

/** Whether something of this scope can be used with a login of `harness`. */
export const scopeFits = (scope: HarnessScope, harness: HarnessKind): boolean =>
  scope === 'generic' || scope === harness;

/** A layer's scope: a component's own, or a base profile's derived one (`mixed` when it is). */
function layerScope(
  catalogue: Catalogue,
  reference: LayerReferenceText,
  visiting: ReadonlySet<string>,
): HarnessScope | 'mixed' {
  const parsed = parseLayerReference(reference);
  if (parsed === undefined) return 'generic';
  if (parsed.kind === 'component') {
    const component = catalogue.components[parsed.componentKind][parsed.name];
    return component === undefined ? 'generic' : componentScope(parsed.componentKind, component);
  }
  const base = catalogue.profiles[parsed.name];
  if (base === undefined || visiting.has(parsed.name)) return 'generic';
  const scope = foldLayers(catalogue, base.layers, new Set([...visiting, parsed.name]));
  return scope.kind === 'mixed' ? 'mixed' : scope.scope;
}

function foldLayers(catalogue: Catalogue, layers: readonly string[], visiting: ReadonlySet<string>): ProfileScope {
  let claude: LayerReferenceText | undefined;
  let codex: LayerReferenceText | undefined;
  for (const text of layers) {
    const reference = text as LayerReferenceText;
    const scope = layerScope(catalogue, reference, visiting);
    if ((scope === 'claude' || scope === 'mixed') && claude === undefined) claude = reference;
    if ((scope === 'codex' || scope === 'mixed') && codex === undefined) codex = reference;
  }
  if (claude !== undefined && codex !== undefined) return { kind: 'mixed', claude, codex };
  if (claude !== undefined) return { kind: 'scoped', scope: 'claude' };
  if (codex !== undefined) return { kind: 'scoped', scope: 'codex' };
  return { kind: 'scoped', scope: 'generic' };
}

/**
 * The scope a profile with these layers would have, oldest first as written. `name` is the profile
 * they belong to, so a base that reaches back to it reads as the loop it is rather than recursing.
 */
export function layersScope(catalogue: Catalogue, layers: readonly string[], name?: string): ProfileScope {
  return foldLayers(catalogue, layers, new Set(name === undefined ? [] : [name]));
}

/** The derived scope of saved profile `name`; generic for a profile that does not exist. */
export function profileScope(catalogue: Catalogue, name: string): ProfileScope {
  return layersScope(catalogue, catalogue.profiles[name]?.layers ?? [], name);
}

/** "settings claude-settings", "profile agent". */
export function layerWords(text: string): string {
  const reference = parseLayerReference(text);
  if (reference === undefined) return text;
  return reference.kind === 'profile'
    ? `profile ${reference.name}`
    : `${COMPONENT_KIND_WORDS[reference.componentKind]} ${reference.name}`;
}

/**
 * The one sentence a mixed profile is refused or flagged with, naming the layers that disagree:
 * "Profile work can't be both Claude only and Codex only: settings claude-settings is Claude only
 * and settings codex-settings is Codex only." `name` is omitted for a profile not yet named.
 */
export function describeScopeConflict(conflict: Extract<ProfileScope, { kind: 'mixed' }>, name?: string): string {
  const subject = name === undefined ? 'A profile' : `Profile ${name}`;
  const reason =
    conflict.claude === conflict.codex
      ? `${layerWords(conflict.claude)} already mixes Claude only and Codex only layers`
      : `${layerWords(conflict.claude)} is Claude only and ${layerWords(conflict.codex)} is Codex only`;
  return `${subject} can't be both Claude only and Codex only: ${reason}.`;
}

/**
 * The profiles that are mixed in `next` but were not in `previous` — what a change made mixed, which
 * it must refuse. A profile that was already mixed (written before P7) is left to be read.
 */
export function newlyMixedProfiles(previous: Catalogue, next: Catalogue): readonly string[] {
  return Object.keys(next.profiles)
    .filter(name => profileScope(next, name).kind === 'mixed')
    .filter(name => previous.profiles[name] === undefined || profileScope(previous, name).kind !== 'mixed')
    .toSorted();
}

/** A runtime whose profile no longer fits its login's harness, and the scope that profile has now. */
export interface MisfitRuntime {
  readonly runtime: string;
  readonly profile: string;
  readonly harness: HarnessKind;
  readonly scope: HarnessKind;
}

/**
 * The runtimes whose profile fits their login's harness in `previous` but is the OTHER harness's only
 * in `next` — what narrowing a component or editing a base can do to a runtime nobody touched, which a
 * change must refuse. A runtime that already did not fit is left to its launch check.
 */
export function newlyMisfitRuntimes(
  previous: Pick<AccountModel, 'profiles' | 'components' | 'runtimes' | 'credentials'>,
  next: Pick<AccountModel, 'profiles' | 'components' | 'runtimes' | 'credentials'>,
): readonly MisfitRuntime[] {
  const fits = (model: typeof next, name: string): MisfitRuntime | undefined => {
    const runtime = model.runtimes[name];
    const harness = runtime === undefined ? undefined : model.credentials[runtime.credential]?.harness;
    if (runtime === undefined || harness === undefined) return undefined;
    const scope = profileScope(model, runtime.profile);
    if (scope.kind !== 'scoped' || scopeFits(scope.scope, harness)) return undefined;
    return { runtime: name, profile: runtime.profile, harness, scope: scope.scope as HarnessKind };
  };
  return Object.keys(next.runtimes)
    .toSorted()
    .flatMap(name => {
      const now = fits(next, name);
      return now === undefined || fits(previous, name) !== undefined ? [] : [now];
    });
}
