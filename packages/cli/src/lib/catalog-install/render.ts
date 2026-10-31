import type { CatalogInstall, CatalogInstallPreview } from '@ferretry/protocol';

const indent = (text: string, by: string): string =>
  text
    .split('\n')
    .map(line => `${by}${line}`)
    .join('\n');

/** The whole review, in words: nothing the item brings is left out or shortened. */
export const renderPreview = (preview: CatalogInstallPreview): string => {
  const { provenance, publisher } = preview;
  const lines = [
    `${provenance.name} (${provenance.kind}, version ${provenance.version}) from ${provenance.catalogName}`,
    `Published by ${publisher.name} (${publisher.daemonId})${publisher.firstSeen ? ' - first time you install from them; this fingerprint is pinned from now on' : ''}`,
    `Digest ${provenance.digest}`,
    `Lands in: ${preview.destination}`,
  ];
  if (preview.replaces !== undefined)
    lines.push(`Replaces the version ${preview.replaces.version} you installed there (${preview.replaces.installId})`);
  if (preview.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of preview.warnings) lines.push(`  ! ${warning.text}`);
  }
  lines.push('', 'What it brings:');
  for (const entry of preview.review)
    lines.push(
      entry.document ? `  ${entry.label}:\n${indent(entry.text, '    | ')}` : `  ${entry.label}: ${entry.text}`,
    );
  if (preview.secrets.length > 0) {
    lines.push('', 'Secrets it asks for:');
    for (const secret of preview.secrets)
      lines.push(`  ${secret.placeholder}${secret.held ? ' (you hold a secret with this name)' : ''}`);
  }
  return lines.join('\n');
};

export const renderInstalls = (installs: readonly CatalogInstall[]): string => {
  if (installs.length === 0) return 'No catalog items are installed.';
  return installs
    .map(install => {
      const { provenance } = install;
      const bound = Object.entries(install.secretBindings)
        .map(([placeholder, own]) => `${placeholder} -> ${own ?? 'unbound'}`)
        .join(', ');
      return [
        `${install.installId}  ${provenance.name} v${provenance.version} (${provenance.kind}) from ${provenance.catalogName} by ${provenance.publisherName}`,
        `  in ${install.destination}${bound === '' ? '' : `; secrets: ${bound}`}`,
      ].join('\n');
    })
    .join('\n');
};
