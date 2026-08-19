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
import { canonicalAssetReference } from './paths.ts';
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
 * How one asset field is materialized.
 *
 * `link` is available to plans outside an account home. Generated account homes always use `copy`:
 * their parent is the Ferretry state home, whose filesystem invariant rejects symlink components.
 * A copy also survives moving its source and changes only on the next explicit fleet apply.
 */
export interface HarnessAsset {
  readonly field: AssetField;
  /**
   * Destination name inside the account's home. For `skills` this names the *container*: a selection
   * materializes one entry per selected item beneath it, at `<dest>/<item>`, rather than replacing it
   * with one source tree.
   */
  readonly dest: string;
  readonly mode: 'link' | 'copy';
  /** Set only for the layered settings field; names the format its layers merge into. */
  readonly format?: SettingsFormat;
}

const CLAUDE_ASSETS: readonly HarnessAsset[] = [
  // Claude rewrites settings.json at runtime (`/effort` persists there), so it must be a real file.
  { field: 'settings', dest: 'settings.json', mode: 'copy', format: 'json' },
  { field: 'memory', dest: 'CLAUDE.md', mode: 'copy' },
  { field: 'skills', dest: 'skills', mode: 'copy' },
  { field: 'mcp', dest: '.mcp.json', mode: 'copy' },
];

const CODEX_ASSETS: readonly HarnessAsset[] = [
  // Codex likewise rewrites config.toml, so this is a copy rather than a link.
  { field: 'settings', dest: 'config.toml', mode: 'copy', format: 'toml' },
  { field: 'memory', dest: 'AGENTS.md', mode: 'copy' },
  { field: 'hooks', dest: 'hooks.json', mode: 'copy' },
  { field: 'hooksDir', dest: 'hooks', mode: 'copy' },
  { field: 'skills', dest: 'skills', mode: 'copy' },
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
