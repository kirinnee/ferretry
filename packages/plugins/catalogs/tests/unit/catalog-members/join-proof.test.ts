import { describe, it } from 'bun:test';
import {
  MAX_JOIN_PROOF_PASSKEYS,
  MAX_PASSKEYS_PER_DEVICE,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  type MemberJoinProof,
} from '../../../daemon/lib/boundary.ts';
import { toBase64Url } from '../../../daemon/lib/relay-wire/index.ts';
import should from 'should';
import {
  type JoinProofDeps,
  type JoinProofSubject,
  MemberJoinProver,
} from '../../../daemon/lib/catalog-members/join-proof.ts';
import type { PasskeyVerifierPort, StoredPasskey } from '../../support/member-passkeys.ts';
import { keyId, memberId, shareId, T0 } from './support.ts';

const ORIGIN = 'https://app.ferretry.test';
const OTHER_ORIGIN = 'https://other.ferretry.test';
const TTL_MS = PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;

const credentialOf = (n: number): string => toBase64Url(new Uint8Array(16).fill(n));
const spkiOf = (n: number): string => toBase64Url(new Uint8Array(32).fill(n));

const passkey = (n: number, owner: number, overrides: Partial<StoredPasskey> = {}): StoredPasskey => ({
  credentialId: credentialOf(n),
  deviceId: keyId(owner),
  algorithm: -7,
  publicKeySpki: spkiOf(n),
  signCount: 5,
  origin: ORIGIN,
  createdAt: '2026-03-01T00:00:00.000Z',
  ...overrides,
});

const subject = (n = 1, who = 1, key = 1): JoinProofSubject => ({
  shareId: shareId(n),
  memberId: memberId(who),
  memberKey: `key-${String(key)}`,
});

const assertionFor = (n: number, overrides: Partial<MemberJoinProof> = {}): MemberJoinProof => ({
  credentialId: credentialOf(n),
  clientDataJSON: toBase64Url(new Uint8Array([1, 2, 3])),
  authenticatorData: toBase64Url(new Uint8Array([4, 5, 6])),
  signature: toBase64Url(new Uint8Array([7, 8, 9])),
  ...overrides,
});

type AssertionInput = Parameters<PasskeyVerifierPort['verifyAssertion']>[0];

function rig(owned: Record<string, readonly StoredPasskey[]> = { [memberId(1)]: [passkey(1, 1)] }) {
  const state = {
    now: T0,
    verdict: { ok: true, signCount: 6, origin: ORIGIN } as
      | { ok: true; signCount: number; origin: string }
      | { ok: false; reason: string },
    signCountMoves: true,
    verifierThrows: false,
    passkeysThrow: false,
    origins: [ORIGIN] as readonly string[],
    owned,
    verified: [] as AssertionInput[],
    counted: [] as { deviceId: string; credentialId: string; signCount: number }[],
    randomCalls: 0,
  };
  const deps: JoinProofDeps = {
    passkeysOf: async id => {
      if (state.passkeysThrow) throw new Error('store is down');
      return state.owned[id] ?? [];
    },
    store: {
      updateSignCount: async (deviceId, credentialId, signCount) => {
        state.counted.push({ deviceId, credentialId, signCount });
        return state.signCountMoves;
      },
    },
    verifier: {
      verifyRegistration: async () => ({ ok: false, reason: 'unused' }),
      verifyAssertion: async input => {
        state.verified.push(input);
        if (state.verifierThrows) throw new Error('verifier blew up');
        return state.verdict;
      },
    },
    random: {
      bytes: length => {
        state.randomCalls += 1;
        const bytes = new Uint8Array(length).fill(9);
        bytes[0] = (state.randomCalls >> 8) & 255;
        bytes[1] = state.randomCalls & 255;
        return bytes;
      },
    },
    clock: { nowMs: () => state.now },
    allowedOrigins: () => state.origins,
  };
  return { prover: new MemberJoinProver(deps), state };
}

describe('MemberJoinProver.options', () => {
  it('R609 should offer a fresh challenge and every passkey of the person made at the page, and no other', async () => {
    const { prover, state } = rig({
      [memberId(1)]: [passkey(1, 1), passkey(2, 2), passkey(3, 2, { origin: OTHER_ORIGIN })],
      [memberId(2)]: [passkey(4, 3)],
    });

    const options = await prover.options(subject(), ORIGIN);

    should(options?.allowCredentials).eql([
      { type: 'public-key', id: credentialOf(1) },
      { type: 'public-key', id: credentialOf(2) },
    ]);
    should(options?.rpId).equal('app.ferretry.test');
    should(options?.timeout).equal(TTL_MS);
    should(options?.challenge.length).be.above(0);
    should(prover.held).equal(1);
    should(state.randomCalls).equal(1);
  });

  it('R609 should offer up to the join-proof cap, so a person with several browsers is not shut out', async () => {
    const many = Array.from({ length: MAX_JOIN_PROOF_PASSKEYS + 3 }, (_, index) => passkey(index + 1, 1));
    const { prover } = rig({ [memberId(1)]: many });

    const options = await prover.options(subject(), ORIGIN);

    should(options?.allowCredentials.length).equal(MAX_JOIN_PROOF_PASSKEYS);
    should(MAX_JOIN_PROOF_PASSKEYS).be.above(MAX_PASSKEYS_PER_DEVICE);
  });

  it('R609 should offer the newest passkeys first, so one made on a newer browser is offered past the cap', async () => {
    const old = Array.from({ length: MAX_JOIN_PROOF_PASSKEYS }, (_, index) =>
      passkey(index + 1, 1, { createdAt: '2026-03-01T00:00:00.000Z' }),
    );
    const newer = passkey(200, 9, { createdAt: '2026-06-01T00:00:00.000Z' });
    const { prover } = rig({ [memberId(1)]: [...old, newer] });

    const options = await prover.options(subject(), ORIGIN);

    should(options?.allowCredentials.length).equal(MAX_JOIN_PROOF_PASSKEYS);
    should(options?.allowCredentials[0]).eql({ type: 'public-key', id: credentialOf(200) });
    should(options?.allowCredentials.map(entry => entry.id)).not.containEql(credentialOf(MAX_JOIN_PROOF_PASSKEYS));
  });

  it('R609 should stop at the size budget for very long credential ids, keeping the newest that fit', async () => {
    const longId = (n: number): string => toBase64Url(new Uint8Array(750).fill(n));
    const long = Array.from({ length: 20 }, (_, index) =>
      passkey(index + 1, 1, {
        credentialId: longId(index + 1),
        createdAt: new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString(),
      }),
    );
    const { prover } = rig({ [memberId(1)]: long });

    const options = await prover.options(subject(), ORIGIN);

    const offered = options?.allowCredentials ?? [];
    should(offered.length).be.above(0).and.below(20);
    should(offered.reduce((sum, entry) => sum + entry.id.length, 0)).be.belowOrEqual(12 * 1024);
    should(offered[0]?.id).equal(longId(20));
  });

  it('R609 should give a different challenge every time', async () => {
    const { prover } = rig();

    const first = await prover.options(subject(), ORIGIN);
    const second = await prover.options(subject(), ORIGIN);

    should(first?.challenge).not.equal(second?.challenge);
    should(prover.held).equal(1);
  });

  it('R609 should offer nothing for an origin this machine does not serve, and keep nothing', async () => {
    const { prover, state } = rig({ [memberId(1)]: [passkey(1, 1, { origin: OTHER_ORIGIN })] });

    should(await prover.options(subject(), OTHER_ORIGIN)).be.undefined();
    should(prover.held).equal(0);
    should(state.randomCalls).equal(0);
  });

  it('R609 should offer nothing when the person has no passkey made at this page', async () => {
    const { prover, state } = rig({ [memberId(1)]: [passkey(1, 1, { origin: OTHER_ORIGIN })] });
    state.origins = [ORIGIN, OTHER_ORIGIN];

    should(await prover.options(subject(), ORIGIN)).be.undefined();
    should(prover.held).equal(0);
  });

  it('R609 should offer nothing for a person who is gone', async () => {
    const { prover } = rig({});

    should(await prover.options(subject(), ORIGIN)).be.undefined();
  });
});

describe('MemberJoinProver.verify', () => {
  it('R609 should accept the person’s passkey signing the challenge issued to this share and key', async () => {
    const { prover, state } = rig();
    const options = await prover.options(subject(), ORIGIN);

    should(await prover.verify(subject(), assertionFor(1))).be.true();

    should(state.verified.length).equal(1);
    should(toBase64Url(state.verified[0]?.expectedChallenge ?? new Uint8Array())).equal(options?.challenge);
    should(state.verified[0]?.allowedOrigins).eql([ORIGIN]);
    should(state.verified[0]?.credential).eql({
      algorithm: -7,
      publicKeySpki: new Uint8Array(32).fill(1),
      signCount: 5,
    });
    should(state.counted).eql([{ deviceId: keyId(1), credentialId: credentialOf(1), signCount: 6 }]);
  });

  it('R609 should accept any one of the person’s passkeys, on any of their browsers', async () => {
    const { prover, state } = rig({ [memberId(1)]: [passkey(1, 1), passkey(2, 2)] });
    await prover.options(subject(), ORIGIN);

    should(await prover.verify(subject(), assertionFor(2))).be.true();
    should(state.counted[0]?.deviceId).equal(keyId(2));
  });

  it('R609 should refuse when no challenge was issued, and say nothing to the verifier', async () => {
    const { prover, state } = rig();

    should(await prover.verify(subject(), assertionFor(1))).be.false();
    should(state.verified).eql([]);
  });

  it('R609 should refuse a replay: the challenge is spent by the first try', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);

    should(await prover.verify(subject(), assertionFor(1))).be.true();
    should(await prover.verify(subject(), assertionFor(1))).be.false();
    should(state.verified.length).equal(1);
    should(prover.held).equal(0);
  });

  it('R609 should spend the challenge even when the assertion is wrong', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);
    state.verdict = { ok: false, reason: 'bad signature' };

    should(await prover.verify(subject(), assertionFor(1))).be.false();
    state.verdict = { ok: true, signCount: 6, origin: ORIGIN };
    should(await prover.verify(subject(), assertionFor(1))).be.false();
    should(prover.held).equal(0);
  });

  it('R609 should refuse an expired challenge', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);
    state.now += TTL_MS;

    should(await prover.verify(subject(), assertionFor(1))).be.false();
    should(state.verified).eql([]);
  });

  it('R609 should accept a challenge one millisecond before it expires', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);
    state.now += TTL_MS - 1;

    should(await prover.verify(subject(), assertionFor(1))).be.true();
  });

  it('R609 should bind the challenge to the share', async () => {
    const { prover, state } = rig();
    await prover.options(subject(1), ORIGIN);

    should(await prover.verify(subject(2), assertionFor(1))).be.false();
    should(state.verified).eql([]);
  });

  it('R609 should bind the challenge to the browser key that asked', async () => {
    const { prover, state } = rig();
    await prover.options(subject(1, 1, 1), ORIGIN);

    should(await prover.verify(subject(1, 1, 2), assertionFor(1))).be.false();
    should(state.verified).eql([]);
  });

  it('R609 should bind the challenge to the person it was issued for', async () => {
    const { prover, state } = rig({ [memberId(1)]: [passkey(1, 1)], [memberId(2)]: [passkey(2, 2)] });
    await prover.options(subject(1, 1), ORIGIN);

    should(await prover.verify(subject(1, 2), assertionFor(2))).be.false();
    should(state.verified).eql([]);
  });

  it('R609 should refuse another person’s credential', async () => {
    const { prover, state } = rig({ [memberId(1)]: [passkey(1, 1)], [memberId(2)]: [passkey(2, 2)] });
    await prover.options(subject(), ORIGIN);

    should(await prover.verify(subject(), assertionFor(2))).be.false();
    should(state.verified).eql([]);
    should(state.counted).eql([]);
  });

  it('R609 should refuse a credential made at another origin than the one the challenge was issued for', async () => {
    const { prover, state } = rig({ [memberId(1)]: [passkey(1, 1), passkey(2, 1, { origin: OTHER_ORIGIN })] });
    state.origins = [ORIGIN, OTHER_ORIGIN];
    await prover.options(subject(), ORIGIN);

    should(await prover.verify(subject(), assertionFor(2))).be.false();
    should(state.verified).eql([]);
  });

  it('R609 should refuse a credential of a person whose passkeys are gone', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);
    state.owned = {};

    should(await prover.verify(subject(), assertionFor(1))).be.false();
    should(state.verified).eql([]);
  });

  it('R609 should refuse bytes that are not base64url, whichever field carries them', async () => {
    for (const field of ['clientDataJSON', 'authenticatorData', 'signature'] as const) {
      const { prover, state } = rig();
      await prover.options(subject(), ORIGIN);

      should(await prover.verify(subject(), assertionFor(1, { [field]: '!!not base64!!' }))).be.false();
      should(state.verified).eql([]);
    }
  });

  it('R609 should refuse when the stored public key cannot be read', async () => {
    const { prover, state } = rig({ [memberId(1)]: [passkey(1, 1, { publicKeySpki: '!!' })] });
    await prover.options(subject(), ORIGIN);

    should(await prover.verify(subject(), assertionFor(1))).be.false();
    should(state.verified).eql([]);
  });

  it('R609 should refuse when the verifier says no, and not count the signature', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);
    state.verdict = { ok: false, reason: 'user verification missing' };

    should(await prover.verify(subject(), assertionFor(1))).be.false();
    should(state.counted).eql([]);
  });

  it('R609 should refuse a signature counter that did not move forward', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);
    state.signCountMoves = false;

    should(await prover.verify(subject(), assertionFor(1))).be.false();
    should(state.counted.length).equal(1);
  });

  it('R609 should refuse, not throw, when the verifier throws', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);
    state.verifierThrows = true;

    should(await prover.verify(subject(), assertionFor(1))).be.false();
  });

  it('R609 should refuse, not throw, when the passkeys cannot be read', async () => {
    const { prover, state } = rig();
    await prover.options(subject(), ORIGIN);
    state.passkeysThrow = true;

    should(await prover.verify(subject(), assertionFor(1))).be.false();
  });
});

describe('the challenges held', () => {
  it('R609 should let a new ask for the same share and key replace the old challenge', async () => {
    const { prover } = rig();
    await prover.options(subject(), ORIGIN);
    await prover.options(subject(), ORIGIN);

    should(prover.held).equal(1);
    should(await prover.verify(subject(), assertionFor(1))).be.true();
  });

  it('R609 should forget challenges that have lapsed when the next one is issued', async () => {
    const { prover, state } = rig();
    await prover.options(subject(1, 1, 1), ORIGIN);
    await prover.options(subject(1, 1, 2), ORIGIN);
    should(prover.held).equal(2);

    state.now += TTL_MS;
    await prover.options(subject(2, 1, 1), ORIGIN);

    should(prover.held).equal(1);
  });

  it('R609 should hold 16 for one share and push out that share’s oldest, never another share’s', async () => {
    const { prover } = rig();
    await prover.options(subject(9, 1, 1), ORIGIN);
    for (let key = 1; key <= 17; key += 1) await prover.options(subject(1, 1, key), ORIGIN);

    should(prover.held).equal(17);
    should(await prover.verify(subject(1, 1, 1), assertionFor(1))).be.false();
    should(await prover.verify(subject(1, 1, 2), assertionFor(1))).be.true();
    should(await prover.verify(subject(9, 1, 1), assertionFor(1))).be.true();
  });

  it('R609 should hold at most 1024 across every share, the oldest going first', async () => {
    const { prover } = rig();
    for (let share = 1; share <= 64; share += 1)
      for (let key = 1; key <= 16; key += 1) await prover.options(subject(share, 1, key), ORIGIN);
    should(prover.held).equal(1_024);

    await prover.options(subject(100, 1, 1), ORIGIN);

    should(prover.held).equal(1_024);
    should(await prover.verify(subject(1, 1, 1), assertionFor(1))).be.false();
    should(await prover.verify(subject(1, 1, 2), assertionFor(1))).be.true();
    should(await prover.verify(subject(100, 1, 1), assertionFor(1))).be.true();
  });
});
