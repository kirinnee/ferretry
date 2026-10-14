import { describe, it } from 'bun:test';
import {
  AppSessionSchema,
  DeviceKeySchema,
  DeviceProofSchema,
  deviceAuthMessage,
  deviceKeyBytes,
  devicePairMessage,
  deviceRenewMessage,
  deviceRotateMessage,
  RenewNonceSchema,
  signDeviceProof,
  toBase64Url,
  verifyDeviceProof,
} from '@ferretry/relay';
import should from 'should';
import { relayCrypto } from '../support/identities.ts';

const transcript = new Uint8Array(32).fill(7);
const otherTranscript = new Uint8Array(32).fill(8);

async function deviceKey() {
  const generated = await relayCrypto.generateDeviceKey();
  return {
    publicKey: toBase64Url(generated.publicKeySpki),
    handle: relayCrypto.deviceKeyHandle(generated.privateKey),
  };
}

describe('device proof', () => {
  it('should verify a session proof only for the transcript, kind, device and app session it signed', async () => {
    const key = await deviceKey();
    const message = deviceAuthMessage(transcript, 'auth', 'fy_device_id_one', 'app-one');
    const proof = await signDeviceProof(relayCrypto, key.handle, message);
    should(DeviceProofSchema.safeParse(proof).success).be.true();
    should(await verifyDeviceProof(relayCrypto, key.publicKey, proof, message)).be.true();
    for (const other of [
      deviceAuthMessage(otherTranscript, 'auth', 'fy_device_id_one', 'app-one'),
      deviceAuthMessage(transcript, 'stream', 'fy_device_id_one', 'app-one'),
      deviceAuthMessage(transcript, 'auth', 'fy_device_id_two', 'app-one'),
      deviceAuthMessage(transcript, 'auth', 'fy_device_id_one', 'app-two'),
    ])
      should(await verifyDeviceProof(relayCrypto, key.publicKey, proof, other)).be.false();
  });

  it('should keep the three acts apart, so no proof stands in for another', async () => {
    const key = await deviceKey();
    const pair = devicePairMessage(transcript, key.publicKey);
    const renew = deviceRenewMessage(transcript, key.publicKey);
    const auth = deviceAuthMessage(transcript, 'auth', key.publicKey, '');
    const proof = await signDeviceProof(relayCrypto, key.handle, pair);
    should(await verifyDeviceProof(relayCrypto, key.publicKey, proof, pair)).be.true();
    should(await verifyDeviceProof(relayCrypto, key.publicKey, proof, renew)).be.false();
    should(await verifyDeviceProof(relayCrypto, key.publicKey, proof, auth)).be.false();
  });

  it("should refuse another device's key, and malformed keys or proofs, without throwing", async () => {
    const key = await deviceKey();
    const stranger = await deviceKey();
    const message = deviceRenewMessage(transcript, 'nonce');
    const proof = await signDeviceProof(relayCrypto, key.handle, message);
    should(await verifyDeviceProof(relayCrypto, stranger.publicKey, proof, message)).be.false();
    should(await verifyDeviceProof(relayCrypto, 'not-a-key', proof, message)).be.false();
    should(await verifyDeviceProof(relayCrypto, key.publicKey, 'not-a-proof', message)).be.false();
  });

  it('should read only an Ed25519 public key as a device key', async () => {
    const key = await deviceKey();
    should(DeviceKeySchema.safeParse(key.publicKey).success).be.true();
    should(deviceKeyBytes(key.publicKey)?.byteLength).equal(44);
    const notEd25519 = toBase64Url(new Uint8Array(44).fill(1));
    should(deviceKeyBytes(notEd25519)).be.null();
    should(DeviceKeySchema.safeParse(notEd25519).success).be.false();
    should(deviceKeyBytes('short')).be.null();
  });

  it('should bound the app session and the renewal nonce to their declared widths', () => {
    should(AppSessionSchema.safeParse(toBase64Url(new Uint8Array(16))).success).be.true();
    should(AppSessionSchema.safeParse(toBase64Url(new Uint8Array(17))).success).be.false();
    should(RenewNonceSchema.safeParse(toBase64Url(new Uint8Array(32))).success).be.true();
    should(RenewNonceSchema.safeParse('x').success).be.false();
  });
});

describe('device key rotation proof', () => {
  it('should verify only for the transcript, device and new key it signed, and never as another act', async () => {
    const replacement = await deviceKey();
    const message = deviceRotateMessage(transcript, 'fy_device_id_one', replacement.publicKey);
    const proof = await signDeviceProof(relayCrypto, replacement.handle, message);
    should(await verifyDeviceProof(relayCrypto, replacement.publicKey, proof, message)).be.true();
    for (const other of [
      deviceRotateMessage(otherTranscript, 'fy_device_id_one', replacement.publicKey),
      deviceRotateMessage(transcript, 'fy_device_id_two', replacement.publicKey),
      deviceRotateMessage(transcript, 'fy_device_id_one', (await deviceKey()).publicKey),
      devicePairMessage(transcript, replacement.publicKey),
    ])
      should(await verifyDeviceProof(relayCrypto, replacement.publicKey, proof, other)).be.false();
  });
});
