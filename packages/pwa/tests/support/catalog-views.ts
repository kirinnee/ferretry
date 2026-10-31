import {
  type CatalogInstall,
  CatalogInstallPreviewSchema,
  type CatalogItemPreview,
  CatalogItemPreviewSchema,
  type OwnedCatalog,
  OwnedCatalogSchema,
} from '@ferretry/protocol';

const AT = '2026-10-31T09:00:00.000Z';
export const DIGEST = `sha256:${'ab'.repeat(32)}` as const;
const PUBLISHER = `fy_daemon_${'q3Xk'.repeat(10)}Xkq` as const;
export const CATALOG = `cat_${'c'.repeat(22)}` as const;
export const ITEM = `itm_${'s'.repeat(22)}` as const;
export const PREVIEW_ID = `cip_${'p'.repeat(22)}` as const;
export const INSTALL_ID = `cin_${'i'.repeat(22)}` as const;

export function ownedCatalog(
  change: Record<string, unknown> = {},
  itemChange: Record<string, unknown> = {},
): OwnedCatalog {
  return OwnedCatalogSchema.parse({
    id: CATALOG,
    name: 'Team skills',
    description: '',
    publisherName: 'kirin-box',
    visibility: 'members',
    revision: 4,
    issuedAt: AT,
    createdAt: AT,
    items: [
      {
        itemId: ITEM,
        kind: 'skill',
        name: 'pdf-tools',
        summary: 'Split, merge and OCR PDFs',
        source: { kind: 'skill', path: '/home/k/.claude/skills/pdf-tools/SKILL.md' },
        versions: [
          { version: 1, digest: DIGEST, size: 100, publishedAt: AT },
          { version: 2, digest: DIGEST, size: 120, publishedAt: AT },
        ],
        ...itemChange,
      },
    ],
    ...change,
  });
}

export function itemPreview(change: Record<string, unknown> = {}): CatalogItemPreview {
  return CatalogItemPreviewSchema.parse({
    catalogId: CATALOG,
    kind: 'skill',
    name: 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    location: '/home/k/.claude/skills/pdf-tools/SKILL.md',
    version: 1,
    digest: DIGEST,
    size: 100,
    review: [{ label: 'Skill file SKILL.md', text: '# pdf tools\n', document: true }],
    warnings: [],
    problems: [],
    ...change,
  });
}

export function installPreview(change: Record<string, unknown> = {}) {
  return CatalogInstallPreviewSchema.parse({
    previewId: PREVIEW_ID,
    expiresAt: AT,
    provenance: {
      publisher: PUBLISHER,
      publisherName: 'kirin-box',
      catalogId: CATALOG,
      catalogName: 'Team skills',
      itemId: ITEM,
      kind: 'mcp',
      name: 'acme-mcp',
      version: 1,
      digest: DIGEST,
    },
    publisher: { daemonId: PUBLISHER, name: 'kirin-box', firstSeen: true },
    target: { scope: 'runtime', runtime: 'box', profile: 'default' },
    destination: 'runtime box, profile default',
    review: [{ label: 'Starts', text: 'acme-mcp --stdio', document: false }],
    secrets: [{ placeholder: 'ACME_TOKEN' }, { placeholder: 'ACME_REGION', held: true }],
    warnings: [],
    ...change,
  });
}

export function installRecord(kind: 'skill' | 'mcp' = 'skill', name = 'pdf-tools'): CatalogInstall {
  const preview = installPreview();
  return {
    installId: INSTALL_ID,
    installedAt: AT,
    provenance: { ...preview.provenance, kind, name },
    target: preview.target,
    destination: preview.destination,
    secretBindings: {},
  };
}
