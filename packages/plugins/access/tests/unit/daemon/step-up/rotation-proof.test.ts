import { describe, it } from 'bun:test';
import should from 'should';
import { concatBytes, lengthPrefixed, toBase64Url, utf8Bytes } from '../../../../daemon/lib/proof/binary.ts';
import {
  deviceRotateMessage,
  type Ed25519Verifier,
  verifyDeviceProof,
} from '../../../../daemon/lib/proof/device-proof.ts';

/**
 * THE ROTATION PROOF (`docs/relay-protocol.md`, `docs/design/zero-trust.md` B6): the NEW device key signs
 * `"ferretry-device-rotate-v2" ‖ 0x00 ‖ TH ‖ LP(deviceId) ‖ LP(deviceKey)` inside a session the OLD key opened. Real
 * WebCrypto Ed25519 keys sign here (the daemon copies only the verify side), so a verdict is a verdict on bytes.
 */

const webCrypto: Ed25519Verifier = {
  verifyEd25519: async (spki, signature, message) => {
    try {
      const key = await crypto.subtle.importKey('spki', new Uint8Array(spki), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), new Uint8Array(message));
    } catch {
      return false;
    }
  },
};

async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const sign = async (message: Uint8Array) =>
    toBase64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, new Uint8Array(message))));
  return { key: toBase64Url(spki), sign };
}

const deviceId = `fy_device_id_${'a'.repeat(22)}`;
const otherDevice = `fy_device_id_${'b'.repeat(22)}`;
const transcript = new Uint8Array(32).fill(1);
const otherTranscript = new Uint8Array(32).fill(2);

describe('the key-rotation proof', () => {
  it('R249 should be signed by the new key over one session and one device, and over nothing else', async () => {
    // Arrange
    const old = await deviceKey();
    const next = await deviceKey();
    const proof = await next.sign(deviceRotateMessage(transcript, deviceId, next.key));

    // Act
    const verdicts = [
      await verifyDeviceProof(webCrypto, next.key, proof, deviceRotateMessage(transcript, deviceId, next.key)),
      // another session's transcript
      await verifyDeviceProof(webCrypto, next.key, proof, deviceRotateMessage(otherTranscript, deviceId, next.key)),
      // another device
      await verifyDeviceProof(webCrypto, next.key, proof, deviceRotateMessage(transcript, otherDevice, next.key)),
      // the old key's signature over the same bytes proves nothing about the new key's holder
      await verifyDeviceProof(
        webCrypto,
        next.key,
        await old.sign(deviceRotateMessage(transcript, deviceId, next.key)),
        deviceRotateMessage(transcript, deviceId, next.key),
      ),
      // malformed inputs are false, never thrown
      await verifyDeviceProof(webCrypto, 'not-a-key', proof, deviceRotateMessage(transcript, deviceId, next.key)),
      await verifyDeviceProof(webCrypto, next.key, 'AA', deviceRotateMessage(transcript, deviceId, next.key)),
    ];

    // Assert
    should(verdicts).deepEqual([true, false, false, false, false, false]);
  });

  it('should lay the message out byte for byte as the protocol names it', async () => {
    // Arrange
    const next = await deviceKey();

    // Act
    const message = deviceRotateMessage(transcript, deviceId, next.key);

    // Assert
    should(
      Buffer.from(message).equals(
        Buffer.from(
          concatBytes([
            utf8Bytes('ferretry-device-rotate-v2'),
            new Uint8Array([0]),
            transcript,
            lengthPrefixed(utf8Bytes(deviceId)),
            lengthPrefixed(utf8Bytes(next.key)),
          ]),
        ),
      ),
    ).be.true();
  });
});
