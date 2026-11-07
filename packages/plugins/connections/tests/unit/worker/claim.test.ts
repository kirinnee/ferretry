import { expect, it } from 'bun:test';
import {
  CLAIM_SIGNATURE_LABEL,
  CONNECTION_RATE_LIMIT,
  initialRendezvousState,
  reduceRendezvous,
  SESSION_CLOSE_CODES,
  sessionIdFromBytes,
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

/** A fixture session id: the rendezvous mints these for real arrivals. */
function sessionOf(fill: number) {
  const id = sessionIdFromBytes(new Uint8Array(16).fill(fill));
  if (id === null) throw new Error('fixture session id');
  return id;
}

/** A real claim for `identity`, plus the context it was signed for. */
async function realClaim(identity: Awaited<ReturnType<typeof newDaemonIdentity>>, daemonId = identity.daemonId) {
  const context = { daemonId, relayHost: 'relay.example', challenge: new Uint8Array(32).fill(7) };
  return { context, claim: await signRendezvousClaim(signingKey(relayCrypto, identity), context) };
}

/** What the rendezvous does with a verdict: a socket that arrived for `daemonId`, then the verdict. */
function settle(daemonId: string, verdict: Awaited<ReturnType<typeof verifyRendezvousClaim>>) {
  const arrived = reduceRendezvous(initialRendezvousState(daemonId), {
    kind: 'daemon-arrived',
    socketId: 'daemon',
    challenge: new Uint8Array(32).fill(7),
    host: 'relay.example',
    at: 1_000,
  });
  return reduceRendezvous(arrived.state, { kind: 'claim-verdict', socketId: 'daemon', verdict, at: 1_100 });
}

it('R47 a claim holds the rendezvous only when the key hashes to the path daemonId AND its signature verifies', async () => {
  const owner = await newDaemonIdentity();
  const other = await newDaemonIdentity();

  // Both halves good: accepted, and the rendezvous hands over the slot.
  const good = await realClaim(owner);
  const accepted = await verifyRendezvousClaim(relayCrypto, good.context, good.claim);
  expect(accepted.ok).toBe(true);
  expect(settle(owner.daemonId, accepted).state.daemon?.socketId).toBe('daemon');

  // A valid signature by a key whose hash is NOT the path's daemonId: the fingerprint half refuses it.
  const wrongKey = await realClaim(other, owner.daemonId);
  expect(await verifyRendezvousClaim(relayCrypto, wrongKey.context, wrongKey.claim)).toEqual({
    ok: false,
    reason: 'public key does not match the rendezvous fingerprint',
  });

  // The right key with a signature over another challenge: the signature half refuses it.
  const stale = await signRendezvousClaim(signingKey(relayCrypto, owner), {
    ...good.context,
    challenge: new Uint8Array(32).fill(8),
  });
  const unsigned = await verifyRendezvousClaim(relayCrypto, good.context, stale);
  expect(unsigned).toEqual({ ok: false, reason: 'claim signature failed' });
  const refused = settle(owner.daemonId, unsigned);
  expect(refused.effects.flatMap(effect => (effect.kind === 'close' ? [effect.code] : []))).toEqual([
    SESSION_CLOSE_CODES.claimRejected,
  ]);
  expect(refused.state.daemon).toBeNull();
});

it('R125 someone who knows a listed fingerprint cannot claim it without its key, and their attempts are rate-bounded', async () => {
  const listed = await newDaemonIdentity();
  const attacker = await newDaemonIdentity();
  const context = { daemonId: listed.daemonId, relayHost: 'relay.example', challenge: new Uint8Array(32).fill(7) };

  // Their own key, honestly signed, presented for the listed fingerprint.
  const ownKey = await signRendezvousClaim(signingKey(relayCrypto, attacker), context);
  // The listed key (public, from any QR) with a signature only their own key could make.
  const borrowedKey = { publicKeySpki: listed.publicKeySpki, signature: ownKey.signature };
  for (const forged of [ownKey, borrowedKey]) {
    const verdict = await verifyRendezvousClaim(relayCrypto, context, forged);
    expect(verdict.ok).toBe(false);
    const step = settle(listed.daemonId, verdict);
    expect(step.state.daemon).toBeNull();
    expect(
      step.effects.some(effect => effect.kind === 'close' && effect.code === SESSION_CLOSE_CODES.claimRejected),
    ).toBe(true);
  }

  // Every attempt is an arrival, and arrivals past the §9 window are refused before any verification is asked.
  let state = initialRendezvousState(listed.daemonId);
  for (let index = 0; index < CONNECTION_RATE_LIMIT; index += 1)
    state = reduceRendezvous(state, {
      kind: 'client-arrived',
      socketId: `probe-${index}`,
      sessionId: sessionOf(index + 1),
      at: 1_000 + index,
    }).state;
  const limited = reduceRendezvous(state, {
    kind: 'client-arrived',
    socketId: 'probe-last',
    sessionId: sessionOf(250),
    at: 1_100,
  });
  expect(limited.effects.some(effect => effect.kind === 'verify-claim')).toBe(false);
  expect(limited.effects.flatMap(effect => (effect.kind === 'close' ? [effect.reason] : [])).join(' ')).toMatch(
    /too many connections/u,
  );
});
