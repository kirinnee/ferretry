/**
 * The ONE mapper from a published runtime (`RuntimeView`) to the contract's `RuntimeModelCatalog`: what `runtime.start`'s
 * `catalog?` answers a move, a handover or a live model switch ("what models does this runtime serve?"). One spelling of
 * it, so no reader keeps its own.
 *
 * - SERVABLE only: a model the login cannot use (`available: false`) is not offered, and its reason is not carried.
 * - The window of every choice is the launch gate's own (`launchContextWindow`: a `[1m]` selector states 1M, else the
 *   catalog's declared `context`, else v4's 200k), so a planner compares the window a launch would use.
 * - `isDefault` marks the model the runtime launches with, when that model is servable.
 * - VALUES-FREE (docs/secrets.md): only model ids, labels, tiers, efforts, windows and the model catalog's own id, label
 *   and `customIds`. Never the credential, the profile, the wrapper, a path, a note or an environment value.
 *
 * A login that reads a model catalog (`models`) wins over the profile's model set (`modelSet`), as the view says. A
 * runtime on the harness's own default names no model, so it offers none; a reader then says the catalog is unavailable.
 */
import type { RuntimeModelCatalog, RuntimeModelChoice as CatalogChoice } from '@ferretry/core-ferrets/contract';
import type { RuntimeView } from '../../contract/wire/index.ts';
import { harnessKindOfKey } from './manifest.ts';
import { launchContextWindow, type ModelWindows } from './launch-compact-at.ts';

/** One servable model before its window is settled: the pieces both sources (a catalog, a model set) have in common. */
type Servable = Omit<CatalogChoice, 'value' | 'label' | 'context' | 'isDefault'> & {
  readonly id: string;
  readonly label: string;
  readonly context?: number;
};

function servable(view: RuntimeView): { readonly models: readonly Servable[]; readonly default?: string } {
  if (view.models !== undefined)
    return {
      models: view.models.choices
        .filter(entry => entry.available)
        .map(entry => ({
          id: entry.id,
          label: entry.label,
          ...(entry.tier === undefined ? {} : { tier: entry.tier }),
          ...(entry.context === undefined ? {} : { context: entry.context }),
          reasoningEfforts: entry.efforts.map(value => ({ value })),
          ...(entry.defaultEffort === undefined ? {} : { defaultReasoningEffort: entry.defaultEffort }),
          ...(entry.fast === undefined ? {} : { fast: entry.fast }),
        })),
      ...(view.models.default === undefined ? {} : { default: view.models.default }),
    };
  if (view.modelSet.source === 'model-set')
    return {
      models: view.modelSet.models
        .filter(entry => entry.available)
        .map(entry => ({ id: entry.id, label: entry.id, reasoningEfforts: [] })),
      ...(view.modelSet.default === undefined ? {} : { default: view.modelSet.default }),
    };
  return { models: [] };
}

/** What `view` serves, as the one {@link RuntimeModelCatalog} every reader plans against. Pure. */
export function runtimeModelCatalog(view: RuntimeView): RuntimeModelCatalog {
  const { models, default: launchDefault } = servable(view);
  const windows: ModelWindows = {
    ...(launchDefault === undefined ? {} : { defaultModel: launchDefault }),
    models: models.map(entry => ({ id: entry.id, ...(entry.context === undefined ? {} : { context: entry.context }) })),
  };
  const catalog = view.models?.catalog;
  return {
    harness: harnessKindOfKey(view.harness),
    source: 'wrapper-inventory',
    choices: models.map(({ id, label, ...rest }) => ({
      ...rest,
      value: id,
      label,
      context: launchContextWindow(id, windows),
      ...(id === launchDefault ? { isDefault: true as const } : {}),
    })),
    ...(catalog === undefined
      ? {}
      : { catalog: { id: catalog.id, label: catalog.label, customIds: catalog.customIds } }),
  };
}
