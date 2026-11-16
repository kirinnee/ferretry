/**
 * The app's copy of the catalog verifiers (`app/lib/catalog-signature.ts`): the subscriber's browser checks a catalog
 * before it shows anything, so every way a document can fail to hold is refused HERE too, with the same refusal and
 * sentence the daemon's copy gives (relay-wire-verify.test.ts drives that one).
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
} from '../../../app/lib/catalog-signature.ts';
import type { SharedCatalogFile, SharedCatalogItem, SharedCatalogItemVersions } from '../../../contract/wire/index.ts';
import { signCatalogItemVersions, signCatalogManifest } from '../../support/catalog-crypto.ts';
import { flip, hex, LONE, skill, world } from '../../support/daemon-catalog-world.ts';
import { newDaemonIdentity, relayCrypto } from '../../support/worker/identities.ts';

describe('app copy: catalog manifest verification', () => {
  it('verifies a manifest its publisher signed, and a whole file whose items it lists', async () => {
    const { signedManifest, manifest, item } = await world();
    const file: SharedCatalogFile = {
      format: 'ferretry-catalog-file',
      version: 1,
      exportedAt: manifest.issuedAt,
      signedManifest,
      items: [item],
    };
    const checked = await verifySignedCatalogManifest(relayCrypto, JSON.parse(JSON.stringify(signedManifest)));
    should(checked.ok && checked.value).deepEqual(manifest);
    should(await verifySharedCatalogFile(relayCrypto, file)).match({ ok: true });
  });

  it('refuses a key that does not hash to the publisher the manifest names, in the words of an unsigned catalog', async () => {
    const { signedManifest } = await world();
    const stranger = await newDaemonIdentity();
    const strangerSigned = await signCatalogManifest(relayCrypto, stranger, {
      ...signedManifest.manifest,
      publisher: stranger.daemonId,
    });
    if (!strangerSigned.ok) throw new Error(strangerSigned.reason);
    // The stranger signed a manifest that names the stranger; presenting it as the original publisher's changes nothing.
    should(
      await verifySignedCatalogManifest(relayCrypto, { ...strangerSigned.value, manifest: signedManifest.manifest }),
    ).match({
      ok: false,
      refusal: 'signature_invalid',
      reason: 'This catalog was not signed by the machine it names.',
    });
    should(await verifySignedCatalogManifest(relayCrypto, { ...signedManifest, sig: flip(signedManifest.sig) })).match({
      ok: false,
      refusal: 'signature_invalid',
    });
  });

  it('refuses a manifest with no one canonical spelling, and says why', async () => {
    const { signedManifest } = await world();
    should(
      await verifySignedCatalogManifest(relayCrypto, {
        ...signedManifest,
        manifest: { ...signedManifest.manifest, description: `a${LONE}` },
      }),
    ).match({
      ok: false,
      refusal: 'not_canonical',
      reason: 'This catalog has no one canonical spelling, so it cannot be checked.',
    });
  });
});

describe('app copy: catalog item verification', () => {
  it('refuses an item the manifest does not list, and an item with no one canonical spelling', async () => {
    const { signedManifest, item } = await world();
    should(await verifyCatalogItem(relayCrypto, signedManifest.manifest, item)).match({ ok: true });
    should(
      await verifyCatalogItem(relayCrypto, signedManifest.manifest, skill(item.publisher, 3, '# pdf tools\nmore\n')),
    ).match({ ok: false, refusal: 'item_mismatch' });
    const broken = skill(item.publisher, 3, `# pdf${LONE}`);
    should(await catalogItemDigest(relayCrypto, broken)).be.null();
    should(await catalogItemCanonical(relayCrypto, broken)).be.null();
    should(await verifyCatalogItem(relayCrypto, signedManifest.manifest, broken)).match({
      ok: false,
      refusal: 'not_canonical',
      reason: 'pdf-tools has no one canonical spelling, so it cannot be checked.',
    });
  });
});

describe('app copy: version list verification', () => {
  it('refuses a key that does not hash to the publisher the list names', async () => {
    const { signedList } = await world();
    const stranger = await newDaemonIdentity();
    const strangers = await signCatalogItemVersions(relayCrypto, stranger, {
      ...signedList.versions,
      publisher: stranger.daemonId,
    });
    if (!strangers.ok) throw new Error(strangers.reason);
    should(
      await verifySignedCatalogItemVersions(relayCrypto, { ...strangers.value, versions: signedList.versions }),
    ).match({
      ok: false,
      refusal: 'signature_invalid',
      reason: 'This version list was not signed by the machine it names.',
    });
  });

  it('refuses a list with no one canonical spelling', async () => {
    const { signedList } = await world();
    const broken = { ...signedList.versions, offered: [{ ...signedList.versions.offered[0]!, summary: `a${LONE}` }] };
    should(await verifySignedCatalogItemVersions(relayCrypto, { ...signedList, versions: broken })).match({
      ok: false,
      refusal: 'not_canonical',
      reason: 'This version list has no one canonical spelling, so it cannot be checked.',
    });
  });
});

describe('app copy: item against its version list', () => {
  it('offers the version the list names for the item', async () => {
    const { signedManifest, signedList, item } = await world();
    const result = await verifyCatalogItemAgainstVersions(
      relayCrypto,
      signedManifest.manifest,
      signedManifest.spki,
      signedList,
      item,
    );
    should(result.ok && result.value.version).equal(3);
  });

  it('refuses a list signed by another key than the manifest', async () => {
    const { signedManifest, signedList, item } = await world();
    should(
      await verifyCatalogItemAgainstVersions(relayCrypto, signedManifest.manifest, 'someone-else', signedList, item),
    ).match({
      ok: false,
      refusal: 'signature_invalid',
      reason: 'This version list was not signed by the machine that signed the catalog.',
    });
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

  it('refuses an item the list does not offer, one that differs from the offered copy, and one with no canonical spelling', async () => {
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
    should(await check(skill(item.publisher, 3, `# pdf${LONE}`))).match({
      ok: false,
      refusal: 'not_canonical',
    });
  });
});
