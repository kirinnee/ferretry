import type {
  CatalogItemPreview,
  OwnedCatalog,
  OwnedCatalogItem,
  OwnedCatalogList,
  PublishedCatalogItem,
  WithdrawnCatalogItem,
} from '@ferretry/protocol';

const INDENT = '  ';

const plural = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

const block = (text: string, indent: string): string =>
  text
    .split('\n')
    .map(line => (line === '' ? '' : `${indent}${line}`))
    .join('\n');

/** The sentence for a source that moved on, or is gone: what `ls` says so the owner knows to publish. */
function sourceMark(item: OwnedCatalogItem): string {
  switch (item.sourceState) {
    case 'unchanged':
      return '';
    case 'changed':
      return ' · source changed since this version — publish to update';
    case 'unavailable':
      return ` · source unavailable${item.sourceNote === undefined ? '' : `: ${item.sourceNote}`}`;
    case 'withdrawn':
      return ` · withdrawn${item.withdrawnAt === undefined ? '' : ` ${item.withdrawnAt}`}`;
  }
}

function renderItem(item: OwnedCatalogItem): string {
  const latest = item.versions.at(-1);
  const version = latest === undefined ? '' : ` v${latest.version}`;
  return [
    `${INDENT}${item.kind} ${item.name}${version} (${item.itemId})${sourceMark(item)}`,
    `${INDENT}${INDENT}${item.summary}`,
  ].join('\n');
}

function renderCatalogBlock(catalog: OwnedCatalog): string {
  const live = catalog.items.filter(item => item.withdrawnAt === undefined).length;
  const head = `${catalog.name} (${catalog.id}) · revision ${catalog.revision} · ${plural(live, 'item')} · ${catalog.visibility}`;
  const description = catalog.description === '' ? [] : [`${INDENT}${catalog.description}`];
  return [head, ...description, ...catalog.items.map(renderItem)].join('\n');
}

/** Every catalog on this machine, with its items and the ones whose source changed. */
export function renderCatalogList(list: OwnedCatalogList): string {
  if (list.catalogs.length === 0) return 'No catalogs yet. Make one with: fy catalog create <name>';
  return list.catalogs.map(renderCatalogBlock).join('\n\n');
}

export function renderCatalogCreated(catalog: OwnedCatalog): string {
  return `Created catalog ${catalog.name} (${catalog.id}).`;
}

export function renderCatalogUpdated(catalog: OwnedCatalog): string {
  return `Catalog ${catalog.name} (${catalog.id}) is now at revision ${catalog.revision}.`;
}

export function renderCatalogDeleted(name: string, catalogId: string): string {
  return `Deleted catalog ${name} (${catalogId}).`;
}

/**
 * What an installer would see of the frozen candidate — every file and every command in full, never a
 * count — then the warnings and anything left out, then the digest the publish will be bound to.
 */
export function renderPreview(preview: CatalogItemPreview): string {
  const lines: string[] = [
    `${preview.kind} ${preview.name} · version ${preview.version} · ${preview.size} bytes`,
    `Summary: ${preview.summary}`,
    '',
    'What an installer would get:',
  ];
  for (const entry of preview.review) {
    if (entry.document) {
      lines.push(`${INDENT}${entry.label}:`, block(entry.text, `${INDENT}${INDENT}`));
    } else {
      lines.push(`${INDENT}${entry.label}: ${entry.text}`);
    }
  }
  if (preview.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of preview.warnings) lines.push(`${INDENT}- ${warning.text}`);
  }
  if (preview.problems.length > 0) {
    lines.push('', 'Left out of the frozen copy:');
    for (const problem of preview.problems) lines.push(`${INDENT}- ${problem.subject}: ${problem.reason}`);
  }
  lines.push('', `Digest: ${preview.digest}`);
  return lines.join('\n');
}

export function renderPublished(published: PublishedCatalogItem): string {
  return `Published ${published.item.name} version ${published.itemVersion} (${published.itemId}); catalog revision ${published.revision}.`;
}

export function renderWithdrawn(withdrawn: WithdrawnCatalogItem, name: string): string {
  return `Withdrew ${name} (${withdrawn.itemId}); catalog revision ${withdrawn.revision}.`;
}

export function renderExported(catalogName: string, itemCount: number, path: string): string {
  return `Exported ${catalogName} (${plural(itemCount, 'item')}) to ${path}.`;
}
