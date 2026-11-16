/**
 * THIS BUILD'S MODEL CATALOGS AND ENDPOINT PRESETS, PARSED WHEN THEY ARE WRITTEN — never at boot.
 *
 * Both are YAML files this package ships (`data/models/*.yaml`, `data/endpoints/*.yaml`), so what they parse to is
 * fixed the moment they are written. Parsing every one of them when the plugin is constructed cost a measurable share
 * of the daemon's boot, so the parsed values are kept in `built-ins.json`, written by `scripts/built-ins.ts`, and
 * imported as data. `tests/unit/models/built-ins.test.ts` (and that script's `--check`) fails when the file is not what
 * the shipped YAML parses to now, so a shipped file that does not parse, or a catalog changed without regenerating, is
 * a failed test, not a daemon that cannot start or one that serves stale models.
 *
 * These were Bun macros (`with { type: 'macro' }`) and must not be again: Bun transpiles any module it loads while
 * running a macro with macros switched off, silently DROPPING a nested macro import and leaving its call, and writes
 * that output to the shared runtime transpiler cache under a key that ignores the macro mode. Every later run of the
 * same source on the machine then threw "checkedBuiltInPresets is not defined". `scripts/validate/no-macros.ts` refuses
 * a macro import anywhere in the workspace.
 */
import type { ModelCatalog } from './catalog/schema.ts';
import type { ProviderPreset } from './presets/schema.ts';
import shipped from './built-ins.json' with { type: 'json' };

/** What `built-ins.json` holds: every built-in model catalog by id, and every built-in preset in catalogue order. */
export interface BuiltIns {
  readonly models: Readonly<Record<string, ModelCatalog>>;
  readonly presets: readonly ProviderPreset[];
}

// The JSON's inferred type is its literal shape; the freshness test proves it equals the typed parse.
const written = shipped as unknown as BuiltIns;

/** This build's model catalogs, as `built-ins.json` holds them: no YAML is parsed. */
export function checkedBuiltInModelCatalogs(): Readonly<Record<string, ModelCatalog>> {
  return written.models;
}

/** This build's provider presets, as `built-ins.json` holds them: no YAML is parsed. */
export function checkedBuiltInPresets(): readonly ProviderPreset[] {
  return written.presets;
}
