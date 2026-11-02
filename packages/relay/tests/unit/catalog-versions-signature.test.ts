import { describe, it } from 'bun:test';
import {
  CATALOG_VERSIONS_SIGNATURE_LABEL,
  catalogItemDigest,
  fromBase64Url,
  signCatalogItemVersions,
  signCatalogManifest,
  toBase64Url,
  utf8Bytes,
  verifyCatalogItemAgainstVersions,
  verifySignedCatalogItemVersions,
  verifySignedCatalogManifest,
} from '@ferretry/relay';
import {
  catalogCanonicalText,
  catalogVersionsSignedBytes,
  type SharedCatalogItem,
  SharedCatalogItemSchema,
  type SharedCatalogItemVersions,
  type SharedCatalogManifest,
  SharedCatalogManifestSchema,
  type SignedCatalogItemVersions,
} from '@ferretry/protocol';
import should from 'should';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';

const AT = '2026-10-31T09:00:00.000Z';
const CATALOG = `cat_${'c'.repeat(22)}`;
const ITEM = `itm_${'s'.repeat(22)}`;
const hex = (char: string) => `sha256:${char.repeat(64)}`;

const skill = (publisher: string, itemVersion = 3, content = '# pdf tools\n'): SharedCatalogItem =>
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

/** A catalog that joined at version 2 of three: it offers 2 (kept) and 3 (current), never 1. */
async function world() {
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
  const manifestSigned = await signCatalogManifest(relayCrypto, identity, manifest);
  const listSigned = await signCatalogItemVersions(relayCrypto, identity, list);
  if (!manifestSigned.ok || !listSigned.ok) throw new Error('could not sign');
  const resign = async (changed: SharedCatalogItemVersions) => {
    const again = await signCatalogItemVersions(relayCrypto, identity, changed);
    if (!again.ok) throw new Error(again.reason);
    return again.value;
  };
  return { identity, item, manifest, list, signedManifest: manifestSigned.value, signedList: listSigned.value, resign };
}

const flip = (base64: string): string => {
  const bytes = fromBase64Url(base64) ?? new Uint8Array();
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
  return toBase64Url(bytes);
};

describe('catalog version list signatures', () => {
  it('should verify a list its publisher signed, wherever the copy came from', async () => {
    const { signedList, list } = await world();
    const copy = JSON.parse(JSON.stringify(signedList)) as SignedCatalogItemVersions;
    const result = await verifySignedCatalogItemVersions(relayCrypto, copy);
    should(result).match({ ok: true });
    should(result.ok && result.value).deepEqual(list);
  });

  it('should sign the version-list label, a zero byte and the SHA-256 of the canonical JSON', async () => {
    const { signedList } = await world();
    const canonical = catalogCanonicalText(signedList.versions);
    if (!canonical.ok) throw new Error(canonical.reason);
    const message = catalogVersionsSignedBytes(await relayCrypto.sha256(utf8Bytes(canonical.text)));
    const spki = fromBase64Url(signedList.spki) ?? new Uint8Array();
    const sig = fromBase64Url(signedList.sig) ?? new Uint8Array();
    should(await relayCrypto.verifyEd25519(spki, sig, message)).be.true();
    should(CATALOG_VERSIONS_SIGNATURE_LABEL).equal('ferretry-catalog-versions-v1');
    should([...message.slice(0, CATALOG_VERSIONS_SIGNATURE_LABEL.length + 1)]).deepEqual([
      ...utf8Bytes(CATALOG_VERSIONS_SIGNATURE_LABEL),
      0,
    ]);
  });

  it('should never let a manifest signature verify as a version list, or the reverse', async () => {
    const { signedList, signedManifest, manifest } = await world();
    const asList = { versions: signedList.versions, spki: signedManifest.spki, sig: signedManifest.sig };
    should(await verifySignedCatalogItemVersions(relayCrypto, asList)).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    const asManifest = { manifest, spki: signedList.spki, sig: signedList.sig };
    should(await verifySignedCatalogManifest(relayCrypto, asManifest)).match({
      ok: false,
      refusal: 'signature_invalid',
    });
  });

  it('should refuse a signature under another label, and the bare digest', async () => {
    const { identity, list } = await world();
    const canonical = catalogCanonicalText(list);
    if (!canonical.ok) throw new Error(canonical.reason);
    const digest = await relayCrypto.sha256(utf8Bytes(canonical.text));
    for (const label of ['ferretry-catalog-manifest-v1', 'ferretry-catalog-versions-v2', '']) {
      const sig = await relayCrypto.signEd25519(
        identity.privateKey,
        new Uint8Array([...utf8Bytes(label), 0, ...digest]),
      );
      const result = await verifySignedCatalogItemVersions(relayCrypto, {
        versions: list,
        spki: toBase64Url(identity.publicKeySpki),
        sig: toBase64Url(sig),
      });
      should(result.ok).be.false();
    }
    const bare = await relayCrypto.signEd25519(identity.privateKey, digest);
    should(
      (
        await verifySignedCatalogItemVersions(relayCrypto, {
          versions: list,
          spki: toBase64Url(identity.publicKeySpki),
          sig: toBase64Url(bare),
        })
      ).ok,
    ).be.false();
  });

  it('should refuse a list changed after signing, a flipped signature, a flipped key, and a key that is not the publisher', async () => {
    const { signedList } = await world();
    const changed = { ...signedList, versions: { ...signedList.versions, revision: 5 } };
    for (const bad of [
      changed,
      { ...signedList, sig: flip(signedList.sig) },
      { ...signedList, spki: flip(signedList.spki) },
    ])
      should(await verifySignedCatalogItemVersions(relayCrypto, bad)).match({
        ok: false,
        refusal: 'signature_invalid',
      });
    const other = await newDaemonIdentity();
    const foreign = await signCatalogItemVersions(relayCrypto, other, {
      ...signedList.versions,
      publisher: other.daemonId,
    });
    if (!foreign.ok) throw new Error(foreign.reason);
    should(
      await verifySignedCatalogItemVersions(relayCrypto, {
        versions: { ...foreign.value.versions, publisher: signedList.versions.publisher },
        spki: foreign.value.spki,
        sig: foreign.value.sig,
      }),
    ).match({ ok: false, refusal: 'signature_invalid' });
    should(await verifySignedCatalogItemVersions(relayCrypto, { ...signedList, spki: 'short', sig: 'short' })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
  });

  it('should not sign a list that names another publisher, or one its own schema refuses', async () => {
    const { identity, list } = await world();
    const other = await newDaemonIdentity();
    should(await signCatalogItemVersions(relayCrypto, identity, { ...list, publisher: other.daemonId })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    const backwards = { ...list, offered: [...list.offered].reverse() };
    should(await signCatalogItemVersions(relayCrypto, identity, backwards)).match({
      ok: false,
      refusal: 'manifest_invalid',
    });
    should(await signCatalogItemVersions(relayCrypto, identity, { ...list, current: 9 })).match({
      ok: false,
      refusal: 'manifest_invalid',
    });
  });

  it('should neither sign nor verify a list with no one canonical spelling', async () => {
    const { identity, list, signedList } = await world();
    const lone = String.fromCharCode(0xd800);
    const broken = { ...list, offered: list.offered.map(each => ({ ...each, summary: `a${lone}` })) };
    should(await signCatalogItemVersions(relayCrypto, identity, broken)).match({ ok: false, refusal: 'not_canonical' });
    should(await verifySignedCatalogItemVersions(relayCrypto, { ...signedList, versions: broken })).match({
      ok: false,
      refusal: 'not_canonical',
    });
  });
});

describe('an item checked against the manifest and the version list together', () => {
  it('should accept the version the list offers, and answer its line', async () => {
    const { manifest, signedManifest, signedList, item } = await world();
    const result = await verifyCatalogItemAgainstVersions(relayCrypto, manifest, signedManifest.spki, signedList, item);
    should(result.ok && result.value.version).equal(3);
  });

  it('should accept an older version the list offers, and refuse one it does not (a catalog that joined at 2 gets no 1)', async () => {
    const { manifest, signedManifest, signedList, identity } = await world();
    const older = skill(identity.daemonId, 2);
    // Version 2 is offered but is not the bytes the list's digest names, so it is a mismatch, not a pass.
    should(await verifyCatalogItemAgainstVersions(relayCrypto, manifest, signedManifest.spki, signedList, older)).match(
      { ok: false, refusal: 'item_mismatch' },
    );
    const first = skill(identity.daemonId, 1);
    should(await verifyCatalogItemAgainstVersions(relayCrypto, manifest, signedManifest.spki, signedList, first)).match(
      {
        ok: false,
        refusal: 'item_mismatch',
      },
    );
  });

  it('should accept an older offered version whose digest and size are the list’s', async () => {
    const { manifest, signedManifest, identity, list, resign } = await world();
    const older = skill(identity.daemonId, 2, '# older\n');
    const measured = await catalogItemDigest(relayCrypto, older);
    if (measured === null) throw new Error('no form');
    const signed = await resign({
      ...list,
      offered: [{ version: 2, ...measured, publishedAt: AT, summary: 'older' }, ...list.offered.slice(1)],
    });
    const result = await verifyCatalogItemAgainstVersions(relayCrypto, manifest, signedManifest.spki, signed, older);
    should(result.ok && result.value.version).equal(2);
  });

  it('should refuse a list signed by another key, or with a bad signature', async () => {
    const { manifest, signedManifest, signedList, item } = await world();
    const check = (signed: SignedCatalogItemVersions) =>
      verifyCatalogItemAgainstVersions(relayCrypto, manifest, signedManifest.spki, signed, item);
    const other = await newDaemonIdentity();
    const foreign = await signCatalogItemVersions(relayCrypto, other, {
      ...signedList.versions,
      publisher: other.daemonId,
    });
    if (!foreign.ok) throw new Error(foreign.reason);
    should(await check(foreign.value)).match({ ok: false, refusal: 'signature_invalid' });
    should(await check({ ...signedList, sig: flip(signedList.sig) })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
  });

  it('should refuse a list that is not for this manifest’s catalog, item, revision, instant, current or digest', async () => {
    const { manifest, signedManifest, item, resign, list } = await world();
    const check = async (changed: Partial<SharedCatalogItemVersions>) =>
      await verifyCatalogItemAgainstVersions(
        relayCrypto,
        manifest,
        signedManifest.spki,
        await resign({ ...list, ...changed }),
        item,
      );
    const wrongCurrent = { ...list.offered[0] } as SharedCatalogItemVersions['offered'][number];
    for (const changed of [
      { catalogId: `cat_${'d'.repeat(22)}` },
      { itemId: `itm_${'t'.repeat(22)}` },
      { revision: 5 },
      { issuedAt: '2026-11-01T09:00:00.000Z' },
      { current: 2 },
      { offered: [wrongCurrent, { ...(list.offered[1] as typeof wrongCurrent), digest: hex('9') }] },
    ])
      should(await check(changed)).match({ ok: false, refusal: 'item_mismatch' });
  });

  it('should refuse a list for another publisher than the manifest’s', async () => {
    const { manifest, signedManifest, item } = await world();
    const other = await newDaemonIdentity();
    const foreign = await signCatalogItemVersions(relayCrypto, other, {
      format: 'ferretry-catalog-versions',
      version: 1,
      publisher: other.daemonId,
      catalogId: CATALOG,
      itemId: ITEM,
      revision: 4,
      issuedAt: AT,
      current: 3,
      offered: [{ version: 3, digest: hex('a'), size: 1, publishedAt: AT, summary: 's' }],
    });
    if (!foreign.ok) throw new Error(foreign.reason);
    should(
      await verifyCatalogItemAgainstVersions(
        relayCrypto,
        manifest,
        signedManifest.spki,
        { ...foreign.value, spki: signedManifest.spki },
        item,
      ),
    ).match({ ok: false, refusal: 'signature_invalid' });
    should(
      await verifyCatalogItemAgainstVersions(relayCrypto, manifest, foreign.value.spki, foreign.value, item),
    ).match({ ok: false, refusal: 'item_mismatch' });
  });

  it('should refuse an item that is not the list’s item, catalog, publisher, kind, name or harness, or whose bytes changed', async () => {
    const { manifest, signedManifest, signedList, item } = await world();
    const check = (changed: SharedCatalogItem) =>
      verifyCatalogItemAgainstVersions(relayCrypto, manifest, signedManifest.spki, signedList, changed);
    const other = await newDaemonIdentity();
    for (const changed of [
      { ...item, itemId: `itm_${'t'.repeat(22)}` },
      { ...item, catalogId: `cat_${'d'.repeat(22)}` },
      { ...item, publisher: other.daemonId },
      { ...item, name: 'other-name' },
      { ...item, kind: 'mcp' as const },
      { ...item, harness: 'claude' as const },
      skill(item.publisher, 3, '# swapped bytes\n'),
    ])
      should(await check(changed as SharedCatalogItem)).match({ ok: false, refusal: 'item_mismatch' });
  });

  it('should refuse an item with no one canonical spelling', async () => {
    const { manifest, signedManifest, signedList, item } = await world();
    const lone = String.fromCharCode(0xd800);
    should(
      await verifyCatalogItemAgainstVersions(
        relayCrypto,
        manifest,
        signedManifest.spki,
        signedList,
        skill(item.publisher, 3, `# pdf${lone}`),
      ),
    ).match({ ok: false, refusal: 'not_canonical' });
  });

  it('should refuse an item whose size is not the one the list offers', async () => {
    const { manifest, signedManifest, item, list, resign } = await world();
    const signed = await resign({
      ...list,
      offered: list.offered.map(each => (each.version === 3 ? { ...each, size: each.size + 1 } : each)),
    });
    should(await verifyCatalogItemAgainstVersions(relayCrypto, manifest, signedManifest.spki, signed, item)).match({
      ok: false,
      refusal: 'item_mismatch',
    });
  });
});
