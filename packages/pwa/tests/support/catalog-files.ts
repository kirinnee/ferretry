import {
  type SharedCatalogFile,
  SharedCatalogFileSchema,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  SharedCatalogManifestSchema,
} from '@ferretry/protocol';
import { catalogItemDigest, type DaemonIdentity, signCatalogManifest } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';

export const crypto = new WebCryptoRelayCrypto();

const AT = '2026-10-31T09:00:00.000Z';
const CATALOG_ID = `cat_${'c'.repeat(22)}` as const;
export const SKILL_ITEM_ID = `itm_${'s'.repeat(22)}` as const;
const MCP_ITEM_ID = `itm_${'m'.repeat(22)}` as const;

const toPem = (der: ArrayBuffer): string => {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join(
    '\n',
  );
};

export async function newIdentity(): Promise<DaemonIdentity> {
  const pair = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  return crypto.importDaemonIdentity(toPem(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey)));
}

export const skillItem = (publisher: string): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    format: 'ferretry-catalog-item',
    version: 1,
    publisher,
    catalogId: CATALOG_ID,
    itemId: SKILL_ITEM_ID,
    itemVersion: 1,
    name: 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    kind: 'skill',
    skill: { files: [{ path: 'SKILL.md', content: '# pdf tools\n' }] },
  });

export const mcpItem = (publisher: string): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    format: 'ferretry-catalog-item',
    version: 1,
    publisher,
    catalogId: CATALOG_ID,
    itemId: MCP_ITEM_ID,
    itemVersion: 1,
    name: 'acme-mcp',
    summary: 'Talk to Acme',
    kind: 'mcp',
    mcp: { transport: 'command', command: 'acme-mcp', args: ['--stdio'], env: { ACME_TOKEN: '${secret:ACME_TOKEN}' } },
  });

/** A signed catalog file, as a daemon would export it, carrying only `carried` of the `listed` items. */
export async function signedFile(
  identity: DaemonIdentity,
  listed: readonly SharedCatalogItem[],
  carried: readonly SharedCatalogItem[] = listed,
  withdrawn: readonly string[] = [],
): Promise<SharedCatalogFile> {
  const entries = [];
  for (const item of listed) {
    const measured = await catalogItemDigest(crypto, item);
    if (measured === null) throw new Error('item has no canonical form');
    entries.push({
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      summary: item.summary,
      version: item.itemVersion,
      digest: measured.digest,
      size: measured.size,
      publishedAt: AT,
    });
  }
  const manifest = SharedCatalogManifestSchema.parse({
    format: 'ferretry-catalog-manifest',
    version: 1,
    publisher: identity.daemonId,
    publisherName: 'kirin-box',
    catalogId: CATALOG_ID,
    name: "Kirin's catalog",
    description: '',
    visibility: 'members',
    revision: 1,
    issuedAt: AT,
    items: entries.filter(entry => !withdrawn.includes(entry.itemId)),
    withdrawn: withdrawn.map(itemId => ({ itemId, at: AT })),
  });
  const signed = await signCatalogManifest(crypto, identity, manifest);
  if (!signed.ok) throw new Error(signed.reason);
  return SharedCatalogFileSchema.parse({
    format: 'ferretry-catalog-file',
    version: 1,
    exportedAt: AT,
    signedManifest: signed.value,
    items: carried.filter(item => !withdrawn.includes(item.itemId)),
  });
}
