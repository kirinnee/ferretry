/**
 * The daemon's own copy of the catalog verifiers (`relay-wire/catalog-wire/catalog-signature.ts`), driven the
 * way the daemon drives it: documents signed by a publisher's identity (the worker copy signs with a held key; the
 * daemon signs through its signer port, proved in relay-wire-signatures.test.ts) and checked here.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  catalogItemCanonical,
  catalogItemDigest,
  verifyCatalogItem,
  verifyCatalogItemAgainstVersions,
  verifySharedCatalogFile,
  verifySignedCatalogItemVersions,
  verifySignedCatalogManifest,
} from '../../../daemon/lib/relay-wire/index.ts';
import type { SharedCatalogFile, SharedCatalogItem, SharedCatalogItemVersions } from '../../../contract/wire/index.ts';
import { signCatalogItemVersions, signCatalogManifest } from '../../support/catalog-crypto.ts';
import { AT, flip, hex, LONE, skill, world } from '../../support/daemon-catalog-world.ts';
import { newDaemonIdentity, relayCrypto } from '../../support/worker/identities.ts';

describe('daemon copy: catalog manifest verification', () => {
  it('verifies a manifest its publisher signed', async () => {
    const { signedManifest, manifest } = await world();
    const result = await verifySignedCatalogManifest(relayCrypto, JSON.parse(JSON.stringify(signedManifest)));
    should(result).match({ ok: true });
    should(result.ok && result.value).deepEqual(manifest);
  });

  it('refuses a key or signature that is not the size it must be', async () => {
    const { signedManifest } = await world();
    should(await verifySignedCatalogManifest(relayCrypto, { ...signedManifest, spki: 'AAAA' })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    should(await verifySignedCatalogManifest(relayCrypto, { ...signedManifest, sig: 'AAAA' })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
  });

  it('refuses a key that does not hash to the publisher the manifest names, and a changed manifest or bit', async () => {
    const { signedManifest, sign } = await world();
    const stranger = await newDaemonIdentity();
    const strangerSigned = await signCatalogManifest(relayCrypto, stranger, {
      ...signedManifest.manifest,
      publisher: stranger.daemonId,
    });
    if (!strangerSigned.ok) throw new Error(strangerSigned.reason);
    should(
      await verifySignedCatalogManifest(relayCrypto, {
        ...strangerSigned.value,
        manifest: { ...signedManifest.manifest },
      }),
    ).match({ ok: false, refusal: 'signature_invalid' });
    for (const changed of [
      { ...signedManifest, manifest: { ...signedManifest.manifest, name: 'Anthropic official skills' } },
      { ...signedManifest, sig: flip(signedManifest.sig) },
    ])
      should(await verifySignedCatalogManifest(relayCrypto, changed)).match({
        ok: false,
        reason: 'This catalog was not signed by the machine it names.',
      });
    should((await sign(signedManifest.manifest)).sig).be.a.String();
  });

  it('refuses a manifest with no one canonical spelling, and says why', async () => {
    const { signedManifest } = await world();
    should(
      await verifySignedCatalogManifest(relayCrypto, {
        ...signedManifest,
        manifest: { ...signedManifest.manifest, description: `a${LONE}` },
      }),
    ).match({ ok: false, refusal: 'not_canonical' });
  });
});

describe('daemon copy: catalog item verification', () => {
  it('accepts the item the manifest lists', async () => {
    const { signedManifest, item } = await world();
    should(await verifyCatalogItem(relayCrypto, signedManifest.manifest, item)).match({ ok: true });
  });

  it('refuses one changed byte, and an item the manifest does not list', async () => {
    const { signedManifest, item } = await world();
    should(
      await verifyCatalogItem(relayCrypto, signedManifest.manifest, skill(item.publisher, 3, '# pdf tools\nmore\n')),
    ).match({ ok: false, refusal: 'item_mismatch' });
    should(
      await verifyCatalogItem(relayCrypto, signedManifest.manifest, { ...item, itemId: `itm_${'x'.repeat(22)}` }),
    ).match({ ok: false, refusal: 'item_mismatch' });
  });

  it('refuses an item with no one canonical spelling', async () => {
    const { signedManifest, item } = await world();
    const broken = skill(item.publisher, 3, `# pdf${LONE}`);
    should(await catalogItemDigest(relayCrypto, broken)).be.null();
    should(await catalogItemCanonical(relayCrypto, broken)).be.null();
    should(await verifyCatalogItem(relayCrypto, signedManifest.manifest, broken)).match({
      ok: false,
      refusal: 'not_canonical',
    });
  });

  it('verifies a whole file, and refuses one whose manifest or item does not hold', async () => {
    const { signedManifest, item } = await world();
    const file: SharedCatalogFile = {
      format: 'ferretry-catalog-file',
      version: 1,
      exportedAt: AT,
      signedManifest,
      items: [item],
    };
    should(await verifySharedCatalogFile(relayCrypto, file)).match({ ok: true });
    should(
      await verifySharedCatalogFile(relayCrypto, { ...file, items: [skill(item.publisher, 3, '# evil\n')] }),
    ).match({
      ok: false,
      refusal: 'item_mismatch',
    });
    should(
      await verifySharedCatalogFile(relayCrypto, {
        ...file,
        signedManifest: { ...signedManifest, sig: flip(signedManifest.sig) },
      }),
    ).match({ ok: false, refusal: 'signature_invalid' });
  });
});

describe('daemon copy: version list verification', () => {
  it('verifies a list its publisher signed', async () => {
    const { signedList, list } = await world();
    const result = await verifySignedCatalogItemVersions(relayCrypto, JSON.parse(JSON.stringify(signedList)));
    should(result.ok && result.value).deepEqual(list);
  });

  it('refuses a key or signature of the wrong size, a stranger key, a flipped bit and a manifest signature', async () => {
    const { signedList, signedManifest, identity } = await world();
    should(await verifySignedCatalogItemVersions(relayCrypto, { ...signedList, spki: 'AAAA' })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    should(await verifySignedCatalogItemVersions(relayCrypto, { ...signedList, sig: 'AAAA' })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    const stranger = await newDaemonIdentity();
    const strangers = await signCatalogItemVersions(relayCrypto, stranger, {
      ...signedList.versions,
      publisher: stranger.daemonId,
    });
    if (!strangers.ok) throw new Error(strangers.reason);
    should(
      await verifySignedCatalogItemVersions(relayCrypto, { ...strangers.value, versions: signedList.versions }),
    ).match({ ok: false, refusal: 'signature_invalid' });
    should(await verifySignedCatalogItemVersions(relayCrypto, { ...signedList, sig: flip(signedList.sig) })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    should(
      await verifySignedCatalogItemVersions(relayCrypto, {
        versions: signedList.versions,
        spki: signedManifest.spki,
        sig: signedManifest.sig,
      }),
    ).match({ ok: false, refusal: 'signature_invalid' });
    should(identity.daemonId).equal(signedList.versions.publisher);
  });

  it('refuses a list with no one canonical spelling', async () => {
    const { signedList } = await world();
    const broken = { ...signedList.versions, offered: [{ ...signedList.versions.offered[0]!, summary: `a${LONE}` }] };
    should(await verifySignedCatalogItemVersions(relayCrypto, { ...signedList, versions: broken })).match({
      ok: false,
      refusal: 'not_canonical',
    });
  });
});

describe('daemon copy: item against its version list', () => {
  it('offers the version the list names for the item', async () => {
    const { signedManifest, signedList, item } = await world();
    const result = await verifyCatalogItemAgainstVersions(
      relayCrypto,
      signedManifest.manifest,
      signedManifest.spki,
      signedList,
      item,
    );
    should(result).match({ ok: true });
    should(result.ok && result.value.version).equal(3);
  });

  it('refuses a list signed by another key than the manifest', async () => {
    const { signedManifest, signedList, item } = await world();
    should(
      await verifyCatalogItemAgainstVersions(relayCrypto, signedManifest.manifest, 'someone-else', signedList, item),
    ).match({ ok: false, refusal: 'signature_invalid' });
  });

  it('refuses a list that does not verify', async () => {
    const { signedManifest, signedList, item } = await world();
    should(
      await verifyCatalogItemAgainstVersions(
        relayCrypto,
        signedManifest.manifest,
        signedManifest.spki,
        { ...signedList, sig: flip(signedList.sig) },
        item,
      ),
    ).match({ ok: false, refusal: 'signature_invalid' });
  });

  it('refuses a list that does not agree with the manifest it goes with', async () => {
    const { signedManifest, signedList, signList, item } = await world();
    const against = async (changed: SharedCatalogItemVersions) =>
      verifyCatalogItemAgainstVersions(
        relayCrypto,
        signedManifest.manifest,
        signedManifest.spki,
        await signList(changed),
        item,
      );
    const { versions } = signedList;
    const current = versions.offered[1]!;
    for (const changed of [
      { ...versions, revision: 5 },
      { ...versions, itemId: `itm_${'q'.repeat(22)}` },
      { ...versions, current: 2 },
      { ...versions, offered: [versions.offered[0]!, { ...current, digest: hex('9') }] },
      { ...versions, offered: [versions.offered[0]!, { ...current, size: current.size + 1 }] },
      { ...versions, offered: [versions.offered[0]!, { ...current, summary: 'changed' }] },
    ])
      should(await against(changed)).match({ ok: false, refusal: 'item_mismatch' });
  });

  it('refuses an item the list does not offer, or one that differs from the offered copy', async () => {
    const { signedManifest, signedList, item } = await world();
    const check = (candidate: SharedCatalogItem) =>
      verifyCatalogItemAgainstVersions(
        relayCrypto,
        signedManifest.manifest,
        signedManifest.spki,
        signedList,
        candidate,
      );
    should(await check({ ...item, itemVersion: 1 })).match({ ok: false, refusal: 'item_mismatch' });
    should(await check({ ...item, name: 'other-name' })).match({ ok: false, refusal: 'item_mismatch' });
    should(await check({ ...item, summary: 'Something else' })).match({ ok: false, refusal: 'item_mismatch' });
    should(await check(skill(item.publisher, 3, '# pdf tools\nmore\n'))).match({
      ok: false,
      refusal: 'item_mismatch',
    });
  });

  it('refuses an offered item with no one canonical spelling', async () => {
    const { signedManifest, signedList, item } = await world();
    should(
      await verifyCatalogItemAgainstVersions(
        relayCrypto,
        signedManifest.manifest,
        signedManifest.spki,
        signedList,
        skill(item.publisher, 3, `# pdf${LONE}`),
      ),
    ).match({ ok: false, refusal: 'not_canonical' });
  });
});
