/**
 * Where each harness expects a profile's assets to land inside the home it owns.
 *
 * This is the whole per-harness knowledge base: one table, consulted once, by the plan builder.
 * Nothing else infers a destination, and nothing reads a generated file back to discover one.
 *
 * The tool this replaces silently dropped any asset its per-harness table had no destination for —
 * a Claude profile could declare `hooks:` and get no hooks, with no error. Here the table is
 * exhaustive over the profile's asset fields, so a missing destination is a *declared* refusal
 * ({@link unsupportedAssetFields}) rather than an absent file nobody notices.
 */
import type { HarnessKind } from './manifest.ts';
import { canonicalAssetReference, isAssetTreeReference } from './paths.ts';
import type { SettingsFormat } from './settings.ts';

/** The profile fields that name an asset on disk. `settings` is layered; the rest are paths. */
export const ASSET_FIELDS = ['settings', 'memory', 'skills', 'hooks', 'hooksDir', 'mcp'] as const;
export type AssetField = (typeof ASSET_FIELDS)[number];

/** What kind of thing an asset field names in the asset tree. */
export type AssetShape = 'file' | 'directory';

/**
 * The name one selected skill item takes inside the harness's skills destination.
 *
 * The reference's last segment, canonicalized first, so `./skills/review` and `skills/review` claim
 * one destination rather than two. Derived here, once, because the plan builder *writes* that
 * destination and the sharing report *names* it: two derivations would eventually disagree about which
 * item an account is holding, and the disagreement would be invisible until an apply put the wrong
 * tree in a home.
 *
 * Returns the canonical reference itself when nothing segment-shaped remains — a reference like `.`
 * names no item, and the plan builder refuses it rather than composing `<home>/skills/.` and
 * replacing the whole directory.
 */
export function skillItemName(reference: string): string {
  const canonical = canonicalAssetReference(reference);
  const segments = canonical.split('/').filter(segment => segment !== '' && segment !== '.');
  return segments.at(-1) ?? canonical;
}

/** Whether a derived item name is a single path component that can safely be a destination. */
export function isUsableSkillItemName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/');
}

/**
 * Whether each field names one file or a whole directory, independent of harness.
 *
 * The shape is a property of the field rather than of the harness that receives it: a `skills` item is
 * a directory wherever it lands. It is declared here, beside the destinations, because the two facts
 * are read together — and it is the fact that decides whether a shared asset can be privately
 * materialized through the reviewed text-document path, which writes files and only files.
 *
 * Annotated rather than `satisfies`-checked: a `Record<AssetField, …>` annotation is what makes a
 * newly added asset field a compile error here instead of an absent entry nobody notices.
 */
export const ASSET_FIELD_SHAPES: Readonly<Record<AssetField, AssetShape>> = {
  settings: 'file',
  memory: 'file',
  skills: 'directory',
  hooks: 'file',
  hooksDir: 'directory',
  mcp: 'file',
};

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
 *   ({@link isAssetTreeReference}); an edit reaches the account on the next apply and not before.
 * - **`generated`** — the destination is composed from a STACK of layers merged in memory and written
 *   as one file. A merge of N sources cannot be a link to any of them. `settings` is the only such
 *   field, and it has to be a real file for a second reason: each harness rewrites its own settings at
 *   runtime (`/effort` persists into Claude's `settings.json`), so the destination is also an input.
 *
 * Two of these overwrite what is at the destination on every apply, and one of them does not, which is
 * why the vocabulary exists rather than a boolean. A person editing a *generated* file loses the edit;
 * a person editing a *linked* one is editing the shared document and every account with it.
 */
export type AssetMaterialization = 'link' | 'copy' | 'generated';

/**
 * One harness's destination for one asset field.
 *
 * `materialization` is the field's own ceiling rather than the final answer: a `link` entry still
 * becomes a copy for a source the fleet may not link to. The plan builder resolves that per operation
 * — see {@link resolveAssetMaterialization}, which the sharing report reads too, so what a person is
 * told and what the apply does come from one function.
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

/** Asset fields this harness has no destination for, in declaration order. */
export function unsupportedAssetFields(table: HarnessAssetTable, kind: HarnessKind): readonly AssetField[] {
  const supported = new Set(table[kind].map(asset => asset.field));
  return ASSET_FIELDS.filter(field => !supported.has(field));
}

/** The asset entry for one field, or `undefined` when this harness has no destination for it. */
export function harnessAsset(table: HarnessAssetTable, kind: HarnessKind, field: AssetField): HarnessAsset | undefined {
  return table[kind].find(asset => asset.field === field);
}

/**
 * How one reference for one field will actually reach one harness's home.
 *
 * `undefined` means nothing will: this harness has no destination for the field, which is the same set
 * of fields a sharing report leaves out of `linkable`. Saying `copy` there would be a sentence about a
 * write that never happens.
 *
 * The one downgrade is `link` → `copy` for a source the fleet may not link to. It is decided from the
 * REFERENCE rather than from an expanded path, so the answer is the same on a host and in a pure
 * report, and a surface can never promise a live link that the apply then turns into a copy.
 */
export function resolveAssetMaterialization(
  table: HarnessAssetTable,
  kind: HarnessKind,
  field: AssetField,
  reference: string,
): AssetMaterialization | undefined {
  const asset = harnessAsset(table, kind, field);
  if (asset === undefined) return undefined;
  return asset.materialization === 'link' && !isAssetTreeReference(reference) ? 'copy' : asset.materialization;
}
