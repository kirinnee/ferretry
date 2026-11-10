/**
 * The daemon's signing through its signer port (`relay-wire/signatures.ts`): it hands the canonical bytes to the
 * identity's signer and never holds a key. What the signer returns is checked before it is trusted.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CatalogSigningIdentity,
  signCatalogItemVersions,
  signCatalogLink,
  signCatalogManifest,
  signLinkStoreRequest,
} from '../../../daemon/lib/relay-wire/index.ts';
import { world, LONE } from '../../support/daemon-catalog-world.ts';
import { linkWorld } from '../../support/worker/links.ts';
import { newDaemonIdentity, relayCrypto } from '../../support/worker/identities.ts';

const bytes = (fill: number) => Uint8Array.from({ length: 32 }, () => fill);

/** A signer port over a real daemon identity's key, recording what it was asked to sign. */
async function portOver(daemonId?: string): Promise<{ identity: CatalogSigningIdentity; asked: string[] }> {
  const held = await newDaemonIdentity();
  const asked: string[] = [];
  const id = daemonId ?? held.daemonId;
  const identity: CatalogSigningIdentity = {
    daemonId: id,
    signer: {
      async signCatalog({ kind, canonical }) {
        asked.push(kind);
        const message = new Uint8Array([...new TextEncoder().encode(`label-${kind}`), 0, ...canonical]);
        const signature = await relayCrypto.signEd25519(held.privateKey, message);
        return { daemonId: id, publicKey: 'spki', signature: Buffer.from(signature).toString('base64url') };
      },
    },
  };
  return { identity, asked };
}

describe('signing a catalog document through the signer port', () => {
  it('signs a manifest and a version list as the identity, handing the signer their canonical bytes', async () => {
    const { manifest, list } = await world();
    const { identity, asked } = await portOver(manifest.publisher);
    const manifestSigned = await signCatalogManifest(relayCrypto, identity, manifest);
    const listSigned = await signCatalogItemVersions(relayCrypto, identity, list);
    should(manifestSigned.ok && manifestSigned.value.manifest).deepEqual(manifest);
    should(listSigned.ok && listSigned.value.versions).deepEqual(list);
    should(asked).eql(['manifest', 'versions']);
  });

  it('signs a link for the identity that publishes it', async () => {
    const links = await linkWorld();
    const { identity, asked } = await portOver();
    const link = { ...links.link, publisher: identity.daemonId };
    const signed = await signCatalogLink(relayCrypto, identity, link);
    should(signed).match({ ok: true });
    should(signed.ok && signed.value.link).deepEqual(link);
    should(asked).eql(['link']);
  });

  it('refuses a document the schema refuses, so it never signs what every reader rejects', async () => {
    const { manifest, list } = await world();
    const links = await linkWorld();
    const { identity } = await portOver();
    should(await signCatalogManifest(relayCrypto, identity, { ...manifest, note: 'x' } as never)).match({
      ok: false,
      refusal: 'manifest_invalid',
    });
    should(await signCatalogItemVersions(relayCrypto, identity, { ...list, current: 0 } as never)).match({
      ok: false,
      refusal: 'manifest_invalid',
    });
    should(await signCatalogLink(relayCrypto, identity, { ...links.link, kind: 'bad' } as never)).match({
      ok: false,
      refusal: 'manifest_invalid',
    });
  });

  it('refuses a document that names another publisher', async () => {
    const { manifest, list } = await world();
    const links = await linkWorld();
    const { identity, asked } = await portOver();
    should(await signCatalogManifest(relayCrypto, identity, manifest)).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    should(await signCatalogItemVersions(relayCrypto, identity, list)).match({
      ok: false,
      refusal: 'signature_invalid',
    });
    should(await signCatalogLink(relayCrypto, identity, links.link)).match({ ok: false, refusal: 'signature_invalid' });
    should(asked).eql([]);
  });

  it('refuses a document with no one canonical spelling', async () => {
    const { manifest, list } = await world();
    const links = await linkWorld();
    const { identity: manifestIdentity } = await portOver(manifest.publisher);
    should(await signCatalogManifest(relayCrypto, manifestIdentity, { ...manifest, description: `a${LONE}` })).match({
      ok: false,
      refusal: 'not_canonical',
    });
    should(
      await signCatalogItemVersions(relayCrypto, manifestIdentity, {
        ...list,
        offered: [{ ...list.offered[0]!, summary: `a${LONE}` }, ...list.offered.slice(1)],
      }),
    ).match({ ok: false, refusal: 'not_canonical' });
    const { identity: linkIdentity } = await portOver(links.link.publisher);
    should(await signCatalogLink(relayCrypto, linkIdentity, { ...links.link, publisherName: `a${LONE}` })).match({
      ok: false,
      refusal: 'not_canonical',
    });
  });

  it('refuses a signature from a signer that answers as another identity', async () => {
    const { manifest, list } = await world();
    const links = await linkWorld();
    for (const [identity, sign] of [
      [{ daemonId: manifest.publisher }, (i: CatalogSigningIdentity) => signCatalogManifest(relayCrypto, i, manifest)],
      [{ daemonId: list.publisher }, (i: CatalogSigningIdentity) => signCatalogItemVersions(relayCrypto, i, list)],
      [{ daemonId: links.link.publisher }, (i: CatalogSigningIdentity) => signCatalogLink(relayCrypto, i, links.link)],
    ] as const) {
      const imposter: CatalogSigningIdentity = {
        ...identity,
        signer: { signCatalog: async () => ({ daemonId: 'someone-else', publicKey: 'k', signature: 's' }) },
      };
      should(await sign(imposter)).match({ ok: false, reason: 'This machine signs only for itself.' });
    }
  });
});

describe('signing a link-store request through the signer port', () => {
  const context = (daemonId: string) => ({
    daemonId,
    host: 'link.example.test',
    nonce: bytes(7),
    body: { request: 'delete' as const, bundleId: 'b' },
  });

  it('asks the signer for the request and answers its signature with the nonce spelled out', async () => {
    const seen: unknown[] = [];
    const identity: CatalogSigningIdentity = {
      daemonId: 'fy_daemon_a',
      signer: {
        signCatalog: async () => ({ daemonId: 'fy_daemon_a', publicKey: 'k', signature: 's' }),
        signLinkStoreRequest: async input => {
          seen.push(input);
          return { daemonId: 'fy_daemon_a', publicKey: 'k', signature: 's' };
        },
      },
    };
    const signed = await signLinkStoreRequest(relayCrypto, identity, context('fy_daemon_a'));
    should(signed).eql({
      daemonId: 'fy_daemon_a',
      publicKey: 'k',
      signature: 's',
      nonce: Buffer.from(bytes(7)).toString('base64url'),
    });
    should(seen).have.length(1);
  });

  it('refuses to sign for another machine', async () => {
    const identity: CatalogSigningIdentity = { daemonId: 'fy_daemon_a', signer: { signCatalog: async () => never() } };
    await signLinkStoreRequest(relayCrypto, identity, context('fy_daemon_b')).should.be.rejectedWith(
      'A machine signs only its own link-store requests.',
    );
  });

  it('says so when the signer has no link-store signing', async () => {
    const identity: CatalogSigningIdentity = { daemonId: 'fy_daemon_a', signer: { signCatalog: async () => never() } };
    await signLinkStoreRequest(relayCrypto, identity, context('fy_daemon_a')).should.be.rejectedWith(
      'The link-store request signer is unavailable.',
    );
  });

  it('refuses a signer that answers as another identity', async () => {
    const identity: CatalogSigningIdentity = {
      daemonId: 'fy_daemon_a',
      signer: {
        signCatalog: async () => never(),
        signLinkStoreRequest: async () => ({ daemonId: 'fy_daemon_b', publicKey: 'k', signature: 's' }),
      },
    };
    await signLinkStoreRequest(relayCrypto, identity, context('fy_daemon_a')).should.be.rejectedWith(
      'The link-store request signer changed identity.',
    );
  });
});

function never(): never {
  throw new Error('the signer must not be asked');
}
