/** One publisher, one skill, a signed manifest and a signed version list: the documents the daemon's wire copies are driven with. */
import { catalogItemDigest, fromBase64Url, toBase64Url } from '../../daemon/lib/relay-wire/index.ts';
import {
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  type SharedCatalogItemVersions,
  type SharedCatalogManifest,
  SharedCatalogManifestSchema,
  type SignedCatalogItemVersions,
  type SignedCatalogManifest,
} from '../../contract/wire/index.ts';
import { signCatalogItemVersions, signCatalogManifest } from './catalog-crypto.ts';
import { newDaemonIdentity, relayCrypto } from './worker/identities.ts';

export const AT = '2026-10-31T09:00:00.000Z';
const CATALOG = `cat_${'c'.repeat(22)}`;
const ITEM = `itm_${'s'.repeat(22)}`;
export const hex = (char: string) => `sha256:${char.repeat(64)}`;
/** A lone surrogate: JSON.parse can produce one, and RFC 8785 has no spelling for it. */
export const LONE = String.fromCharCode(0xd800);

export const skill = (publisher: string, itemVersion = 3, content = '# pdf tools\n'): SharedCatalogItem =>
  SharedCatalogItemSchema.parse({
    format: 'ferretry-catalog-item',
    version: 1,
    publisher,
    catalogId: CATALOG,
    itemId: ITEM,
    itemVersion,
    name: 'pdf-tools',
    summary: 'Split, merge and OCR PDFs',
    kind: 'skill',
    skill: { files: [{ path: 'SKILL.md', content }] },
  });

export const flip = (base64: string): string => {
  const bytes = fromBase64Url(base64) ?? new Uint8Array();
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
  return toBase64Url(bytes);
};

/** A catalog offering versions 2 (kept) and 3 (current) of one skill, signed by a fresh publisher. */
export async function world() {
  const identity = await newDaemonIdentity();
  const item = skill(identity.daemonId);
  const measured = await catalogItemDigest(relayCrypto, item);
  if (measured === null) throw new Error('no canonical form');
  const manifest: SharedCatalogManifest = SharedCatalogManifestSchema.parse({
    format: 'ferretry-catalog-manifest',
    version: 1,
    publisher: identity.daemonId,
    publisherName: 'kirin-box',
    catalogId: CATALOG,
    name: 'Skills',
    description: '',
    visibility: 'members',
    revision: 4,
    issuedAt: AT,
    items: [
      {
        itemId: ITEM,
        kind: 'skill',
        name: 'pdf-tools',
        summary: item.summary,
        version: 3,
        digest: measured.digest,
        size: measured.size,
        publishedAt: AT,
      },
    ],
    withdrawn: [],
  });
  const list: SharedCatalogItemVersions = {
    format: 'ferretry-catalog-versions',
    version: 1,
    publisher: identity.daemonId,
    catalogId: CATALOG,
    itemId: ITEM,
    revision: 4,
    issuedAt: AT,
    current: 3,
    offered: [
      { version: 2, digest: hex('2'), size: 10, publishedAt: AT, summary: 'older' },
      { version: 3, digest: measured.digest, size: measured.size, publishedAt: AT, summary: item.summary },
    ],
  };
  const sign = async (m: SharedCatalogManifest): Promise<SignedCatalogManifest> => {
    const signed = await signCatalogManifest(relayCrypto, identity, m);
    if (!signed.ok) throw new Error(signed.reason);
    return signed.value;
  };
  const signList = async (l: SharedCatalogItemVersions): Promise<SignedCatalogItemVersions> => {
    const signed = await signCatalogItemVersions(relayCrypto, identity, l);
    if (!signed.ok) throw new Error(signed.reason);
    return signed.value;
  };
  return {
    identity,
    item,
    manifest,
    list,
    sign,
    signList,
    signedManifest: await sign(manifest),
    signedList: await signList(list),
  };
}
