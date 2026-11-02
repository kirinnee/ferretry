import {
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  SharedCatalogItemVersionsSchema,
  type SignedCatalogItemVersions,
  type SharedCatalogManifest,
  SharedCatalogManifestSchema,
  type SignedCatalogManifest,
} from '@ferretry/protocol';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import { catalogItemDigest, type DaemonIdentity, signCatalogItemVersions, signCatalogManifest } from '@ferretry/relay';

export const crypto = new WebCryptoRelayCrypto();

const AT = '2026-10-31T09:00:00.000Z';
export const CATALOG_ID = `cat_${'c'.repeat(22)}` as const;
const SKILL_ITEM_ID = `itm_${'s'.repeat(22)}` as const;
const MCP_ITEM_ID = `itm_${'m'.repeat(22)}` as const;

const toPem = (der: ArrayBuffer): string => {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join(
    '\n',
  );
};

/** A fresh daemon identity, loaded the way a daemon loads the key it stored at install. */
export async function newIdentity(): Promise<DaemonIdentity> {
  const pair = (await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  return crypto.importDaemonIdentity(toPem(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey)));
}

export interface ItemOverrides {
  readonly catalogId?: string;
  readonly itemId?: string;
  readonly itemVersion?: number;
  readonly name?: string;
  readonly harness?: 'claude' | 'codex' | 'generic';
  readonly files?: readonly { path: string; content: string }[];
}

export const skillItem = (publisher: string, overrides: ItemOverrides = {}): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    format: 'ferretry-catalog-item',
    version: 1,
    publisher,
    catalogId: overrides.catalogId ?? CATALOG_ID,
    itemId: overrides.itemId ?? SKILL_ITEM_ID,
    itemVersion: overrides.itemVersion ?? 1,
    name: overrides.name ?? 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    kind: 'skill',
    ...(overrides.harness === undefined ? {} : { harness: overrides.harness }),
    skill: { files: overrides.files ?? [{ path: 'SKILL.md', content: '# pdf tools\n' }] },
  });

export const mcpItem = (
  publisher: string,
  overrides: ItemOverrides & { readonly mcp?: unknown } = {},
): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    format: 'ferretry-catalog-item',
    version: 1,
    publisher,
    catalogId: overrides.catalogId ?? CATALOG_ID,
    itemId: overrides.itemId ?? MCP_ITEM_ID,
    itemVersion: overrides.itemVersion ?? 1,
    name: overrides.name ?? 'acme-mcp',
    summary: 'Talk to Acme',
    kind: 'mcp',
    ...(overrides.harness === undefined ? {} : { harness: overrides.harness }),
    mcp: overrides.mcp ?? {
      transport: 'command',
      command: 'acme-mcp',
      args: ['--stdio'],
      env: { ACME_TOKEN: '${secret:ACME_TOKEN}' },
    },
  });

export const artifactItem = (publisher: string): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    format: 'ferretry-catalog-item',
    version: 1,
    publisher,
    catalogId: CATALOG_ID,
    itemId: `itm_${'a'.repeat(22)}`,
    itemVersion: 1,
    name: 'report',
    summary: 'A report',
    kind: 'artifact',
    artifact: { objectId: 'a'.repeat(32), mediaType: 'application/pdf', size: 10 },
  });

export interface Published {
  readonly signedManifest: SignedCatalogManifest;
  readonly items: readonly SharedCatalogItem[];
}

/** Sign a manifest listing `items`, as `identity`. `revision` and `catalogId` default to 1 and the shared one. */
export async function publish(
  identity: DaemonIdentity,
  items: readonly SharedCatalogItem[],
  options: { revision?: number; catalogId?: string; publisherName?: string } = {},
): Promise<Published> {
  const entries = [];
  for (const item of items) {
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
      ...(item.harness === undefined ? {} : { harness: item.harness }),
    });
  }
  const manifest: SharedCatalogManifest = SharedCatalogManifestSchema.parse({
    format: 'ferretry-catalog-manifest',
    version: 1,
    publisher: identity.daemonId,
    publisherName: options.publisherName ?? 'kirin-box',
    catalogId: options.catalogId ?? CATALOG_ID,
    name: "Kirin's catalog",
    description: '',
    visibility: 'members',
    revision: options.revision ?? 1,
    issuedAt: AT,
    items: entries,
    withdrawn: [],
  });
  const signed = await signCatalogManifest(crypto, identity, manifest);
  if (!signed.ok) throw new Error(signed.reason);
  return { signedManifest: signed.value, items };
}

export interface VersionListOptions {
  /** The version the list calls current; defaults to the highest of `items`. */
  readonly current?: number;
  readonly revision?: number;
  readonly catalogId?: string;
  readonly itemId?: string;
}

/**
 * Sign the list of versions a catalog offers of ONE item, for the manifest in `published`, as `identity`.
 * `items` are the versions on offer, oldest first.
 */
export async function signVersionList(
  identity: DaemonIdentity,
  published: Published,
  items: readonly SharedCatalogItem[],
  options: VersionListOptions = {},
): Promise<SignedCatalogItemVersions> {
  const offered = [];
  for (const item of items) {
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
  const first = items[0];
  if (first === undefined) throw new Error('no versions');
  const manifest = published.signedManifest.manifest;
  const signed = await signCatalogItemVersions(
    crypto,
    identity,
    SharedCatalogItemVersionsSchema.parse({
      format: 'ferretry-catalog-versions',
      version: 1,
      publisher: identity.daemonId,
      catalogId: options.catalogId ?? manifest.catalogId,
      itemId: options.itemId ?? first.itemId,
      revision: options.revision ?? manifest.revision,
      issuedAt: manifest.issuedAt,
      current: options.current ?? Math.max(...items.map(item => item.itemVersion)),
      offered,
    }),
  );
  if (!signed.ok) throw new Error(signed.reason);
  return signed.value;
}
