import {
  CATALOG_LINK_BUNDLE_FORMAT,
  CATALOG_LINK_FORMAT,
  catalogCanonicalText,
  LINK_ITEM_CATALOG_ID,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  type SharedCatalogLink,
  type SharedCatalogLinkBundle,
  SharedCatalogLinkBundleSchema,
  SharedCatalogLinkSchema,
} from '@ferretry/protocol';
import { catalogItemDigest, mintLinkSecrets, signCatalogLink } from '../../src/lib/index.ts';
import { newDaemonIdentity, relayCrypto } from './identities.ts';

export const LINK_AT = '2026-10-31T09:00:00.000Z';
export const LINK_NOT_AFTER = '2026-11-07T09:00:00.000Z';
const LINK_ID = `lnk_${'a'.repeat(22)}`;
const ITEM = `itm_${'s'.repeat(22)}`;

export const linkSkill = (publisher: string, content = '# pdf tools\n'): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    format: 'ferretry-catalog-item',
    version: 1,
    publisher,
    catalogId: LINK_ITEM_CATALOG_ID,
    itemId: ITEM,
    itemVersion: 3,
    name: 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    kind: 'skill',
    skill: { files: [{ path: 'SKILL.md', content }] },
  });

/** One publisher, one skill, one signed public link and the bundle that carries them. */
export async function linkWorld(changes: Partial<SharedCatalogLink> = {}) {
  const identity = await newDaemonIdentity();
  const secrets = mintLinkSecrets(relayCrypto);
  const item = linkSkill(identity.daemonId);
  const measured = await catalogItemDigest(relayCrypto, item);
  if (measured === null) throw new Error('no canonical form');
  const link = SharedCatalogLinkSchema.parse({
    format: CATALOG_LINK_FORMAT,
    version: 1,
    publisher: identity.daemonId,
    publisherName: 'kirin-box',
    linkId: LINK_ID,
    bundleId: secrets.bundleId,
    kind: 'public',
    sequence: 1,
    issuedAt: LINK_AT,
    notAfter: LINK_NOT_AFTER,
    item: {
      itemId: ITEM,
      kind: 'skill',
      name: 'pdf-tools',
      summary: item.summary,
      version: 3,
      digest: measured.digest,
      size: measured.size,
      publishedAt: LINK_AT,
    },
    ...changes,
  });
  const signed = await signCatalogLink(relayCrypto, identity, link);
  if (!signed.ok) throw new Error(signed.reason);
  const bundle: SharedCatalogLinkBundle = SharedCatalogLinkBundleSchema.parse({
    format: CATALOG_LINK_BUNDLE_FORMAT,
    version: 1,
    signedLink: signed.value,
    item,
  });
  const text = catalogCanonicalText(bundle);
  if (!text.ok) throw new Error(text.reason);
  return { identity, secrets, item, link, signed: signed.value, bundle, text: text.text };
}
