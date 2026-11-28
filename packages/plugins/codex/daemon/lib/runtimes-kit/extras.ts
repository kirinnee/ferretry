import { join } from 'node:path';
import type { KitExtras, KitExtrasInput, RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';
import {
  CODEX_CATALOG_FORMAT,
  CODEX_MODEL_CATALOG_FILE,
  codexCatalogArguments,
  codexCatalogModels,
  renderCodexModelCatalog,
} from './model-catalog.ts';

/**
 * What only a Codex runtime has: the shared history database every Codex runtime keeps its state in, and a catalog of the
 * login's own models when Codex does not know them. A person's own `model_catalog_json` is theirs, and stands: it leaves the
 * catalog out.
 */
function runtimeExtras(input: KitExtrasInput): KitExtras {
  const env = { CODEX_SQLITE_HOME: input.sqliteHome };
  const models = codexCatalogModels(input.models);
  if (models === undefined || 'model_catalog_json' in input.settings) return { env };
  const path = join(input.statePath, CODEX_MODEL_CATALOG_FILE);
  return {
    env,
    catalog: {
      file: CODEX_MODEL_CATALOG_FILE,
      path,
      text: renderCodexModelCatalog(models, input.models.default),
      args: codexCatalogArguments(path),
      format: CODEX_CATALOG_FORMAT,
    },
  };
}

/** Codex's runtime extras: its history database and its model catalog file. */
export const codexExtrasKit: RuntimesHarnessKit = { runtimeExtras };
