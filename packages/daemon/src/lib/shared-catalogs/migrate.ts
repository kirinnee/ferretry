/**
 * Version 1 → version 2 of `state/catalogs/catalogs.json` (docs/catalogs.md § Storage and the upgrade).
 *
 * ## Pure and deterministic
 *
 * `migrateCatalogs` reads no clock and makes no random id: the same v1 document and the same frozen files
 * always give the same v2 document and the same shared copies, byte for byte. That is what lets a crash
 * between steps be repaired by running it again.
 *
 * ## What it proves before it lets anything be written
 *
 * - every frozen file the v1 document lists is read, parsed, and hashed against the digest the v1 document
 *   gives it: a file changed under its name is refused, never carried into v2;
 * - the file names the catalog, item and version the v1 document says it is, so putting those three head
 *   fields back reproduces the file's own digest — which is the digest the manifest lists. That is why a
 *   signed manifest and every catalog's item are BYTE-IDENTICAL after the upgrade;
 * - the document it makes passes the v2 schema.
 *
 * Any failure is `store_damaged` for the whole upgrade, and nothing has been written yet.
 */
import { type SharedCatalogItem, SharedCatalogItemSchema } from '@ferretry/protocol';
import type { RelayCrypto } from '@ferretry/relay';
import {
  CATALOGS_SCHEMA_VERSION,
  CatalogsDocumentSchema,
  type CatalogsDocument,
  type StoredCatalog,
  type StoredSharedItem,
  documentProblem,
  placeholderProblem,
} from './document.ts';
import type { CatalogsDocumentV1 } from './document-v1.ts';
import { canonicalCopy, fileCountOf, sharedCopy } from './freeze.ts';
import { CatalogRefusal } from './refusal.ts';

/** A shared copy to put on disk, under the digest it hashes to. */
interface SharedBlob {
  readonly digest: string;
  readonly text: string;
}

export interface Migration {
  readonly document: CatalogsDocument;
  readonly sharedBlobs: readonly SharedBlob[];
}

const HEX = /^sha256:([0-9a-f]{64})$/u;

export async function migrateCatalogs(
  crypto: RelayCrypto,
  v1: CatalogsDocumentV1,
  readBlob: (digest: string) => Promise<string | undefined>,
): Promise<Migration> {
  const items: StoredSharedItem[] = [];
  const blobs = new Map<string, SharedBlob>();
  const catalogs: StoredCatalog[] = [];

  for (const catalog of v1.catalogs) {
    for (const problem of [
      placeholderProblem('catalog', catalog.id),
      ...catalog.items.map(item => placeholderProblem('item', item.itemId)),
    ])
      if (problem !== undefined) throw upgradeRefused(problem);
    for (const item of catalog.items) {
      const versions: StoredSharedItem['versions'] = [];
      for (const stored of item.versions) {
        const damaged = (why: string) =>
          new CatalogRefusal(
            'store_damaged',
            `The frozen copy of ${item.name} version ${String(stored.version)} (blobs/${HEX.exec(stored.digest)?.[1] ?? stored.digest}.json) is ${why}, so catalogs could not be upgraded. Nothing was changed. Restore that file from a backup, or install the previous Ferretry version.`,
          );
        const text = await readBlob(stored.digest);
        if (text === undefined) throw damaged('missing or damaged');
        const found = parseItem(text);
        if (found === undefined) throw damaged('missing or damaged');
        const own = await canonicalCopy(crypto, found);
        if (own?.digest !== stored.digest) throw damaged('missing or damaged');
        if (found.catalogId !== catalog.id || found.itemId !== item.itemId || found.itemVersion !== stored.version)
          throw damaged('missing or damaged');
        const shared = await canonicalCopy(crypto, sharedCopy(found));
        if (shared === undefined) throw damaged('missing or damaged');
        if (!blobs.has(shared.digest)) blobs.set(shared.digest, { digest: shared.digest, text: shared.text });
        const fileCount = fileCountOf(found);
        versions.push({
          version: stored.version,
          publishedAt: stored.publishedAt,
          summary: stored.summary,
          source: stored.source,
          contentDigest: shared.digest,
          size: shared.size,
          ...(fileCount === undefined ? {} : { fileCount }),
          bindings: { [catalog.id]: { digest: stored.digest, size: stored.size } },
        });
      }
      items.push({
        itemId: item.itemId,
        kind: item.kind,
        name: item.name,
        ...(item.harness === undefined ? {} : { harness: item.harness }),
        ownSummary: item.ownSummary,
        createdAt: (item.versions[0] as { publishedAt: string }).publishedAt,
        current: (versions[versions.length - 1] as { version: number }).version,
        versions,
      });
    }
    catalogs.push({
      id: catalog.id,
      name: catalog.name,
      description: catalog.description,
      publisherName: catalog.publisherName,
      visibility: catalog.visibility,
      revision: catalog.revision,
      issuedAt: catalog.issuedAt,
      createdAt: catalog.createdAt,
      entries: catalog.items.map(item => ({
        itemId: item.itemId,
        addedAt: (item.versions[0] as { publishedAt: string }).publishedAt,
        ...(item.withdrawnAt === undefined ? {} : { withdrawnAt: item.withdrawnAt }),
      })),
    });
  }

  const parsed = CatalogsDocumentSchema.safeParse({ schemaVersion: CATALOGS_SCHEMA_VERSION, items, catalogs });
  if (!parsed.success) throw upgradeRefused(documentProblem(parsed) ?? 'it is malformed');
  return { document: parsed.data, sharedBlobs: [...blobs.values()] };
}

function upgradeRefused(problem: string): CatalogRefusal {
  return new CatalogRefusal(
    'store_damaged',
    `catalogs.json could not be upgraded: ${problem}. Nothing was changed. Restore the file from a backup, or install the previous Ferretry version.`,
  );
}

function parseItem(text: string): SharedCatalogItem | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = SharedCatalogItemSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}
