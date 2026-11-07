import { expect, it } from 'bun:test';
import {
  CLAIM_SIGNATURE_LABEL,
  RELAY_PROTOCOL_ID,
  claimContextForChallenge,
  claimTranscript,
  signRendezvousClaim,
  signingKey,
  utf8Text,
  verifyRendezvousClaim,
} from '../../../worker/src/lib/index.ts';
import { newDaemonIdentity, relayCrypto } from '../../support/worker/identities.ts';

it('R46 a claim signs the exact label and length-prefixed protocol, fingerprint, host and nonce', async () => {
  const identity = await newDaemonIdentity();
  const nonce = new Uint8Array(32).fill(7);
  const context = { daemonId: identity.daemonId, relayHost: 'relay.example', challenge: nonce };
  const transcript = claimTranscript(context);
  expect(utf8Text(transcript.subarray(0, CLAIM_SIGNATURE_LABEL.length))).toBe(CLAIM_SIGNATURE_LABEL);
  let offset = CLAIM_SIGNATURE_LABEL.length;
  const fields: Uint8Array[] = [];
  while (offset < transcript.length) {
    const length = new DataView(transcript.buffer, transcript.byteOffset + offset, 4).getUint32(0, false);
    offset += 4;
    fields.push(transcript.subarray(offset, offset + length));
    offset += length;
  }
  expect(fields.slice(0, 3).map(field => utf8Text(field))).toEqual([
    RELAY_PROTOCOL_ID,
    identity.daemonId,
    'relay.example',
  ]);
  expect(fields[3]).toEqual(nonce);
  const claim = await signRendezvousClaim(signingKey(relayCrypto, identity), context);
  expect((await verifyRendezvousClaim(relayCrypto, context, claim)).ok).toBe(true);
});
it('R48 a foreign challenge host is refused before any identity signs it', async () => {
  const identity = await newDaemonIdentity();
  const nonce = new Uint8Array(32).fill(7);
  expect(claimContextForChallenge(identity.daemonId, 'relay.example', 'hostile.example', nonce)).toBeNull();
  const context = claimContextForChallenge(identity.daemonId, 'relay.example', 'relay.example', nonce);
  if (context === null) throw new Error('matching host was refused');
  const claim = await signRendezvousClaim(signingKey(relayCrypto, identity), context);
  expect((await verifyRendezvousClaim(relayCrypto, { ...context, relayHost: 'hostile.example' }, claim)).ok).toBe(
    false,
  );
});
