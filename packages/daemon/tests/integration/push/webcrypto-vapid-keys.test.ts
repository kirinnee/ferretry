import { afterAll, describe, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { StateVapidKeys } from '../../../src/adapters/push/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { refused } from './support.ts';

afterAll(async () => {
  await cleanupTempDirectories();
});

/** A VAPID public key is an uncompressed P-256 point: one tag byte plus two 32-byte coordinates. */
const POINT_BYTES = 65;

async function fixture(label: string) {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.state, 0o700);
  return { paths, files, keys: new StateVapidKeys(paths, files), document: join(paths.state, 'push-vapid.json') };
}

describe('StateVapidKeys', () => {
  it('should mint one owner-only pair on first use and answer with the point a browser subscribes with', async () => {
    const { keys, document } = await fixture('vapid-mint');

    const publicKey = await keys.publicKey();

    should(Buffer.from(publicKey, 'base64url')).have.length(POINT_BYTES);
    should(Buffer.from(publicKey, 'base64url')[0]).equal(0x04);
    // A private key in a world-readable file is a private key in a backup and in a screen share.
    should((await stat(document)).mode & 0o777).equal(0o600);
    // The document holds the signing half, and NOTHING above this adapter can ask for it: the port has
    // no accessor for it, so this assertion is about the file rather than about a reachable value.
    should(JSON.parse((await Bun.file(document).text()) ?? '{}').privateKeyJwk.d).be.a.String();
  });

  it('should answer with the same pair on every later open', async () => {
    const { paths, files, keys } = await fixture('vapid-stable');

    const minted = await keys.publicKey();
    const reopened = await new StateVapidKeys(paths, files).publicKey();

    // Rotating silently would orphan every subscription already enrolled against the old key, so the
    // pair has to survive both a second read and a restart.
    should(reopened).equal(minted);
    should(await keys.publicKey()).equal(minted);
  });

  it('should mint exactly once under concurrent first use', async () => {
    let generated = 0;
    const home = await tempDirectory('vapid-concurrent');
    const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
    const files = new StateFileSystem(paths);
    await files.ensureDirectory(paths.state, 0o700);
    const keys = new StateVapidKeys(paths, files, async () => {
      generated += 1;
      return await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    });

    const [first, second, third] = await Promise.all([keys.publicKey(), keys.publicKey(), keys.publicKey()]);

    // Two enrolments arriving together must not each mint a pair: the loser's subscription would be
    // registered against a key this daemon had already thrown away.
    should(generated).equal(1);
    should([second, third]).deepEqual([first, first]);
  });

  it('should sign a verifiable ES256 signature with the stored key and nothing else', async () => {
    const { keys } = await fixture('vapid-sign');
    const message = new TextEncoder().encode('header.claims');

    const signature = await keys.sign(message);

    // A JWS carries the raw r||s pair, not a DER structure: 64 bytes exactly, or every push service
    // rejects the token.
    should(signature).have.length(64);
    const point = Buffer.from(await keys.publicKey(), 'base64url');
    const verifier = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(point),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    should(
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, new Uint8Array(signature), message),
    ).be.true();
  });

  it('should refuse a damaged key rather than minting a replacement', async () => {
    const unparsable = await fixture('vapid-unparsable');
    await unparsable.files.writeTextAtomic(unparsable.document, '{');
    const wrongShape = await fixture('vapid-shape');
    await wrongShape.files.writeTextAtomic(
      wrongShape.document,
      JSON.stringify({ schemaVersion: 1, privateKeyJwk: { kty: 'RSA' } }),
    );
    const badPoint = await fixture('vapid-point');
    await badPoint.files.writeTextAtomic(
      badPoint.document,
      JSON.stringify({ schemaVersion: 1, privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'x', x: 'short', y: 'short' } }),
    );
    const coordinate = Buffer.alloc(32, 7).toString('base64url');
    const badScalar = await fixture('vapid-scalar');
    await badScalar.files.writeTextAtomic(
      badScalar.document,
      JSON.stringify({
        schemaVersion: 1,
        privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'not-a-scalar', x: coordinate, y: coordinate },
      }),
    );

    // Treating an unreadable key as absent would mint a fresh pair and silently break every phone
    // already enrolled — a fleet of devices that stop being reachable with nothing reporting a fault.
    should((await refused(unparsable.keys.publicKey())).code).equal('corrupt_store');
    should((await refused(wrongShape.keys.publicKey())).code).equal('corrupt_store');
    should((await refused(badPoint.keys.publicKey())).code).equal('corrupt_store');
    // A document whose coordinates are the right SIZE but whose scalar the curve refuses is damage in
    // the same sense: a signing key this daemon cannot sign with.
    should((await refused(badScalar.keys.publicKey())).code).equal('corrupt_store');
  });
});
