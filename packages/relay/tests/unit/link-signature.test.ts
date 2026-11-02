import { describe, it } from 'bun:test';
import {
  CATALOG_LINK_SIGNATURE_LABEL,
  CATALOG_MANIFEST_SIGNATURE_LABEL,
  CATALOG_VERSIONS_SIGNATURE_LABEL,
  fromBase64Url,
  LINK_CLOCK_SKEW_MS,
  signCatalogLink,
  toBase64Url,
  utf8Bytes,
  verifyLinkBundle,
  verifySignedCatalogItemVersions,
  verifySignedCatalogManifest,
} from '@ferretry/relay';
import {
  catalogCanonicalText,
  catalogLinkSignedBytes,
  type SharedCatalogLink,
  type SharedCatalogLinkBundle,
  type SharedCatalogManifest,
  SharedCatalogManifestSchema,
} from '@ferretry/protocol';
import should from 'should';
import { relayCrypto } from '../support/identities.ts';
import { LINK_AT, LINK_NOT_AFTER, linkSkill, linkWorld } from '../support/links.ts';

type World = Awaited<ReturnType<typeof linkWorld>>;

const expectedOf = (world: World, now?: Date) => ({
  publisher: world.link.publisher,
  bundleId: world.link.bundleId,
  sequence: world.link.sequence,
  ...(now === undefined ? {} : { now }),
});

const flip = (base64: string): string => {
  const bytes = fromBase64Url(base64) ?? new Uint8Array();
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
  return toBase64Url(bytes);
};

const clone = (bundle: SharedCatalogLinkBundle): SharedCatalogLinkBundle =>
  JSON.parse(JSON.stringify(bundle)) as SharedCatalogLinkBundle;

const withLink = (bundle: SharedCatalogLinkBundle, changes: Partial<SharedCatalogLink>): SharedCatalogLinkBundle => ({
  ...bundle,
  signedLink: { ...bundle.signedLink, link: { ...bundle.signedLink.link, ...changes } },
});

describe('signing a link', () => {
  it('should sign the link label, a zero byte and the SHA-256 of the canonical JSON', async () => {
    const world = await linkWorld();
    const canonical = catalogCanonicalText(world.link);
    if (!canonical.ok) throw new Error(canonical.reason);
    const message = catalogLinkSignedBytes(await relayCrypto.sha256(utf8Bytes(canonical.text)));
    const spki = fromBase64Url(world.signed.spki) ?? new Uint8Array();
    const sig = fromBase64Url(world.signed.sig) ?? new Uint8Array();
    should(await relayCrypto.verifyEd25519(spki, sig, message)).be.true();
    should(CATALOG_LINK_SIGNATURE_LABEL).equal('ferretry-catalog-link-v1');
    should([...message.slice(0, CATALOG_LINK_SIGNATURE_LABEL.length + 1)]).deepEqual([
      ...utf8Bytes(CATALOG_LINK_SIGNATURE_LABEL),
      0,
    ]);
  });

  it('should refuse to sign for another machine, or a document the schema refuses', async () => {
    const world = await linkWorld();
    const other = await linkWorld();
    should(await signCatalogLink(relayCrypto, other.identity, world.link)).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    const unsound = { ...world.link, notAfter: LINK_AT };
    should(await signCatalogLink(relayCrypto, world.identity, unsound)).match({
      ok: false,
      refusal: 'manifest_invalid',
    });
    should(await signCatalogLink(relayCrypto, world.identity, { ...world.link, kind: 'bad' as never })).match({
      ok: false,
      refusal: 'manifest_invalid',
    });
  });

  it('should refuse to sign a document with no one canonical spelling', async () => {
    const world = await linkWorld();
    const lone = String.fromCharCode(0xd800);
    const result = await signCatalogLink(relayCrypto, world.identity, {
      ...world.link,
      publisherName: `a${lone}`,
    });
    should(result.ok).be.false();
  });
});

describe('verifying a link bundle', () => {
  it('should accept a bundle its publisher signed, wherever the copy came from', async () => {
    const world = await linkWorld();
    const result = await verifyLinkBundle(relayCrypto, clone(world.bundle), expectedOf(world));
    should(result).match({ ok: true });
    should(result.ok && result.value.link).deepEqual(world.link);
    should(result.ok && result.value.item).deepEqual(world.item);
  });

  it('should refuse a signature, a key or a document that was changed after signing', async () => {
    const world = await linkWorld();
    const other = await linkWorld();
    const bundles = [
      { ...world.bundle, signedLink: { ...world.bundle.signedLink, sig: flip(world.bundle.signedLink.sig) } },
      { ...world.bundle, signedLink: { ...world.bundle.signedLink, spki: flip(world.bundle.signedLink.spki) } },
      { ...world.bundle, signedLink: { ...world.bundle.signedLink, spki: other.bundle.signedLink.spki } },
      { ...world.bundle, signedLink: { ...world.bundle.signedLink, sig: 'AAAA' } },
      { ...world.bundle, signedLink: { ...world.bundle.signedLink, spki: 'AAAA' } },
    ];
    for (const bundle of bundles)
      should(await verifyLinkBundle(relayCrypto, bundle, expectedOf(world))).match({
        ok: false,
        refusal: 'signature_invalid',
      });
  });

  it('should refuse every field of the signed document changed after signing', async () => {
    const world = await linkWorld();
    const changes: Partial<SharedCatalogLink>[] = [
      { publisherName: 'someone-else' },
      { linkId: `lnk_${'b'.repeat(22)}` },
      { kind: 'one-time', sequence: 1, expiresAt: LINK_NOT_AFTER },
      { issuedAt: '2026-10-31T09:00:01.000Z' },
      { notAfter: '2026-11-07T09:00:01.000Z' },
      { expiresAt: LINK_NOT_AFTER },
      { item: { ...world.link.item, name: 'other' } },
      { item: { ...world.link.item, summary: 'other' } },
      { item: { ...world.link.item, version: 9 } },
      { item: { ...world.link.item, size: world.link.item.size + 1 } },
    ];
    for (const change of changes) {
      const result = await verifyLinkBundle(relayCrypto, withLink(world.bundle, change), expectedOf(world));
      should(result).match({ ok: false, refusal: 'signature_invalid' });
    }
    // A changed publisher no longer hashes to the key that signed.
    const stranger = await linkWorld();
    should(
      await verifyLinkBundle(
        relayCrypto,
        withLink(world.bundle, { publisher: stranger.link.publisher }),
        expectedOf(world),
      ),
    ).match({ ok: false, refusal: 'signature_invalid' });
  });

  it('should refuse a signed document with no one canonical spelling', async () => {
    const world = await linkWorld();
    const lone = String.fromCharCode(0xd800);
    const result = await verifyLinkBundle(
      relayCrypto,
      withLink(world.bundle, { publisherName: `a${lone}` }),
      expectedOf(world),
    );
    should(result).match({ ok: false, refusal: 'not_canonical' });
  });

  it('should refuse a genuine link that is not the one the address names', async () => {
    const world = await linkWorld();
    const stranger = await linkWorld();
    const wrongs = [
      { ...expectedOf(world), publisher: stranger.link.publisher },
      { ...expectedOf(world), bundleId: stranger.link.bundleId },
      { ...expectedOf(world), sequence: 2 },
    ];
    for (const expected of wrongs)
      should(await verifyLinkBundle(relayCrypto, world.bundle, expected)).match({
        ok: false,
        refusal: 'link_mismatch',
      });
  });

  it('should refuse an item that is not the one the signed document describes', async () => {
    const world = await linkWorld();
    const items = [
      { ...world.item, publisher: (await linkWorld()).link.publisher },
      { ...world.item, catalogId: `cat_${'c'.repeat(22)}` },
      { ...world.item, itemId: `itm_${'t'.repeat(22)}` },
      { ...world.item, itemVersion: 4 },
      { ...world.item, name: 'other-name' },
      { ...world.item, summary: 'Another summary' },
      { ...world.item, harness: 'claude' },
      { ...linkSkill(world.link.publisher, '# changed\n') },
    ] as SharedCatalogLinkBundle['item'][];
    for (const item of items)
      should(await verifyLinkBundle(relayCrypto, { ...world.bundle, item }, expectedOf(world))).match({
        ok: false,
        refusal: 'item_mismatch',
      });
  });

  it('should refuse an item with no one canonical spelling', async () => {
    const world = await linkWorld();
    const lone = String.fromCharCode(0xd800);
    const item = { ...world.item, skill: { files: [{ path: 'SKILL.md', content: `a${lone}` }] } };
    should(await verifyLinkBundle(relayCrypto, { ...world.bundle, item }, expectedOf(world))).match({
      ok: false,
      refusal: 'not_canonical',
    });
  });

  it('should refuse a copy past its end, with five minutes of skew', async () => {
    const world = await linkWorld();
    const end = Date.parse(LINK_NOT_AFTER);
    should(LINK_CLOCK_SKEW_MS).equal(5 * 60 * 1000);
    should(await verifyLinkBundle(relayCrypto, world.bundle, expectedOf(world, new Date(end)))).match({ ok: true });
    should(
      await verifyLinkBundle(relayCrypto, world.bundle, expectedOf(world, new Date(end + LINK_CLOCK_SKEW_MS))),
    ).match({ ok: true });
    should(
      await verifyLinkBundle(relayCrypto, world.bundle, expectedOf(world, new Date(end + LINK_CLOCK_SKEW_MS + 1))),
    ).match({ ok: false, refusal: 'link_stale' });
    should(await verifyLinkBundle(relayCrypto, world.bundle, expectedOf(world))).match({ ok: true });
  });

  it('should check the signature before it says anything about staleness or mismatch', async () => {
    const world = await linkWorld();
    const forged = {
      ...world.bundle,
      signedLink: { ...world.bundle.signedLink, sig: flip(world.bundle.signedLink.sig) },
    };
    const result = await verifyLinkBundle(relayCrypto, forged, {
      ...expectedOf(world, new Date('2030-01-01T00:00:00.000Z')),
      sequence: 9,
    });
    should(result).match({ ok: false, refusal: 'signature_invalid' });
  });
});

describe('the three signature labels', () => {
  const labels = [
    ['link', CATALOG_LINK_SIGNATURE_LABEL],
    ['manifest', CATALOG_MANIFEST_SIGNATURE_LABEL],
    ['versions', CATALOG_VERSIONS_SIGNATURE_LABEL],
  ] as const;

  async function documents() {
    const world = await linkWorld();
    const manifest: SharedCatalogManifest = SharedCatalogManifestSchema.parse({
      format: 'ferretry-catalog-manifest',
      version: 1,
      publisher: world.identity.daemonId,
      publisherName: 'kirin-box',
      catalogId: `cat_${'c'.repeat(22)}`,
      name: 'Skills',
      description: '',
      visibility: 'members',
      revision: 4,
      issuedAt: LINK_AT,
      items: [world.link.item],
      withdrawn: [],
    });
    const versions = {
      format: 'ferretry-catalog-versions',
      version: 1,
      publisher: world.identity.daemonId,
      catalogId: `cat_${'c'.repeat(22)}`,
      itemId: world.link.item.itemId,
      revision: 4,
      issuedAt: LINK_AT,
      current: 3,
      offered: [
        {
          version: 3,
          digest: world.link.item.digest,
          size: world.link.item.size,
          publishedAt: LINK_AT,
          summary: world.link.item.summary,
        },
      ],
    };
    return { world, documents: { link: world.link, manifest, versions } };
  }

  async function signUnder(label: string, document: unknown, world: World): Promise<{ spki: string; sig: string }> {
    const canonical = catalogCanonicalText(document);
    if (!canonical.ok) throw new Error(canonical.reason);
    const digest = await relayCrypto.sha256(utf8Bytes(canonical.text));
    const sig = await relayCrypto.signEd25519(
      world.identity.privateKey,
      new Uint8Array([...utf8Bytes(label), 0, ...digest]),
    );
    return { spki: toBase64Url(world.identity.publicKeySpki), sig: toBase64Url(sig) };
  }

  async function refuses(target: string, document: unknown, world: World, parts: { spki: string; sig: string }) {
    if (target === 'link') {
      const result = await verifyLinkBundle(
        relayCrypto,
        { ...world.bundle, signedLink: { link: document as SharedCatalogLink, ...parts } },
        expectedOf(world),
      );
      return !result.ok;
    }
    if (target === 'manifest') {
      const result = await verifySignedCatalogManifest(relayCrypto, { manifest: document as never, ...parts });
      return !result.ok;
    }
    const result = await verifySignedCatalogItemVersions(relayCrypto, { versions: document as never, ...parts });
    return !result.ok;
  }

  it('should accept each document under its own label (control)', async () => {
    const { world, documents: docs } = await documents();
    for (const [target, label] of labels)
      should(await refuses(target, docs[target], world, await signUnder(label, docs[target], world))).be.false();
  });

  it('should refuse every document signed under either of the other two labels (six pairs)', async () => {
    const { world, documents: docs } = await documents();
    let pairs = 0;
    for (const [target, own] of labels)
      for (const [, other] of labels) {
        if (other === own) continue;
        should(await refuses(target, docs[target], world, await signUnder(other, docs[target], world))).be.true();
        pairs += 1;
      }
    should(pairs).equal(6);
  });
});
