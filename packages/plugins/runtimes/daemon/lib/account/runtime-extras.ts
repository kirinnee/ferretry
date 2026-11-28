/**
 * What a harness adds to a runtime beyond the common launch, asked of the harness and never switched on a word in
 * `./materialise.ts`: the environment and the files only one harness's runtime has.
 *
 * Codex keeps its history in a SQLite home shared by every runtime on it, and lists the models of a login whose provider it
 * does not know from a catalog file Ferretry writes (docs/model-catalog.md); the Codex plugin's kit says both. Claude adds
 * nothing here.
 */
import type { KitExtras, RuntimesHarnessKit } from '../../../contract/harness-kit.ts';
import { byHarness, isKind } from '../harness-kind.ts';
import type { RuntimeModels } from '../models/runtime.ts';
import { joinPath } from '../paths.ts';
import type { SettingsObject } from '../settings.ts';
import { sharedHistoryPoolDirectory } from '../shared-history.ts';

/** The shared history pool's SQLite directory: where every Codex runtime keeps its state database. */
export const sqliteHomeOf = (fleetDirectory: string): string =>
  joinPath(sharedHistoryPoolDirectory(fleetDirectory, 'codex'), 'sqlite');

/** Whether runtimes of `harness` keep their state in {@link sqliteHomeOf}, so the directory has to exist. */
export const usesSqliteHome = (harness: string): boolean => isKind(harness, 'codex');

export interface RuntimeExtras {
  /** Variables the runtime's launch environment adds. */
  readonly env: Readonly<Record<string, string>>;
  /** The catalog file the runtime reads, when the login's models need one. */
  readonly catalog?: KitExtras['catalog'];
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
  kit?: RuntimesHarnessKit,
): RuntimeExtras {
  return byHarness<RuntimeExtras>(harness, {
    claude: () => ({ env: {} }),
    codex: () => {
      // No kit (the plugin is off): Codex's variables and files are never guessed. The caller has already refused the runtime
      // (`missingKitRefusal`) and plans nothing for it.
      if (kit?.runtimeExtras === undefined) return { env: {} };
      return kit.runtimeExtras({
        sqliteHome: input.sqliteHome,
        statePath: input.statePath,
        models: {
          ...(input.derived.catalog === undefined ? {} : { catalog: input.derived.catalog }),
          entries: input.derived.models,
          default: input.derived.default,
        },
        settings: input.settings,
      });
    },
  });
}
