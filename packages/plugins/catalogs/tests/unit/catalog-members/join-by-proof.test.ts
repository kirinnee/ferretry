import { describe, it } from 'bun:test';
import should from 'should';
import type { MemberJoinProof, StepUpOptions } from '../../../daemon/lib/boundary.ts';
import type { AuditEntry } from '../../../daemon/lib/audit.ts';
import { MemberJoinGate, type MemberJoinPublisher } from '../../../daemon/lib/catalog-members/join.ts';
import { MemberJoinProver } from '../../../daemon/lib/catalog-members/join-proof.ts';
import type { PasskeyVerifierPort, StoredPasskey } from '../../../daemon/lib/member-passkeys/types.ts';
import type { MemberJoinCarrier } from '../../../daemon/adapters/member-session.ts';
import {
  DAEMON_ID,
  MINUTE,
  catalogId,
  memberId,
  membersDoc,
  rig,
  singleFor,
  codeOf,
  storedKey,
  storedMember,
  T0,
} from './support.ts';

const ORIGIN = 'https://app.ferretry.test';
const PUBLISHER: MemberJoinPublisher = {
  daemonId: DAEMON_ID,
  daemonName: 'Workshop Box',
  carriers: [{ kind: 'direct', url: 'https://daemon.example.test:7077' }],
  memberUnlockDays: 30,
};
const DIRECT: MemberJoinCarrier = { kind: 'direct', rateLimitKey: 'peer-1' };
const RELAY: MemberJoinCarrier = { kind: 'relay' };

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const passkeyOf = (memberN: number, credential: string, overrides: Partial<StoredPasskey> = {}): StoredPasskey => ({
  credentialId: b64(new TextEncoder().encode(credential)),
  deviceId: `mk_${String(memberN).padStart(4, '0')}`,
  algorithm: -7,
  publicKeySpki: b64(new TextEncoder().encode(`spki-${credential}`)),
  signCount: 1,
  origin: ORIGIN,
  createdAt: new Date(T0).toISOString(),
  ...overrides,
});

/**
 * A verifier whose "signature" is the challenge itself: an assertion verifies exactly when it signs the challenge the
 * prover issued for this join, so a replay or a mismatched challenge fails the way a real signature would.
 */
const verifier: PasskeyVerifierPort = {
  verifyRegistration: async () => ({ ok: false, reason: 'unused' }),
  verifyAssertion: async input =>
    Buffer.from(input.signature).equals(Buffer.from(input.expectedChallenge))
      ? { ok: true, signCount: input.credential.signCount + 1, origin: input.allowedOrigins[0] ?? '' }
      : { ok: false, reason: 'bad signature' },
};

interface Setup {
  readonly passkeys: Map<string, StoredPasskey[]>;
  readonly signCounts: string[];
  readonly randoms: { n: number };
}

function build(r: Awaited<ReturnType<typeof rig>>, setup: Setup) {
  const audit: AuditEntry[] = [];
  const prover = new MemberJoinProver({
    passkeysOf: async id => setup.passkeys.get(id) ?? [],
    store: {
      updateSignCount: async (device, credential) => {
        setup.signCounts.push(`${device}:${credential}`);
        return true;
      },
    },
    verifier,
    random: {
      bytes: length => {
        setup.randoms.n += 1;
        return new Uint8Array(length).fill(setup.randoms.n);
      },
    },
    clock: { nowMs: () => r.clock.now },
    allowedOrigins: () => [ORIGIN],
  });
  const gate = new MemberJoinGate({
    members: r.service,
    proof: prover,
    publisher: () => PUBLISHER,
    audit: { record: async entry => void audit.push(entry) },
    now: () => r.clock.now,
    after: () => undefined,
  });
  return { gate, audit, prover };
}

/** Alice (member 1) has one browser with a passkey; Bob (member 2) is someone else with a passkey of his own. */
async function world() {
  const r = await rig({
    members: membersDoc(
      storedMember(1, { label: 'Alice', keys: [storedKey(1)] }),
      storedMember(2, { label: 'Bob', keys: [storedKey(2)] }),
    ),
  });
  const setup: Setup = {
    passkeys: new Map([
      [memberId(1), [passkeyOf(1, 'alice-phone')]],
      [memberId(2), [passkeyOf(2, 'bob-laptop')]],
    ]),
    signCounts: [],
    randoms: { n: 0 },
  };
  return { r, setup, ...build(r, setup) };
}

const forAlice = {
  catalogIds: [catalogId(1)],
  member: { kind: 'existing' as const, memberId: memberId(1) },
  expiresIn: '1h' as const,
  uses: { kind: 'single' as const },
};

function attemptFor(code: string, n: number, passkey?: MemberJoinProof, prove = async () => true) {
  return {
    code,
    clientName: `Browser ${String(n)}`,
    memberKey: storedKey(n).memberKey,
    boxKey: storedKey(n).boxKey,
    ...(passkey === undefined ? {} : { passkey }),
    prove,
  };
}

function optionsFor(code: string, n: number, origin = ORIGIN, prove = async () => true) {
  return { code, memberKey: storedKey(n).memberKey, origin, prove };
}

/** What a browser holding `credential` would send for these options: a signature over exactly their challenge. */
function assertionFor(options: StepUpOptions, credential: string): MemberJoinProof {
  return {
    credentialId: b64(new TextEncoder().encode(credential)),
    clientDataJSON: b64(new TextEncoder().encode('{}')),
    authenticatorData: b64(new TextEncoder().encode('auth')),
    signature: options.challenge,
  };
}

async function challengeFor(w: Awaited<ReturnType<typeof world>>, code: string, n: number): Promise<StepUpOptions> {
  const answer = await w.gate.options(optionsFor(code, n), RELAY);
  if (!answer.ok || answer.answer.kind !== 'challenge') throw new Error('expected a challenge');
  return answer.answer.options;
}

const members = (r: Awaited<ReturnType<typeof rig>>): number =>
  r.members.document.members.find(m => m.memberId === memberId(1))?.keys.length ?? 0;

describe('joining as someone who is already here: the proof comes first', () => {
  it('R610 should offer a challenge for every passkey of that person and none of anyone else', async () => {
    // Arrange
    const w = await world();
    w.setup.passkeys.set(memberId(1), [passkeyOf(1, 'alice-phone'), passkeyOf(1, 'alice-key')]);
    const { code } = await w.r.service.mint(forAlice);

    // Act
    const answer = await w.gate.options(optionsFor(code, 3), RELAY);

    // Assert
    if (!answer.ok || answer.answer.kind !== 'challenge') throw new Error('expected a challenge');
    should(answer.answer.memberLabel).equal('Alice');
    should(answer.answer.options.allowCredentials.map(c => c.id)).eql([
      passkeyOf(1, 'alice-phone').credentialId,
      passkeyOf(1, 'alice-key').credentialId,
    ]);
    should(answer.answer.options.rpId).equal('app.ferretry.test');
  });

  it('R610 should add the browser when one of that person’s passkeys signs the challenge, and say so in the log', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);
    const options = await challengeFor(w, code, 3);

    // Act
    const result = await w.gate.join(attemptFor(code, 3, assertionFor(options, 'alice-phone')), RELAY);

    // Assert
    should(result.ok).equal(true);
    should(members(w.r)).equal(2);
    should(w.setup.signCounts).have.length(1);
    const proved = w.audit.find(entry => entry.event === 'catalog.member.join-proved');
    should(proved).containDeep({ subject: memberId(1), outcome: 'succeeded', detail: { carrier: 'relay' } });
    should(JSON.stringify(w.audit)).not.containEql(options.challenge);
  });

  it('R610 should not let a forwarded invite add a stranger’s browser when no proof comes with it', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);

    // Act
    const result = await w.gate.join(attemptFor(code, 3), RELAY);

    // Assert
    should(result.ok).equal(false);
    should(members(w.r)).equal(1);
    should(w.audit.map(entry => entry.detail?.reason)).containEql('proof-required');
  });

  it('R610 should leave the code live when the proof fails, and let the right passkey join afterwards', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);
    const first = await challengeFor(w, code, 3);
    const forged = { ...assertionFor(first, 'alice-phone'), signature: b64(new Uint8Array(32).fill(250)) };

    // Act
    const refused = await w.gate.join(attemptFor(code, 3, forged), RELAY);
    const second = await challengeFor(w, code, 3);
    const joined = await w.gate.join(attemptFor(code, 3, assertionFor(second, 'alice-phone')), RELAY);

    // Assert
    should(refused.ok).equal(false);
    should(joined.ok).equal(true);
    should(w.audit.map(entry => entry.event)).containEql('catalog.member.join-proof-refused');
  });

  it('R610 should refuse a proof from another person’s credential and keep the code', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);
    const options = await challengeFor(w, code, 3);

    // Act
    const result = await w.gate.join(attemptFor(code, 3, assertionFor(options, 'bob-laptop')), RELAY);

    // Assert
    should(result.ok).equal(false);
    should(members(w.r)).equal(1);
    const again = await challengeFor(w, code, 3);
    should((await w.gate.join(attemptFor(code, 3, assertionFor(again, 'alice-phone')), RELAY)).ok).equal(true);
  });

  it('R610 should refuse a replayed assertion, because the challenge was spent', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint({ ...forAlice, uses: { kind: 'single' } });
    const options = await challengeFor(w, code, 3);
    const assertion = assertionFor(options, 'alice-phone');
    await w.gate.join(attemptFor(code, 3, { ...assertion, signature: b64(new Uint8Array(32).fill(250)) }), RELAY);

    // Act
    const replay = await w.gate.join(attemptFor(code, 3, assertion), RELAY);

    // Assert
    should(replay.ok).equal(false);
    should(members(w.r)).equal(1);
  });

  it('R610 should not honour a challenge issued for another browser key or another share', async () => {
    // Arrange
    const w = await world();
    const first = await w.r.service.mint(forAlice);
    const second = await w.r.service.mint(forAlice);
    const options = await challengeFor(w, first.code, 3);

    // Act
    const otherKey = await w.gate.join(attemptFor(first.code, 4, assertionFor(options, 'alice-phone')), RELAY);
    const otherShare = await w.gate.join(attemptFor(second.code, 3, assertionFor(options, 'alice-phone')), RELAY);

    // Assert
    should(otherKey.ok).equal(false);
    should(otherShare.ok).equal(false);
    should(members(w.r)).equal(1);
  });

  it('R610 should refuse a proof once its challenge is two minutes old', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);
    const options = await challengeFor(w, code, 3);
    w.r.clock.now += 3 * MINUTE;

    // Act
    const result = await w.gate.join(attemptFor(code, 3, assertionFor(options, 'alice-phone')), RELAY);

    // Assert
    should(result.ok).equal(false);
  });

  it('R610 should find no passkey for a person who is gone, so nothing can prove', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);
    const options = await challengeFor(w, code, 3);
    w.setup.passkeys.delete(memberId(1));

    // Act
    const proved = await w.gate.join(attemptFor(code, 3, assertionFor(options, 'alice-phone')), RELAY);
    const asked = await w.gate.options(optionsFor(code, 3), RELAY);

    // Assert
    should(proved.ok).equal(false);
    should(asked.ok).equal(false);
  });

  it('R610 should offer nothing at an origin this machine does not serve', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);

    // Act
    const answer = await w.gate.options(optionsFor(code, 3, 'https://evil.example.test'), RELAY);

    // Assert
    should(answer.ok).equal(false);
    should(w.audit.map(entry => entry.detail?.reason)).containEql('no-passkey-here');
  });

  it('R610 should treat the same refusal alike for an unknown code, a malformed record and a bad session proof', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);

    // Act
    const unknown = await w.gate.options(optionsFor('fy_share_nope', 3), RELAY);
    const malformed = await w.gate.options({ ...optionsFor(code, 3), origin: '' }, RELAY);
    const unproven = await w.gate.options(
      optionsFor(code, 3, ORIGIN, async () => false),
      RELAY,
    );

    // Assert
    for (const answer of [unknown, malformed, unproven]) should(answer).eql({ ok: false });
  });

  it('R610 should not spend the code by asking what it needs', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);

    // Act
    await challengeFor(w, code, 3);
    await challengeFor(w, code, 3);

    // Assert
    should(w.r.service.joinNeed(code, w.r.clock.now)?.need).equal('proof');
    should(members(w.r)).equal(1);
  });

  it('R610 should write at most one proof refusal per share per minute', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(forAlice);

    // Act
    for (let n = 3; n < 8; n += 1) await w.gate.join(attemptFor(code, n), RELAY);
    w.r.clock.now += MINUTE;
    await w.gate.join(attemptFor(code, 9), RELAY);

    // Assert
    should(w.audit.filter(entry => entry.event === 'catalog.member.join-proof-refused')).have.length(2);
  });

  it('R610 should count a refused options request against a direct peer’s failed-join budget', async () => {
    // Arrange
    const w = await world();

    // Act
    for (let i = 0; i < 10; i += 1) await w.gate.options(optionsFor('fy_share_nope', 3), DIRECT);
    const { code } = await w.r.service.mint(forAlice);
    const spent = await w.gate.options(optionsFor(code, 3), DIRECT);

    // Assert
    should(spent).eql({ ok: false });
  });
});

describe('a new passkey, approved by the owner for one invite', () => {
  it('R610 should join without a proof when the owner marked the invite, and say so in the log', async () => {
    // Arrange
    const w = await world();
    w.setup.passkeys.delete(memberId(1));
    const { code } = await w.r.service.mint({ ...forAlice, newPasskey: true });

    // Act
    const answer = await w.gate.options(optionsFor(code, 3), RELAY);
    const result = await w.gate.join(attemptFor(code, 3), RELAY);

    // Assert
    should(answer).eql({ ok: true, answer: { kind: 'open', why: 'owner-approved' } });
    should(result.ok).equal(true);
    should(members(w.r)).equal(2);
    should(w.audit.map(entry => entry.event)).containEql('catalog.member.new-passkey-used');
  });

  it('R610 should be single-use: a second browser with the same code is refused', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint({ ...forAlice, newPasskey: true });
    await w.gate.join(attemptFor(code, 3), RELAY);

    // Act
    const second = await w.gate.join(attemptFor(code, 4), RELAY);

    // Assert
    should(second.ok).equal(false);
    should(members(w.r)).equal(2);
  });

  it('R610 should NOT open a person with no passkey left unless the owner marked the invite', async () => {
    // Arrange
    const w = await world();
    const ownerless = await rig({
      members: membersDoc(storedMember(1, { label: 'Alice', keys: [storedKey(1, { passkeyCount: 0 })] })),
    });
    const setup: Setup = { passkeys: new Map(), signCounts: [], randoms: { n: 0 } };
    const gate = build(ownerless, setup);
    const minted = await ownerless.service.mint(forAlice);

    // Act
    const answer = await gate.gate.options(optionsFor(minted.code, 3), RELAY);
    const result = await gate.gate.join(attemptFor(minted.code, 3), RELAY);

    // Assert
    should(minted.noPasskeyLeft).equal(true);
    should(answer.ok).equal(false);
    should(result.ok).equal(false);
    should(w.audit).have.length(0);
    should(gate.audit.map(entry => entry.detail?.reason)).containEql('approval-required');
  });

  it('R610 should leave a first join alone: a brand-new person joins with no proof', async () => {
    // Arrange
    const w = await world();
    const { code } = await w.r.service.mint(singleFor('Carol'));

    // Act
    const answer = await w.gate.options(optionsFor(code, 3), RELAY);
    const result = await w.gate.join(attemptFor(code, 3), RELAY);

    // Assert
    should(answer).eql({ ok: true, answer: { kind: 'open', why: 'first-browser' } });
    should(result.ok).equal(true);
    should(w.audit.map(entry => entry.event)).not.containEql('catalog.member.join-proved');
  });
});

describe('the proof gate is total and bounded', () => {
  const stub = (shareN: { n: number }) => ({
    ready: async () => undefined,
    joinNeed: () => ({
      need: 'proof' as const,
      shareId: `shr_${String(shareN.n)}`,
      memberId: memberId(1),
      memberLabel: 'Alice',
    }),
    admitJoin: () => {
      throw new Error('a refused proof must never reach admission');
    },
    commit: async () => {
      throw new Error('unreachable');
    },
    release: async () => undefined,
  });
  const gateOver = (members: ReturnType<typeof stub>, audit: AuditEntry[]) =>
    new MemberJoinGate({
      members: members as unknown as ConstructorParameters<typeof MemberJoinGate>[0]['members'],
      proof: { options: async () => undefined, verify: async () => false },
      publisher: () => PUBLISHER,
      audit: { record: async entry => void audit.push(entry) },
      now: () => T0,
      after: () => undefined,
    });

  it('R610 should never reach admission for a proof that fails, however many shares try', async () => {
    // Arrange
    const audit: AuditEntry[] = [];
    const shareN = { n: 0 };
    const gate = gateOver(stub(shareN), audit);

    // Act
    for (shareN.n = 0; shareN.n < 4_100; shareN.n += 1)
      await gate.join(attemptFor(codeOf(1), 3, assertionFor({ challenge: 'c' } as StepUpOptions, 'a')), RELAY);

    // Assert
    should(audit.filter(entry => entry.event === 'catalog.member.join-proof-refused')).have.length(4_100);
  });

  it('R610 should refuse alike when the members side throws while answering options', async () => {
    // Arrange
    const audit: AuditEntry[] = [];
    const members = { ...stub({ n: 1 }), ready: async () => Promise.reject(new Error('disk')) };
    const gate = gateOver(members, audit);

    // Act
    const answer = await gate.options(optionsFor(codeOf(1), 3), RELAY);

    // Assert
    should(answer).eql({ ok: false });
  });
});
