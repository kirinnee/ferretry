import type { OwnedCatalog, OwnedCatalogItem } from '@ferretry/protocol';

const lower = (value: string): string => value.toLowerCase();

/**
 * One entry from a list by id, then by exact name, then by name ignoring case.
 *
 * A name matching more than one entry is refused with the ids, rather than the first being picked: the
 * commands that use this withdraw and delete.
 */
export function pick<T extends { readonly name: string }>(
  entries: readonly T[],
  idOf: (entry: T) => string,
  wanted: string,
  noun: string,
): T {
  const reference = wanted.trim();
  if (reference === '') throw new Error(`a ${noun} id or name is required`);
  const byId = entries.find(entry => idOf(entry) === reference);
  if (byId !== undefined) return byId;
  for (const same of [(entry: T) => entry.name === reference, (entry: T) => lower(entry.name) === lower(reference)]) {
    const matches = entries.filter(same);
    if (matches.length === 1) return matches[0] as T;
    if (matches.length > 1) {
      throw new Error(
        `more than one ${noun} is called ${JSON.stringify(reference)} — use its id: ${matches.map(idOf).join(', ')}`,
      );
    }
  }
  throw new Error(`no ${noun} ${JSON.stringify(reference)}`);
}

export function resolveCatalog(catalogs: readonly OwnedCatalog[], wanted: string): OwnedCatalog {
  return pick(catalogs, catalog => catalog.id, wanted, 'catalog');
}

/** A live item by id or name; a withdrawn item only by its id, so a name never reaches back to one. */
export function resolveItem(catalog: OwnedCatalog, wanted: string): OwnedCatalogItem {
  const live = catalog.items.filter(item => item.withdrawnAt === undefined);
  const withdrawn = catalog.items.find(item => item.withdrawnAt !== undefined && item.itemId === wanted.trim());
  return withdrawn ?? pick(live, item => item.itemId, wanted, `item in ${catalog.name}`);
}

/** `My Team's Skills!` → `my-team-s-skills`: a file name that needs no quoting. */
export function catalogFileSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '');
  return slug === '' ? 'catalog' : slug;
}
