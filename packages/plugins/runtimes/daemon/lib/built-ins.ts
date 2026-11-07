/**
 * THIS BUILD'S MODEL CATALOGS AND PROVIDER PRESETS, CHECKED WHEN IT IS BUILT — never at boot.
 *
 * Both are YAML files this package ships, so what they parse to is fixed the moment the build is. The
 * daemon used to parse every one of them when it was constructed, in two synchronous calls: on CI's
 * owner-scale boot that was 134 ms for the model catalogs and 100 ms for the presets, back to back, and
 * the boot-stalls budget failed at 235 ms inside the `yaml` parser.
 *
 * So these are Bun MACROS: imported `with { type: 'macro' }`, each runs when the importing module is
 * transpiled — by `bun build --compile` for a release, and by `bun run` / `bun test` from source — and
 * its value is inlined as a literal. A shipped file that does not parse is a build error, not a daemon
 * that cannot start. Callers that import these plainly get the same values, parsed when called.
 */
import { builtInModelCatalogs } from './models/catalog.ts';
import type { ModelCatalog } from './models/schema.ts';
import { builtInPresets } from './presets/catalog.ts';
import type { ProviderPreset } from './presets/schema.ts';

export function checkedBuiltInModelCatalogs(): Readonly<Record<string, ModelCatalog>> {
  return builtInModelCatalogs();
}

export function checkedBuiltInPresets(): readonly ProviderPreset[] {
  return builtInPresets();
}
