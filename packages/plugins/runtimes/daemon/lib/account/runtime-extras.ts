/**
 * What a harness adds to a runtime beyond the common launch, asked of the harness and never switched on a word in
 * `./materialise.ts`: the environment and the files only one harness's runtime has.
 *
 * Codex keeps its history in a SQLite home shared by every runtime on it, and lists the models of a login whose provider it
 * does not know from a catalog file Ferretry writes (docs/model-catalog.md). Claude adds nothing here.
 */
import { byHarness, isKind } from '../harness-kind.ts';
import {
  CODEX_MODEL_CATALOG_FILE,
  codexCatalogArguments,
  codexCatalogModels,
  renderCodexModelCatalog,
} from '../models/codex-catalog.ts';
import type { RuntimeModels } from '../models/runtime.ts';
import { joinPath } from '../paths.ts';
import type { SettingsObject } from '../settings.ts';
import { sharedHistoryPoolDirectory } from '../shared-history.ts';

/** The shared history pool's SQLite directory: where every Codex runtime keeps its state database. */
export const sqliteHomeOf = (fleetDirectory: string): string =>
  joinPath(sharedHistoryPoolDirectory(fleetDirectory, 'codex'), 'sqlite');

/** Whether runtimes of `harness` keep their state in {@link sqliteHomeOf}, so the directory has to exist. */
export const usesSqliteHome = (harness: string): boolean => isKind(harness, 'codex');

/** The model catalog file one runtime is launched with. */
interface RuntimeCatalogFile {
  readonly text: string;
  /** The path the launch flag names. */
  readonly path: string;
  readonly args: readonly string[];
}

export interface RuntimeExtras {
  /** Variables the runtime's launch environment adds. */
  readonly env: Readonly<Record<string, string>>;
  /** The catalog file the runtime reads, when the login's models need one. */
  readonly catalog?: RuntimeCatalogFile;
}

/**
 * `harness`'s extras for the runtime at `statePath`. A person's own `model_catalog_json` is theirs, and stands: it
 * leaves the catalog out.
 */
export function runtimeExtras(
  harness: string,
  input: {
    readonly sqliteHome: string;
    /** The runtime's own state directory under its home. */
    readonly statePath: string;
    readonly derived: RuntimeModels;
    readonly settings: SettingsObject;
  },
): RuntimeExtras {
  return byHarness<RuntimeExtras>(harness, {
    claude: () => ({ env: {} }),
    codex: () => {
      const models = codexCatalogModels(input.derived);
      if (models === undefined || 'model_catalog_json' in input.settings)
        return { env: { CODEX_SQLITE_HOME: input.sqliteHome } };
      const path = joinPath(input.statePath, CODEX_MODEL_CATALOG_FILE);
      return {
        env: { CODEX_SQLITE_HOME: input.sqliteHome },
        catalog: {
          text: renderCodexModelCatalog(models, input.derived.default),
          path,
          args: codexCatalogArguments(path),
        },
      };
    },
  });
}
