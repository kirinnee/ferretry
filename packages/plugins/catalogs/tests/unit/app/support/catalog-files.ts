import {
  SHARED_CATALOG_VERSIONS_FORMAT,
  type SharedCatalogFile,
  SharedCatalogFileSchema,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  type SharedCatalogManifest,
  SharedCatalogManifestSchema,
  type SignedCatalogItemVersions,
} from '../../../../contract/wire/index.ts';
import {
  catalogItemDigest,
  signCatalogItemVersions,
  signCatalogManifest,
} from '../../../../daemon/lib/relay-wire/catalog-wire/catalog-signature.ts';
import type { DaemonIdentity } from '../../../../daemon/lib/relay-wire/kernel-wire/index.ts';
import { WebCryptoRelayCrypto } from '@ferretry/app';

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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret placeholder, not a template
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

/** The publisher's signed list of the versions it offers of one item, as the manifest's revision sees them. */
export async function signedVersionsOf(
  identity: DaemonIdentity,
  manifest: SharedCatalogManifest,
  versions: readonly SharedCatalogItem[],
  current: number,
): Promise<SignedCatalogItemVersions> {
  const offered = [];
  for (const item of versions) {
    const measured = await catalogItemDigest(crypto, item);
    if (measured === null) throw new Error('item has no canonical form');
    offered.push({
      version: item.itemVersion,
      digest: measured.digest,
      size: measured.size,
      publishedAt: AT,
      summary: item.summary,
    });
  }
  const [first] = versions;
  if (first === undefined) throw new Error('no versions');
  const signed = await signCatalogItemVersions(crypto, identity, {
    format: SHARED_CATALOG_VERSIONS_FORMAT,
    version: 1,
    publisher: manifest.publisher,
    catalogId: manifest.catalogId,
    itemId: first.itemId,
    revision: manifest.revision,
    issuedAt: manifest.issuedAt,
    current,
    offered,
  });
  if (!signed.ok) throw new Error(signed.reason);
  return signed.value;
}
