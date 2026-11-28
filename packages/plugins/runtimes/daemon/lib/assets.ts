/**
 * Where each harness expects a profile's assets to land inside the home it owns.
 *
 * Each harness's plugin says so (`kit.settingsFile`, `kit.importSetup.instructionsName` and `kit.assets`): this is consulted once,
 * by the plan builder. Nothing else infers a destination, and nothing reads a generated file back to discover one.
 *
 * The tool this replaces silently dropped any asset its per-harness table had no destination for —
 * a Claude profile could declare `hooks:` and get no hooks, with no error. Here a field with no
 * destination for a harness is a *declared* absence ({@link harnessAsset} returns `undefined`) rather
 * than an absent file nobody notices.
 */
import type { RuntimesHarnessKit } from '../../contract/harness-kit.ts';
import type { SettingsFormat } from './settings.ts';

/** The profile fields that name an asset on disk. `settings` is layered; the rest are paths. */
export const ASSET_FIELDS = ['settings', 'memory', 'skills', 'hooks', 'hooksDir', 'mcp'] as const;
export type AssetField = (typeof ASSET_FIELDS)[number];

/**
 * The entries a harness keeps for itself in its skills destination: its plugin's word (`kit.ownedSkillEntries`; Claude writes
 * none, Codex's is `.system`). A plugin that gives none reserves nothing; a runtime planned from such a kit is refused first
 * (`runtimeKitRefusal`), so Codex's `.system` is never left unreserved.
 */
export const ownedSkillEntriesOf = (
  kit: Pick<RuntimesHarnessKit, 'ownedSkillEntries'> | undefined,
): readonly string[] => kit?.ownedSkillEntries ?? [];

/** Whether a derived item name is a single path component that can safely be a destination. */
export function isUsableSkillItemName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/');
}

/**
 * How one asset field's value actually reaches an account's home.
 *
 * The three answers are not three implementations of one idea; they are three different promises, and
 * which one is in play is the thing a person has to be told:
 *
 * - **`link`** — the destination IS the source. One inode, so an edit to the shared document is
 *   already every account's: nothing has to be re-applied, and there is no second copy to drift.
 *   This is what "shared" means when somebody says they want two accounts to have the same file.
 * - **`copy`** — the destination holds the source's bytes as of the last apply. Reserved for a source
 *   the fleet may not link to at all, which is a source outside its own asset tree
 *   (a path outside the asset tree); an edit reaches the account on the next apply and not before.
 * - **`generated`** — the destination is composed from a STACK of layers merged in memory and written
 *   as one file. A merge of N sources cannot be a link to any of them. `settings` is the only such
 *   field, and it has to be a real file for a second reason: each harness rewrites its own settings at
 *   runtime (`/effort` persists into Claude's `settings.json`), so the destination is also an input.
 *
 * Two of these overwrite what is at the destination on every apply, and one of them does not, which is
 * why the vocabulary exists rather than a boolean. A person editing a *generated* file loses the edit;
 * a person editing a *linked* one is editing the shared document and every account with it.
 */
type AssetMaterialization = 'link' | 'copy' | 'generated';

/**
 * One harness's destination for one asset field.
 *
 * `materialization` is the field's own ceiling rather than the final answer: a `link` entry still
 * becomes a copy for a source the fleet may not link to. The plan builder resolves that per operation.
 */
export interface HarnessAsset {
  readonly field: AssetField;
  /**
   * Destination name inside the account's home. For `skills` this names the *container*: a selection
   * materializes one entry per selected item beneath it, at `<dest>/<item>`, rather than replacing it
   * with one source tree.
   */
  readonly dest: string;
  readonly materialization: AssetMaterialization;
  /** Set only for the layered settings field; names the format its layers merge into. */
  readonly format?: SettingsFormat;
}

/** What a harness's destinations are read from: its settings file and instructions file (always), and its own assets. */
export type AssetsKit = Pick<RuntimesHarnessKit, 'settingsFile' | 'importSetup' | 'assets'>;

/**
 * Every destination of a harness. The three every harness has come from what its plugin already says: the settings document
 * (composed and written, since each harness rewrites its own settings at runtime and a stack of layers has no single source to
 * point at), the instructions file (linked) and the `skills` folder (linked); the plugin's `assets` add what is only its own.
 */
export function assetsOf(kit: AssetsKit | undefined): readonly HarnessAsset[] {
  const settings = kit?.settingsFile;
  const memory = kit?.importSetup?.instructionsName;
  return [
    ...(settings === undefined
      ? []
      : [{ field: 'settings', dest: settings.file, materialization: 'generated', format: settings.format } as const]),
    ...(memory === undefined ? [] : [{ field: 'memory', dest: memory, materialization: 'link' } as const]),
    { field: 'skills', dest: 'skills', materialization: 'link' } as const,
    ...(kit?.assets ?? []),
  ];
}

/** The asset entry for one field, or `undefined` when this harness has no destination for it. */
export function harnessAsset(kit: AssetsKit | undefined, field: AssetField): HarnessAsset | undefined {
  return assetsOf(kit).find(asset => asset.field === field);
}
