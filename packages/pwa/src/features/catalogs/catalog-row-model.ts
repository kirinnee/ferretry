/**
 * What a skill or MCP row says about catalogs, worked out from the two lists the machine already
 * answers: its own catalogs and the installs it recorded. Pure functions; the row only draws them.
 */

import {
  type CatalogInstall,
  type CatalogItemSource,
  type OwnedCatalog,
  type OwnedCatalogItem,
  type OwnedSharedItem,
  revealHidden,
} from '@ferretry/protocol';

/** One of this machine's catalogs that holds the row's item, and the item as that catalog lists it. */
export interface OwnedMatch {
  readonly catalog: OwnedCatalog;
  readonly item: OwnedCatalogItem;
}

const isPath = (value: string): boolean => value.includes('/') || value.includes('\\');

/**
 * The catalogs of this machine that hold the item a row points at, matched by source: the exact SKILL.md
 * path or the exact server id. A source that is only a skill's name (a list that does not know paths)
 * matches by name. A withdrawn item is not held any more.
 */
export function ownedMatches(catalogs: readonly OwnedCatalog[], source: CatalogItemSource): readonly OwnedMatch[] {
  const matches: OwnedMatch[] = [];
  for (const catalog of catalogs) {
    for (const item of catalog.items) {
      if (item.withdrawnAt !== undefined) continue;
      const held =
        source.kind === 'mcp'
          ? item.source.kind === 'mcp' && item.source.id === source.mcp
          : item.source.kind === 'skill' &&
            (isPath(source.skill) ? item.source.path === source.skill : item.name === source.skill);
      if (held) matches.push({ catalog, item });
    }
  }
  return matches;
}

/** The shared item that stands for this row: the one whose current version came from the same source. */
export function sharedItemFor(
  items: readonly OwnedSharedItem[],
  source: CatalogItemSource,
): OwnedSharedItem | undefined {
  const path = source.kind === 'skill' && isPath(source.skill);
  return items.find(item =>
    source.kind === 'mcp'
      ? item.source.kind === 'mcp' && item.source.id === source.mcp
      : item.source.kind === 'skill' && (path ? item.source.path === source.skill : item.name === source.skill),
  );
}

/** What Share does for this row, before anything is shown. */
export type SharePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly catalog: OwnedCatalog }
  | { readonly kind: 'many'; readonly catalogs: readonly OwnedCatalog[] };

export function sharePlan(matches: readonly OwnedMatch[]): SharePlan {
  const [first, ...rest] = matches;
  if (first === undefined) return { kind: 'none' };
  return rest.length === 0
    ? { kind: 'one', catalog: first.catalog }
    : { kind: 'many', catalogs: matches.map(match => match.catalog) };
}

/** The newest version any of this machine's catalogs holds for the item, or `null`. */
export function ownedVersion(matches: readonly OwnedMatch[]): number | null {
  let newest: number | null = null;
  for (const { item } of matches) {
    for (const entry of item.versions) if (newest === null || entry.version > newest) newest = entry.version;
  }
  return newest;
}

export interface RowChips {
  /** "v3": shown for an item in one of this machine's catalogs. `null` when no version is known. */
  readonly version: string | null;
  /** "from Ines · v2": shown for an item a catalog install wrote. `null` for the rest. */
  readonly from: { readonly text: string; readonly title: string } | null;
}

/** "v3" */
export const versionChip = (version: number): string => `v${version}`;

/**
 * The chips a row carries. An item a catalog install wrote shows where it came from and the version it
 * is pinned to; the rest show the version one of this machine's catalogs holds, when one does.
 */
export function rowChips(installs: readonly CatalogInstall[], matches: readonly OwnedMatch[]): RowChips {
  const [install] = installs;
  if (install !== undefined) {
    const publisher = revealHidden(install.provenance.publisherName);
    return {
      version: null,
      from: {
        text: `from ${publisher} · ${versionChip(install.provenance.version)}`,
        title: `From ${revealHidden(install.provenance.catalogName)} (${publisher}), pinned to version ${install.provenance.version}`,
      },
    };
  }
  const version = ownedVersion(matches);
  return { version: version === null ? null : versionChip(version), from: null };
}

/**
 * Add is for what this machine could share: not for what someone else's catalog wrote here, which this
 * machine does not own.
 */
export const canAdd = (installs: readonly CatalogInstall[]): boolean => installs.length === 0;

/** The ⋯ menu's label for Remove: bare for the usual one install, naming the catalog when there are several. */
export const removeLabel = (install: CatalogInstall, several: boolean): string =>
  several ? `Remove (from ${revealHidden(install.provenance.catalogName)})` : 'Remove';
