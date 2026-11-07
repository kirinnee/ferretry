/**
 * THIS BUILD'S MODEL CATALOGS AND ENDPOINT PRESETS, CHECKED WHEN IT IS BUILT — never at boot.
 *
 * Both are YAML files this package ships (`data/models/*.yaml`, `data/endpoints/*.yaml`), so what they parse to is
 * fixed the moment the build is. Parsing every one of them when the plugin is constructed cost a measurable share of
 * the daemon's boot, so these are Bun MACROS: imported `with { type: 'macro' }`, each runs when the importing module
 * is transpiled and its value is inlined as a literal. A shipped file that does not parse is a build error, not a
 * daemon that cannot start. Callers that import these plainly get the same values, parsed when called.
 */
import { builtInModelCatalogs } from './catalog/catalog.ts';
import type { ModelCatalog } from './catalog/schema.ts';
import { builtInPresets } from './presets/catalog.ts';
import type { ProviderPreset } from './presets/schema.ts';

export function checkedBuiltInModelCatalogs(): Readonly<Record<string, ModelCatalog>> {
  return builtInModelCatalogs();
}

export function checkedBuiltInPresets(): readonly ProviderPreset[] {
  return builtInPresets();
}
