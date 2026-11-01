/**
 * A catalogs store as the version 1 daemon left it, built from first principles (not from the migration), and the
 * export the version 1 daemon would have made of it. The migration is held to that export, byte for byte.
 */
import {
  type CatalogSkill,
  SHARED_CATALOG_FILE_FORMAT,
  SHARED_CATALOG_MANIFEST_FORMAT,
  type SharedCatalogFile,
  type SharedCatalogItem,
} from '@ferretry/protocol';
import { signCatalogManifest } from '@ferretry/relay';
import type { CatalogsDocumentV1 } from '../../../src/lib/shared-catalogs/document-v1.ts';
import { canonicalOrRefuse, freezeItem, skillOf } from '../../../src/lib/shared-catalogs/freeze.ts';
import { mcpSetupOf } from '../../../src/lib/shared-catalogs/mcp-source.ts';
import { crypto, type Rig, SKILL_MD, stdio } from './support.ts';

const T = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
export const LEGACY_CATALOG = `cat_${'B'.repeat(22)}`;
export const LEGACY_OTHER = `cat_${'C'.repeat(22)}`;
export const LEGACY_SKILL = `itm_${'S'.repeat(22)}`;
export const LEGACY_MCP = `itm_${'M'.repeat(22)}`;
export const LEGACY_ALONE = `itm_${'L'.repeat(22)}`;

export interface Legacy {
  readonly document: CatalogsDocumentV1;
  readonly text: string;
  /** Digest → canonical text, the frozen files a version 1 daemon had on disk. */
  readonly blobs: ReadonlyMap<string, string>;
  /** Every item as each version 1 manifest lists it, latest version of each live item. */
  readonly items: ReadonlyMap<string, readonly SharedCatalogItem[]>;
}

/** Two catalogs: one with a skill (two versions), an MCP setup (withdrawn) and a live MCP; one with a single MCP. */
export async function legacyState(r: Rig): Promise<Legacy> {
  const publisher = (r.identity as NonNullable<Rig['identity']>).daemonId;
  const blobs = new Map<string, string>();
  const frozen = new Map<string, SharedCatalogItem[]>();
  const versionOf = async (
    catalogId: string,
    itemId: string,
    version: number,
    name: string,
    body: Parameters<typeof freezeItem>[0]['body'],
    day: number,
  ) => {
    const summary = `${name} summary`;
    const item = freezeItem({ publisher, catalogId, itemId, itemVersion: version, name, summary, body });
    const copy = await canonicalOrRefuse(crypto, item);
    blobs.set(copy.digest, copy.text);
    frozen.set(itemId, [...(frozen.get(itemId) ?? []), item]);
    return {
      version,
      digest: copy.digest,
      contentDigest: `sha256:${'d'.repeat(63)}${String(version)}`,
      size: copy.size,
      publishedAt: T(day),
      summary,
      source:
        body.kind === 'skill'
          ? { kind: 'skill' as const, path: '/home/me/.claude/skills/demo/SKILL.md' }
          : { kind: 'mcp' as const, id: `id-${name}`, name },
    };
  };
  const skill = (notes: string) =>
    ({
      kind: 'skill' as const,
      skill: skillOf([
        { path: 'SKILL.md', content: SKILL_MD },
        { path: 'notes.txt', content: notes },
      ]) as CatalogSkill,
    }) as const;
  const mcp = (name: string) => {
    const converted = mcpSetupOf(stdio(name));
    if (!converted.ok) throw new Error('fixture');
    return { kind: 'mcp' as const, mcp: converted.setup };
  };
  const document: CatalogsDocumentV1 = {
    schemaVersion: 1,
    catalogs: [
      {
        id: LEGACY_CATALOG,
        name: 'Team tools',
        description: 'for us',
        publisherName: 'studio',
        visibility: 'members',
        revision: 6,
        issuedAt: T(5),
        createdAt: T(1),
        items: [
          {
            itemId: LEGACY_SKILL,
            kind: 'skill',
            name: 'demo',
            ownSummary: false,
            versions: [
              await versionOf(LEGACY_CATALOG, LEGACY_SKILL, 1, 'demo', skill('notes'), 2),
              await versionOf(LEGACY_CATALOG, LEGACY_SKILL, 2, 'demo', skill('new notes'), 4),
            ],
          },
          {
            itemId: LEGACY_MCP,
            kind: 'mcp',
            name: 'files',
            ownSummary: true,
            withdrawnAt: T(5),
            versions: [await versionOf(LEGACY_CATALOG, LEGACY_MCP, 1, 'files', mcp('files'), 3)],
          },
        ],
      },
      {
        id: LEGACY_OTHER,
        name: 'Other',
        description: '',
        publisherName: 'studio',
        visibility: 'members',
        revision: 2,
        issuedAt: T(3),
        createdAt: T(1),
        items: [
          {
            itemId: LEGACY_ALONE,
            kind: 'mcp',
            name: 'files',
            ownSummary: false,
            versions: [await versionOf(LEGACY_OTHER, LEGACY_ALONE, 1, 'files', mcp('files'), 3)],
          },
        ],
      },
    ],
  };
  return { document, text: `${JSON.stringify(document, undefined, 2)}\n`, blobs, items: frozen };
}

/** The export a version 1 daemon makes of a catalog: its own code path, copied, reading only the version 1 document. */
export async function legacyExport(r: Rig, legacy: Legacy, catalogId: string): Promise<SharedCatalogFile> {
  const identity = r.identity as NonNullable<Rig['identity']>;
  const catalog = legacy.document.catalogs.find(candidate => candidate.id === catalogId);
  if (catalog === undefined) throw new Error('fixture');
  const live = catalog.items.filter(item => item.withdrawnAt === undefined);
  const signed = await signCatalogManifest(crypto, identity, {
    format: SHARED_CATALOG_MANIFEST_FORMAT,
    version: 1,
    publisher: identity.daemonId,
    publisherName: catalog.publisherName,
    catalogId: catalog.id,
    name: catalog.name,
    description: catalog.description,
    visibility: catalog.visibility,
    revision: catalog.revision,
    issuedAt: catalog.issuedAt,
    items: live.map(item => {
      const latest = item.versions[item.versions.length - 1] as (typeof item.versions)[number];
      return {
        itemId: item.itemId,
        kind: item.kind,
        name: item.name,
        summary: latest.summary,
        version: latest.version,
        digest: latest.digest,
        size: latest.size,
        publishedAt: latest.publishedAt,
        ...(item.harness === undefined ? {} : { harness: item.harness }),
      };
    }),
    withdrawn: catalog.items.flatMap(item =>
      item.withdrawnAt === undefined ? [] : [{ itemId: item.itemId, at: item.withdrawnAt }],
    ),
  });
  if (!signed.ok) throw new Error(signed.reason);
  return {
    format: SHARED_CATALOG_FILE_FORMAT,
    version: 1,
    exportedAt: catalog.issuedAt,
    signedManifest: signed.value,
    items: live.map(item => (legacy.items.get(item.itemId) as SharedCatalogItem[]).at(-1) as SharedCatalogItem),
  };
}

/** Puts a version 1 store under a rig: the file as text and its frozen files, as an upgrade finds them. */
export function install(r: Rig, legacy: Legacy): void {
  r.documents.raw = { version: 1, doc: legacy.document, text: legacy.text };
  for (const [digest, text] of legacy.blobs) r.blobs.blobs.set(digest, text);
}
