import type {
  CatalogChange,
  CatalogChanges,
  CatalogItemPreview,
  OwnedCatalog,
  OwnedCatalogItem,
  OwnedCatalogList,
  OwnedSharedItem,
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
    case undefined:
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
  const role = catalog.role === 'default' ? ' · default' : '';
  const head = `${catalog.name} (${catalog.id})${role} · revision ${catalog.revision} · ${plural(live, 'item')} · ${catalog.visibility}`;
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

export function renderCatalogDefault(catalog: OwnedCatalog): string {
  return `${catalog.name} (${catalog.id}) is now the default catalog.`;
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
    `Read from: ${preview.location}`,
    '',
  ];
  if (preview.changes !== undefined) lines.push(renderChanges(preview.changes), '');
  lines.push('What an installer would get:');
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

const DIFF_MARK = { context: ' ', add: '+', remove: '-' } as const;
const CHANGE_MARK = { added: '+', removed: '-', changed: '~' } as const;

function renderChange(change: CatalogChange): string {
  const flag = change.flag === undefined ? '' : ` [${change.flag}]`;
  const deep = `${INDENT}${INDENT}`;
  const head = `${INDENT}${CHANGE_MARK[change.change]} ${change.label}${flag}`;
  if (!change.document) {
    const lines = [
      ...(change.before === undefined ? [] : [`${deep}was: ${change.before}`]),
      ...(change.after === undefined ? [] : [`${deep}now: ${change.after}`]),
    ];
    return [head, ...lines].join('\n');
  }
  if (change.tooLarge === true)
    return `${head}\n${deep}too large to show line by line: read the whole file in the full review`;
  const hunks = (change.hunks ?? []).flatMap(hunk => [
    `${deep}@@ -${hunk.beforeStart},${hunk.beforeLines} +${hunk.afterStart},${hunk.afterLines} @@`,
    ...hunk.lines.map(line => `${deep}${DIFF_MARK[line.kind]} ${line.text}`),
  ]);
  const whole = change.change === 'removed' ? change.before : change.change === 'added' ? change.after : undefined;
  return [head, ...hunks, ...(whole === undefined ? [] : [block(whole, deep)])].join('\n');
}

/** What a person would read differently in the next version than in the one every installer gets now. */
export function renderChanges(changes: CatalogChanges): string {
  const lines: string[] = ['What changed since the version installers get now:'];
  if (changes.entries.length === 0) lines.push(`${INDENT}nothing a reader would see differently`);
  for (const entry of changes.entries) lines.push(renderChange(entry));
  if (changes.unchanged > 0) lines.push(`${INDENT}${plural(changes.unchanged, 'part')} the same`);
  for (const warning of changes.newWarnings) lines.push(`${INDENT}new warning: ${warning.text}`);
  for (const warning of changes.goneWarnings) lines.push(`${INDENT}no longer warned: ${warning.text}`);
  if (changes.truncated === true) lines.push(`${INDENT}(this list was cut short: it is longer than can be shown)`);
  return lines.join('\n');
}

/** Every version an item has, oldest first, with the one every catalog serves marked. */
export function renderVersions(item: OwnedSharedItem): string {
  return [
    `${item.name} (${item.itemId}) · ${plural(item.versions.length, 'version')}`,
    ...item.versions.map(version => {
      const marks = [
        version.version === item.current ? 'current' : '',
        version.retiredAt === undefined ? '' : `retired ${version.retiredAt}`,
      ].filter(mark => mark !== '');
      return `${INDENT}v${version.version} · ${version.publishedAt} · ${version.size} bytes${marks.length === 0 ? '' : ` · ${marks.join(' · ')}`}\n${INDENT}${INDENT}${version.summary}`;
    }),
  ].join('\n');
}

export function renderPublished(published: PublishedCatalogItem): string {
  return `Published ${published.item.name} version ${published.itemVersion} (${published.itemId}); catalog revision ${published.revision}.`;
}

export function renderListed(published: PublishedCatalogItem, catalogName: string): string {
  return `Added ${published.item.name} version ${published.itemVersion} (${published.itemId}) to ${catalogName}; catalog revision ${published.revision}.`;
}

export function renderWithdrawn(withdrawn: WithdrawnCatalogItem, name: string): string {
  return `Withdrew ${name} (${withdrawn.itemId}); catalog revision ${withdrawn.revision}.`;
}

/** What an export is about to sign: the catalog, its publisher name, and every live item by version and digest. */
export function renderSigning(catalog: OwnedCatalog, lines: readonly string[]): string {
  return [
    `This will sign ${catalog.name} (${catalog.id}) at revision ${catalog.revision}, published as ${catalog.publisherName}:`,
    ...(lines.length === 0 ? [`${INDENT}no items`] : lines.map(line => `${INDENT}${line}`)),
  ].join('\n');
}

export function renderExported(catalogName: string, itemCount: number, path: string): string {
  return `Exported ${catalogName} (${plural(itemCount, 'item')}) to ${path}.`;
}
