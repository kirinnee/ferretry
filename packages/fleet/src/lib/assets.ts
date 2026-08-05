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
import type { SettingsFormat } from './settings.ts';

/** The profile fields that name an asset on disk. `settings` is layered; the rest are paths. */
export const ASSET_FIELDS = ['settings', 'memory', 'skills', 'hooks', 'hooksDir', 'mcp'] as const;
export type AssetField = (typeof ASSET_FIELDS)[number];

/**
 * How one asset field is materialized.
 *
 * `link` is available to plans outside an account home. Generated account homes always use `copy`:
 * their parent is the Ferretry state home, whose filesystem invariant rejects symlink components.
 * A copy also survives moving its source and changes only on the next explicit fleet apply.
 */
export interface HarnessAsset {
  readonly field: AssetField;
  /** Destination name inside the account's home. */
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
