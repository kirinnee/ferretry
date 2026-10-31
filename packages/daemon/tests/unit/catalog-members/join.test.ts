import { describe, it } from 'bun:test';
import should from 'should';
import { MEMBER_JOIN_ATTEMPTS_PER_MINUTE, MemberJoinedResponseSchema } from '@ferretry/protocol';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import { FailedJoinBudget, MemberJoinGate, type MemberJoinPublisher } from '../../../src/lib/catalog-members/join.ts';
import type { Durable } from '../../../src/lib/catalog-members/service.ts';
import type { JoinAdmission } from '../../../src/lib/catalog-members/admission.ts';
import type { MemberJoinAttempt, MemberJoinCarrier, MemberJoinResult } from '../../../src/lib/relay/member-port.ts';
import { DAEMON_ID, MINUTE, multiFor, rig, singleFor, storedKey, T0 } from './support.ts';

type Rig = Awaited<ReturnType<typeof rig>>;

const PUBLISHER: MemberJoinPublisher = {
  daemonId: DAEMON_ID,
  daemonName: 'Workshop Box',
  carriers: [{ kind: 'direct', url: 'https://daemon.example.test:7077' }],
  memberUnlockDays: 30,
};
const DIRECT: MemberJoinCarrier = { kind: 'direct', rateLimitKey: 'peer-1' };
const RELAY: MemberJoinCarrier = { kind: 'relay' };
const TUNNEL: MemberJoinCarrier = { kind: 'tunnel' };

type Members = ConstructorParameters<typeof MemberJoinGate>[0]['members'];

function build(
  r: Rig,
  override: Partial<Members> = {},
  publisher: () => MemberJoinPublisher = () => PUBLISHER,
  persisted?: Promise<void>,
) {
  const calls: string[] = [];
  const audit: AuditEntry[] = [];
  const sink = { failing: false };
  const members: Members = {
    ready: async () => {
      calls.push('ready');
      await r.service.ready();
    },
    admitJoin: (code, now) => {
      calls.push('admit');
      const admission = r.service.admitJoin(code, now);
      return persisted === undefined ? admission : ({ ...admission, persisted } as Durable<JoinAdmission>);
    },
    commit: async (reservation, key) => {
      calls.push('commit');
      return await r.service.commit(reservation, key);
    },
    release: async reservation => {
      calls.push('release');
      await r.service.release(reservation);
    },
    ...override,
  };
  const gate = new MemberJoinGate({
    members,
    publisher,
    audit: {
      record: async entry => {
        audit.push(entry);
        if (sink.failing) throw new Error('audit is down');
      },
    },
    now: () => r.clock.now,
  });
  return { gate, calls, audit, sink };
}

function attemptOf(
  code: string,
  n = 1,
  overrides: Partial<Omit<MemberJoinAttempt, 'prove'>> = {},
  prove: () => Promise<boolean> = async () => true,
) {
  const proofs = { count: 0 };
  const attempt: MemberJoinAttempt = {
    code,
    clientName: `Browser ${String(n)}`,
    memberKey: storedKey(n).memberKey,
    boxKey: storedKey(n).boxKey,
    ...overrides,
    prove: async () => {
      proofs.count += 1;
      return await prove();
    },
  };
  return { attempt, proofs };
}

const reasons = (audit: readonly AuditEntry[]): unknown[] => audit.map(entry => entry.detail?.reason);

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settled(work: Promise<unknown>): Promise<boolean> {
  let done = false;
  void work.then(() => {
    done = true;
  });
  await Bun.sleep(5);
  return done;
}

describe('MemberJoinGate: a join that succeeds', () => {
  it('should answer with who joined and what this machine is, in the order ready, admit, commit', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate, calls } = build(r);
    const { attempt, proofs } = attemptOf(code);

    // Act
    const result = await gate.join(attempt, DIRECT);

    // Assert
    if (!result.ok) throw new Error('expected a join');
    should(MemberJoinedResponseSchema.safeParse(result.response).success).equal(true);
    should(result.response.label).equal('Alice');
    should(result.response.daemonId).equal(DAEMON_ID);
    should(result.response.daemonName).equal('Workshop Box');
    should(result.response.catalogCount).equal(1);
    should(result.response.memberUnlockDays).equal(30);
    should(result.response.carriers).eql(PUBLISHER.carriers);
    should(proofs.count).equal(1);
    should(calls).eql(['ready', 'admit', 'commit']);
    should(r.members.document.members[0]?.keys.map(key => key.memberKey)).eql([attempt.memberKey]);
  });

  it('should audit the join with who and how, and never the code, the keys or the proof', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate, audit } = build(r);
    const { attempt } = attemptOf(code);

    // Act
    const result = await gate.join(attempt, TUNNEL);

    // Assert
    if (!result.ok) throw new Error('expected a join');
    should(audit).have.length(1);
    should(audit[0]).containDeep({
      event: 'catalog.member.joined',
      actor: { kind: 'anonymous' },
      subject: result.response.memberId,
      outcome: 'succeeded',
      detail: {
        memberLabel: 'Alice',
        keyId: result.response.keyId,
        clientName: 'Browser 1',
        carrier: 'tunnel',
      },
    });
    const text = JSON.stringify(audit);
    for (const secret of [code, attempt.memberKey, attempt.boxKey]) should(text.includes(secret)).equal(false);
  });

  it('should not release a reservation it committed', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate, calls } = build(r);

    // Act
    await gate.join(attemptOf(code).attempt, RELAY);

    // Assert
    should(calls).not.containEql('release');
  });

  it('should still answer when the audit log is down', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate, sink } = build(r);
    sink.failing = true;

    // Act
    const result = await gate.join(attemptOf(code).attempt, RELAY);

    // Assert
    should(result.ok).equal(true);
  });
});

describe('MemberJoinGate: the stateless checks spend nothing', () => {
  const malformed: [string, Partial<Omit<MemberJoinAttempt, 'prove'>>][] = [
    ['a code that is not a share code', { code: 'fy_share_short' }],
    ['a member key that is not a key', { memberKey: 'AAAA' }],
    ['a box key that is not a key', { boxKey: 'AAAA' }],
    ['a client name that is empty', { clientName: '' }],
  ];

  for (const [name, overrides] of malformed) {
    it(`should refuse ${name} before the proof, the code or any write`, async () => {
      // Arrange
      const r = await rig();
      const { code } = await r.service.mint(singleFor('Alice'));
      const writes = r.shares.writes;
      const { gate, calls, audit } = build(r);
      const { attempt, proofs } = attemptOf(code, 1, overrides);

      // Act
      const result = await gate.join(attempt, RELAY);

      // Assert
      should(result).eql({ ok: false });
      should(proofs.count).equal(0);
      should(calls).eql([]);
      should(r.shares.writes).equal(writes);
      should(reasons(audit)).eql(['malformed']);
    });
  }

  it('should refuse a bad proof before the code is looked at', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const writes = r.shares.writes;
    const { gate, calls, audit } = build(r);
    const { attempt } = attemptOf(code, 1, {}, async () => false);

    // Act
    const result = await gate.join(attempt, RELAY);

    // Assert
    should(result).eql({ ok: false });
    should(calls).eql([]);
    should(r.shares.writes).equal(writes);
    should(reasons(audit)).eql(['proof']);
  });

  it('should treat a proof that throws as the one refusal', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate, calls, audit } = build(r);
    const { attempt } = attemptOf(code, 1, {}, async () => {
      throw new Error('boom');
    });

    // Act
    const result = await gate.join(attempt, RELAY);

    // Assert
    should(result).eql({ ok: false });
    should(calls).eql([]);
    should(reasons(audit)).eql(['failed']);
  });

  it('should refuse alike for a code no one minted and a code that was spent, and say neither to the browser', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate, audit } = build(r);
    await gate.join(attemptOf(code, 1).attempt, RELAY);

    // Act
    const spent = await gate.join(attemptOf(code, 2).attempt, RELAY);
    const unknown = await gate.join(attemptOf('fy_share_BBBBBBBBBBBBBBBBBBBBBB', 3).attempt, RELAY);

    // Assert
    should(spent).eql({ ok: false });
    should(unknown).eql(spent);
    should(audit.slice(1).every(entry => entry.event === 'catalog.member.join-refused')).equal(true);
    should(JSON.stringify(audit).includes(code)).equal(false);
  });
});

describe('MemberJoinGate: the burn is on disk before anything is answered', () => {
  it('should not answer a refusal until its admission has persisted', async () => {
    // Arrange
    const r = await rig();
    const persisted = deferred();
    const { gate, audit } = build(r, {}, () => PUBLISHER, persisted.promise);
    const pending = gate.join(attemptOf('fy_share_BBBBBBBBBBBBBBBBBBBBBB').attempt, RELAY);

    // Act
    const early = await settled(pending);
    persisted.resolve();
    const result = await pending;

    // Assert
    should(early).equal(false);
    should(result).eql({ ok: false });
    should(reasons(audit)).eql(['unknown']);
  });

  it('should not commit, nor answer a join, until its admission has persisted', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const persisted = deferred();
    const { gate, calls } = build(r, {}, () => PUBLISHER, persisted.promise);
    const pending = gate.join(attemptOf(code).attempt, RELAY);

    // Act
    const early = await settled(pending);
    const callsEarly = [...calls];
    persisted.resolve();
    const result = await pending;

    // Assert
    should(early).equal(false);
    should(callsEarly).eql(['ready', 'admit']);
    should(result.ok).equal(true);
  });

  it('should not answer while the write that holds the join is still on its way to disk', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate } = build(r);
    const releaseDisk = r.shares.hold();
    const releaseMembers = r.members.hold();
    const pending = gate.join(attemptOf(code).attempt, RELAY);

    // Act
    const early = await settled(pending);
    releaseDisk();
    releaseMembers();
    const result = await pending;

    // Assert
    should(early).equal(false);
    should(r.log).containEql('shares.write');
    should(result.ok).equal(true);
  });

  it('should release the reservation and refuse when the burn could not be written', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const broken = Promise.reject<void>(new Error('disk full'));
    broken.catch(() => undefined);
    const { gate, calls, audit } = build(r, {}, () => PUBLISHER, broken);

    // Act
    const result = await gate.join(attemptOf(code).attempt, RELAY);

    // Assert
    should(result).eql({ ok: false });
    should(calls).eql(['ready', 'admit', 'release']);
    should(reasons(audit)).eql(['failed']);
  });
});

describe('MemberJoinGate: a reservation is committed or released, never held', () => {
  it('should release it when the commit fails', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate, calls, audit } = build(r, {
      commit: async () => {
        calls.push('commit');
        throw new Error('disk full');
      },
    });

    // Act
    const result = await gate.join(attemptOf(code).attempt, RELAY);

    // Assert
    should(result).eql({ ok: false });
    should(calls).eql(['ready', 'admit', 'commit', 'release']);
    should(reasons(audit)).eql(['failed']);
  });

  it('should still refuse when the release itself fails', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate } = build(r, {
      commit: async () => {
        throw new Error('disk full');
      },
      release: async () => {
        throw new Error('release failed');
      },
    });

    // Act
    const result = await gate.join(attemptOf(code).attempt, RELAY);

    // Assert
    should(result).eql({ ok: false });
  });

  it('should take no reservation when the publisher cannot describe itself, and leave the code unspent', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    let broken = true;
    const { gate, calls, audit } = build(r, {}, () => {
      if (broken) throw new Error('no carriers yet');
      return PUBLISHER;
    });

    // Act
    const refused = await gate.join(attemptOf(code).attempt, RELAY);
    broken = false;
    const retried = await gate.join(attemptOf(code).attempt, RELAY);

    // Assert
    should(refused).eql({ ok: false });
    should(calls.slice(0, 1)).not.containEql('admit');
    should(reasons(audit)[0]).equal('failed');
    should(retried.ok).equal(true);
  });

  it('should still refuse when the audit log is down', async () => {
    // Arrange
    const r = await rig();
    const { gate, sink } = build(r);
    sink.failing = true;

    // Act
    const result = await gate.join(attemptOf('fy_share_BBBBBBBBBBBBBBBBBBBBBB').attempt, DIRECT);

    // Assert
    should(result).eql({ ok: false });
  });
});

describe('MemberJoinGate: the failed-join budget', () => {
  async function fail(gate: MemberJoinGate, times: number, carrier: MemberJoinCarrier): Promise<MemberJoinResult[]> {
    const results: MemberJoinResult[] = [];
    for (let index = 0; index < times; index += 1)
      results.push(await gate.join(attemptOf('fy_share_BBBBBBBBBBBBBBBBBBBBBB', index + 1).attempt, carrier));
    return results;
  }

  it('should refuse a peer that failed ten times this minute without looking at anything, a good join included', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate, calls, audit } = build(r);
    await fail(gate, MEMBER_JOIN_ATTEMPTS_PER_MINUTE, DIRECT);
    calls.length = 0;
    const { attempt, proofs } = attemptOf(code, 50);

    // Act
    const result = await gate.join(attempt, DIRECT);

    // Assert
    should(result).eql({ ok: false });
    should(proofs.count).equal(0);
    should(calls).eql([]);
    should(audit.map(entry => entry.detail?.count)).eql([1]);
  });

  it('should count a refusal for the budget no further than the ten it already spent', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate } = build(r);
    await fail(gate, MEMBER_JOIN_ATTEMPTS_PER_MINUTE + 5, DIRECT);

    // Act
    r.clock.now = T0 + MINUTE;
    const result = await gate.join(attemptOf(code, 50).attempt, DIRECT);

    // Assert
    should(result.ok).equal(true);
  });

  it('should not limit another peer', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate } = build(r);
    await fail(gate, MEMBER_JOIN_ATTEMPTS_PER_MINUTE, DIRECT);

    // Act
    const result = await gate.join(attemptOf(code, 50).attempt, { kind: 'direct', rateLimitKey: 'peer-2' });

    // Assert
    should(result.ok).equal(true);
  });

  it('should allow the tenth failure to be followed by a good join only while it is under the limit', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const { gate } = build(r);
    await fail(gate, MEMBER_JOIN_ATTEMPTS_PER_MINUTE - 1, DIRECT);

    // Act
    const result = await gate.join(attemptOf(code, 50).attempt, DIRECT);

    // Assert
    should(result.ok).equal(true);
  });

  it('should not count a join that succeeds, however many one peer makes', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(multiFor('Crowd', 200));
    const { gate } = build(r);

    // Act
    const results: MemberJoinResult[] = [];
    for (let index = 1; index <= MEMBER_JOIN_ATTEMPTS_PER_MINUTE + 2; index += 1)
      results.push(await gate.join(attemptOf(code, index).attempt, DIRECT));

    // Assert
    should(results.every(result => result.ok)).equal(true);
  });

  for (const carrier of [RELAY, TUNNEL]) {
    it(`should keep no budget for the ${carrier.kind} carrier`, async () => {
      // Arrange
      const r = await rig();
      const { code } = await r.service.mint(singleFor('Alice'));
      const { gate, audit } = build(r);
      await fail(gate, MEMBER_JOIN_ATTEMPTS_PER_MINUTE * 3, carrier);

      // Act
      const result = await gate.join(attemptOf(code, 50).attempt, carrier);

      // Assert
      should(result.ok).equal(true);
      should(reasons(audit)).not.containEql('budget');
    });
  }
});

describe('MemberJoinGate: the refusal audit is coalesced', () => {
  const refuse = async (gate: MemberJoinGate, carrier: MemberJoinCarrier, times: number): Promise<void> => {
    for (let index = 0; index < times; index += 1)
      await gate.join(attemptOf('fy_share_BBBBBBBBBBBBBBBBBBBBBB', index + 1).attempt, carrier);
  };

  it('should write the first refusal at once, and fold a flood into that one entry', async () => {
    // Arrange
    const r = await rig();
    const { gate, audit } = build(r);

    // Act
    await refuse(gate, RELAY, 200);

    // Assert
    should(audit).have.length(1);
    should(audit[0]).containDeep({
      event: 'catalog.member.join-refused',
      outcome: 'refused',
      detail: { carrier: 'relay', count: 1 },
    });
  });

  it('should carry what was folded on the next entry, once a minute has passed', async () => {
    // Arrange
    const r = await rig();
    const { gate, audit } = build(r);
    await refuse(gate, RELAY, 6);

    // Act
    r.clock.now = T0 + MINUTE;
    await refuse(gate, RELAY, 1);
    await refuse(gate, RELAY, 3);

    // Assert — five folded plus the one that stands in front: six; the three after it fold again
    should(audit.map(entry => entry.detail?.count)).eql([1, 6]);
  });

  it('should fold a refusal one moment short of the minute, and write the one at the minute', async () => {
    // Arrange
    const r = await rig();
    const { gate, audit } = build(r);
    await refuse(gate, RELAY, 1);

    // Act
    r.clock.now = T0 + MINUTE - 1;
    await refuse(gate, RELAY, 1);
    const before = audit.length;
    r.clock.now = T0 + MINUTE;
    await refuse(gate, RELAY, 1);

    // Assert
    should(before).equal(1);
    should(audit.map(entry => entry.detail?.count)).eql([1, 2]);
  });

  it('should keep a window for each carrier, so a flood on one never hides the other', async () => {
    // Arrange
    const r = await rig();
    const { gate, audit } = build(r);

    // Act
    await refuse(gate, RELAY, 5);
    await refuse(gate, TUNNEL, 5);
    await refuse(gate, DIRECT, 5);

    // Assert
    should(audit.map(entry => entry.detail?.carrier)).eql(['relay', 'tunnel', 'direct']);
  });

  it('should fold the refusals the budget makes, and count them when the minute is over', async () => {
    // Arrange
    const r = await rig();
    const { gate, audit } = build(r);
    await refuse(gate, DIRECT, MEMBER_JOIN_ATTEMPTS_PER_MINUTE + 4);

    // Act
    r.clock.now = T0 + MINUTE;
    await refuse(gate, DIRECT, 1);

    // Assert — fourteen in the first minute: one written, thirteen folded, then the fifteenth
    should(audit.map(entry => entry.detail?.count)).eql([1, MEMBER_JOIN_ATTEMPTS_PER_MINUTE + 4]);
  });
});

describe('FailedJoinBudget', () => {
  const failTimes = (budget: FailedJoinBudget, peer: string, times: number, at: number): void => {
    for (let index = 0; index < times; index += 1) budget.fail(peer, at);
  };

  it('should be spent at the limit and not before', () => {
    // Arrange
    const budget = new FailedJoinBudget();

    // Act
    failTimes(budget, 'a', MEMBER_JOIN_ATTEMPTS_PER_MINUTE - 1, T0);
    const before = budget.spent('a', T0);
    budget.fail('a', T0);

    // Assert
    should(before).equal(false);
    should(budget.spent('a', T0)).equal(true);
    should(budget.spent('b', T0)).equal(false);
  });

  it('should start a fresh window one minute after the first failure', () => {
    // Arrange
    const budget = new FailedJoinBudget();
    failTimes(budget, 'a', MEMBER_JOIN_ATTEMPTS_PER_MINUTE, T0);

    // Act
    const justBefore = budget.spent('a', T0 + MINUTE - 1);
    const after = budget.spent('a', T0 + MINUTE);
    budget.fail('a', T0 + MINUTE);

    // Assert
    should(justBefore).equal(true);
    should(after).equal(false);
    should(budget.spent('a', T0 + MINUTE)).equal(false);
  });

  it('should forget the oldest live window when 4096 peers are all live', () => {
    // Arrange
    const budget = new FailedJoinBudget();
    failTimes(budget, 'oldest', MEMBER_JOIN_ATTEMPTS_PER_MINUTE, T0);

    // Act
    for (let index = 0; index < 4_095; index += 1) budget.fail(`peer-${String(index)}`, T0 + 1);
    const beforeOverflow = budget.spent('oldest', T0 + 2);
    budget.fail('overflow', T0 + 2);

    // Assert
    should(beforeOverflow).equal(true);
    should(budget.spent('oldest', T0 + 2)).equal(false);
  });

  it('should drop the expired windows first, and keep a live one that is past the oldest', () => {
    // Arrange
    const budget = new FailedJoinBudget();
    budget.fail('expired', T0);
    failTimes(budget, 'live', MEMBER_JOIN_ATTEMPTS_PER_MINUTE, T0 + 30_000);
    for (let index = 0; index < 4_094; index += 1) budget.fail(`peer-${String(index)}`, T0 + 30_000);

    // Act
    budget.fail('late', T0 + MINUTE + 1);

    // Assert
    should(budget.spent('live', T0 + MINUTE + 1)).equal(true);
  });
});
