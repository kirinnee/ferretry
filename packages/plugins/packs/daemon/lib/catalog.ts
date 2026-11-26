/**
 * The model catalogs as Packs reads them. Logins owns the catalogs and Packs may not import its contract (§2.4), so
 * this is the narrow structural type Packs needs: Logins' `ModelCatalogView` is assignable to it.
 */
export interface ModelCatalogEntryView {
  /** The value a CLI is handed. */
  readonly id: string;
  readonly label: string;
  readonly tier: 'best' | 'balanced' | 'fast';
  readonly context?: number | undefined;
  readonly efforts: readonly string[];
}

export interface ModelCatalogView {
  readonly id: string;
  readonly label: string;
  /** The entries for Claude Code. */
  readonly claude?: readonly ModelCatalogEntryView[] | undefined;
  readonly codex?: readonly ModelCatalogEntryView[] | undefined;
}

/**
 * One harness's models in a catalog, by the harness's catalog half word (`harnessWords(key).catalogHalf`: `claude`,
 * `codex`, and a third harness's own). A half the catalog does not carry is `undefined`, never another harness's list.
 */
export function halfOf(catalog: ModelCatalogView, half: string): readonly ModelCatalogEntryView[] | undefined {
  const entries: unknown = Object.hasOwn(catalog, half) ? Reflect.get(catalog, half) : undefined;
  return Array.isArray(entries) ? (entries as readonly ModelCatalogEntryView[]) : undefined;
}
