/**
 * Where each harness expects a profile's assets to land inside the home it owns.
 *
 * This is the whole per-harness knowledge base: one table, consulted once, by the plan builder.
 * Nothing else infers a destination, and nothing reads a generated file back to discover one.
 *
 * The tool this replaces silently dropped any asset its per-harness table had no destination for —
 * a Claude profile could declare `hooks:` and get no hooks, with no error. Here a field with no
 * destination for a harness is a *declared* absence ({@link harnessAsset} returns `undefined`) rather
 * than an absent file nobody notices.
 */
import type { HarnessKind } from './manifest.ts';
import type { SettingsFormat } from './settings.ts';

/** The profile fields that name an asset on disk. `settings` is layered; the rest are paths. */
export const ASSET_FIELDS = ['settings', 'memory', 'skills', 'hooks', 'hooksDir', 'mcp'] as const;
export type AssetField = (typeof ASSET_FIELDS)[number];

/**
 * Entries inside a harness's skills destination that the HARNESS writes and Ferretry must never
 * remove, replace or claim as an item.
 *
 * Measured on Codex 0.145.0: the first start writes Codex's bundled skills into
 * `$CODEX_HOME/skills/.system/`. A sweep that keeps only the selected items would delete it on every
 * apply, and an item of that name would replace it. Claude writes nothing there.
 */
export const HARNESS_OWNED_SKILL_ENTRIES: Readonly<Record<HarnessKind, readonly string[]>> = {
  claude: [],
  codex: ['.system'],
};

/** Whether `entry`, directly inside `kind`'s skills destination, belongs to the harness itself. */
export function isHarnessOwnedSkillEntry(kind: HarnessKind, entry: string): boolean {
  return HARNESS_OWNED_SKILL_ENTRIES[kind].includes(entry);
}

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

const CLAUDE_ASSETS: readonly HarnessAsset[] = [
  // Claude rewrites settings.json at runtime (`/effort` persists there), and a stack of layers has no
  // single source to point at, so this one is composed and written rather than linked.
  { field: 'settings', dest: 'settings.json', materialization: 'generated', format: 'json' },
  { field: 'memory', dest: 'CLAUDE.md', materialization: 'link' },
  { field: 'skills', dest: 'skills', materialization: 'link' },
  { field: 'mcp', dest: '.mcp.json', materialization: 'link' },
];

const CODEX_ASSETS: readonly HarnessAsset[] = [
  // Codex likewise rewrites config.toml, so its settings are composed rather than linked.
  { field: 'settings', dest: 'config.toml', materialization: 'generated', format: 'toml' },
  { field: 'memory', dest: 'AGENTS.md', materialization: 'link' },
  { field: 'hooks', dest: 'hooks.json', materialization: 'link' },
  { field: 'hooksDir', dest: 'hooks', materialization: 'link' },
  { field: 'skills', dest: 'skills', materialization: 'link' },
];

/** Every harness's destinations. Injected rather than imported, so a caller can substitute one. */
export type HarnessAssetTable = Readonly<Record<HarnessKind, readonly HarnessAsset[]>>;

export const HARNESS_ASSETS: HarnessAssetTable = {
  claude: CLAUDE_ASSETS,
  codex: CODEX_ASSETS,
};

/** The asset entry for one field, or `undefined` when this harness has no destination for it. */
export function harnessAsset(table: HarnessAssetTable, kind: HarnessKind, field: AssetField): HarnessAsset | undefined {
  return table[kind].find(asset => asset.field === field);
}
