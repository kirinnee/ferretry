/**
 * What a harness adds to a runtime beyond the common launch, asked of the harness and never switched on a word in
 * `./materialise.ts`: the environment and the files only one harness's runtime has.
 *
 * Codex keeps its history in a SQLite home shared by every runtime on it, and lists the models of a login whose provider it
 * does not know from a catalog file Ferretry writes (docs/model-catalog.md); the Codex plugin's kit says both. Claude adds
 * nothing here.
 */
import type { KitExtras, RuntimesHarnessKit } from '../../../contract/harness-kit.ts';
import { type HarnessKind, kindOf } from '../harness-kind.ts';
import type { RuntimeModels } from '../models/runtime.ts';
import { joinPath } from '../paths.ts';
import type { SettingsObject } from '../settings.ts';
import { sharedHistoryPoolDirectory } from '../shared-history.ts';

/** The shared history pool's SQLite directory: where every runtime of `kind` that keeps a state database keeps it. */
export const sqliteHomeOf = (fleetDirectory: string, kind: HarnessKind): string =>
  joinPath(sharedHistoryPoolDirectory(fleetDirectory, kind), 'sqlite');

/** Whether runtimes of `kind` keep their state in {@link sqliteHomeOf}, so the directory has to exist: its kit says so. */
export const usesSqliteHome = (
  kind: HarnessKind,
  kits: ReadonlyMap<HarnessKind, RuntimesHarnessKit> | undefined,
): boolean => kits?.get(kind)?.keepsSharedState === true;

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
  kindOf(harness);
  // No kit, or a kit that adds nothing: nothing is guessed. A missing kit has already refused the runtime (`missingKitRefusal`).
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
}
