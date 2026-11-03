import {
  type CatalogInstallTarget,
  type CatalogLinkInstallPreviewRequest,
  LINK_ITEM_CATALOG_ID,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  SharedCatalogItemVersionsSchema,
  type SignedCatalogItemVersions,
  type SharedCatalogManifest,
  SharedCatalogManifestSchema,
  type SignedCatalogManifest,
  SharedCatalogLinkSchema,
} from '@ferretry/protocol';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import {
  catalogItemDigest,
  type DaemonIdentity,
  mintLinkSecrets,
  signCatalogItemVersions,
  signCatalogLink,
  signCatalogManifest,
} from '@ferretry/relay';

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

const LINK_AT = '2026-10-31T09:00:00.000Z';
export const LINK_NOT_AFTER = '2026-11-07T09:00:00.000Z';
export const LINK_ID = `lnk_${'a'.repeat(22)}`;
const LINK_ITEM_ID = `itm_${'l'.repeat(22)}`;

export interface LinkOverrides {
  readonly linkId?: string;
  readonly sequence?: number;
  readonly kind?: 'one-time' | 'public';
  readonly notAfter?: string;
  readonly itemVersion?: number;
  readonly content?: string;
}

/** A skill as a link carries it: under the placeholder catalog id every link item has. */
export const linkSkillItem = (publisher: string, overrides: LinkOverrides = {}): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    format: 'ferretry-catalog-item',
    version: 1,
    publisher,
    catalogId: LINK_ITEM_CATALOG_ID,
    itemId: LINK_ITEM_ID,
    itemVersion: overrides.itemVersion ?? 1,
    name: 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    kind: 'skill',
    skill: { files: [{ path: 'SKILL.md', content: overrides.content ?? '# pdf tools\n' }] },
  });

/** Sign one link for `item`, as `identity`, and answer the installer's request for it. */
export async function linkPreviewRequest(
  identity: DaemonIdentity,
  target: CatalogInstallTarget,
  overrides: LinkOverrides & {
    readonly item?: SharedCatalogItem;
    readonly linkFingerprint?: string;
    readonly allowOlder?: true;
    readonly replaceEdited?: true;
  } = {},
): Promise<CatalogLinkInstallPreviewRequest> {
  const item = overrides.item ?? linkSkillItem(identity.daemonId, overrides);
  const measured = await catalogItemDigest(crypto, item);
  if (measured === null) throw new Error('item has no canonical form');
  const kind = overrides.kind ?? 'public';
  const link = SharedCatalogLinkSchema.parse({
    format: 'ferretry-catalog-link',
    version: 1,
    publisher: identity.daemonId,
    publisherName: 'kirin-box',
    linkId: overrides.linkId ?? LINK_ID,
    bundleId: mintLinkSecrets(crypto).bundleId,
    kind,
    sequence: overrides.sequence ?? 1,
    issuedAt: LINK_AT,
    notAfter: overrides.notAfter ?? (kind === 'one-time' ? '2026-10-31T21:00:00.000Z' : LINK_NOT_AFTER),
    ...(kind === 'one-time' ? { expiresAt: '2026-10-31T21:00:00.000Z' } : {}),
    item: {
      itemId: item.itemId,
      kind: item.kind,
      name: item.name,
      summary: item.summary,
      version: item.itemVersion,
      digest: measured.digest,
      size: measured.size,
      publishedAt: LINK_AT,
    },
  });
  const signed = await signCatalogLink(crypto, identity, link);
  if (!signed.ok) throw new Error(signed.reason);
  return {
    signedLink: signed.value,
    item,
    linkFingerprint: (overrides.linkFingerprint ??
      identity.daemonId) as CatalogLinkInstallPreviewRequest['linkFingerprint'],
    target,
    ...(overrides.allowOlder === true ? { allowOlder: true as const } : {}),
    ...(overrides.replaceEdited === true ? { replaceEdited: true as const } : {}),
  };
}
