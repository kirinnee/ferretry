import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { describe, it } from 'bun:test';

import should from 'should';
import { PushKeysFile } from '../../../../contract/index.ts';
import { StateVapidKeys } from '../../../../daemon/adapters/push/index.ts';
import { expect } from 'bun:test';
import { state as kernelState } from '@ferretry/kernel/host';
import { PushError } from '../../../../daemon/lib/push/index.ts';
async function refused(promise: Promise<unknown>): Promise<PushError> {
  const error = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(PushError);
  return error as PushError;
}

/** A VAPID public key is an uncompressed P-256 point: one tag byte plus two 32-byte coordinates. */
const POINT_BYTES = 65;

/** Access's `state/access/` held in memory, with the kernel store's rules (`format` first, damage reads as damage). */
function fixture(generate?: () => Promise<CryptoKeyPair>) {
  const folder = new MemoryStateFolder();
  const state = folder.port([PushKeysFile]);
  return { folder, state, keys: new StateVapidKeys(state, generate) };
}

describe('StateVapidKeys', () => {
  it('should mint one owner-only pair on first use and answer with the point a browser subscribes with', async () => {
    const { keys, folder } = fixture();

    const publicKey = await keys.publicKey();

    should(Buffer.from(publicKey, 'base64url')).have.length(POINT_BYTES);
    should(Buffer.from(publicKey, 'base64url')[0]).equal(0x04);
    // A private key in a world-readable file is a private key in a backup and in a screen share. The kernel writes
    // the file with the mode Access declared for it.
    should(PushKeysFile.mode).equal(0o600);
    should(PushKeysFile.store).equal('secret');
    // The document holds the signing half, and NOTHING above this adapter can ask for it: the port has
    // no accessor for it, so this assertion is about the file rather than about a reachable value.
    should(JSON.parse(rawSecret(folder) ?? '{}').privateKeyJwk.d).be.a.String();
  });

  it('should answer with the same pair on every later open', async () => {
    const { state, keys } = fixture();

    const minted = await keys.publicKey();
    const reopened = await new StateVapidKeys(state).publicKey();

    // Rotating silently would orphan every subscription already enrolled against the old key, so the
    // pair has to survive both a second read and a restart.
    should(reopened).equal(minted);
    should(await keys.publicKey()).equal(minted);
  });

  it('should mint exactly once under concurrent first use', async () => {
    let generated = 0;
    const { keys } = fixture(async () => {
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
    const { keys } = fixture();
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
    const unparsable = fixture();
    plantSecret(unparsable.folder, '{');
    const wrongShape = fixture();
    plantSecret(wrongShape.folder, JSON.stringify({ format: 1, privateKeyJwk: { kty: 'RSA' } }));
    const badPoint = fixture();
    plantSecret(
      badPoint.folder,
      JSON.stringify({ format: 1, privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'x', x: 'short', y: 'short' } }),
    );
    const coordinate = Buffer.alloc(32, 7).toString('base64url');
    const badScalar = fixture();
    plantSecret(
      badScalar.folder,
      JSON.stringify({
        format: 1,
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
    // Nothing was minted over the damage.
    should(rawSecret(unparsable.folder)).equal('{');
  });
});

it('VAPID secret bytes round-trip through the production StatePort without replacing the key', async () => {
  const fs = kernelState.createMemoryHostFs();
  const state = kernelState.createStatePort({ home: '/fixture', pluginId: 'access', files: [PushKeysFile], fs });
  const keys = new StateVapidKeys(state);
  const first = await keys.publicKey();
  const read = await state.read(PushKeysFile);
  expect(read.ok && read.value instanceof Uint8Array).toBe(true);
  expect(await new StateVapidKeys(state).publicKey()).toBe(first);
  const message = new TextEncoder().encode('fixture-message');
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(Buffer.from(first, 'base64url')),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  expect(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(await keys.sign(message)),
      message,
    ),
  ).toBe(true);
});

it('the state fake rejects object writes to secret files and returns stored bytes unchanged', async () => {
  const { state } = fixture();
  await expect(state.write(PushKeysFile, { format: 1 } as never)).rejects.toThrow('holds bytes');
  const bytes = Uint8Array.of(0xff, 0x00, 0x80);
  await state.write(PushKeysFile, bytes);
  const read = await state.read(PushKeysFile);
  expect(read.ok && read.value).toEqual(bytes);
  await expect(new StateVapidKeys(state).publicKey()).rejects.toMatchObject({ code: 'corrupt_store' });
});

function plantSecret(folder: MemoryStateFolder, text: string): void {
  folder.plantBytes(PushKeysFile, new TextEncoder().encode(text));
}
function rawSecret(folder: MemoryStateFolder): string | undefined {
  const bytes = folder.rawBytes(PushKeysFile);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}
