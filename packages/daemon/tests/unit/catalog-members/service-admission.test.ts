import { describe, it } from 'bun:test';
import should from 'should';
import {
  catalogId,
  codeOf,
  DUMMY_DIGEST,
  digestOf,
  flush,
  HOUR,
  iso,
  joinOf,
  keyId,
  memberId,
  membersDoc,
  multiFor,
  newKey,
  redeemOf,
  refusedOf,
  rig,
  sharesDoc,
  singleFor,
  singleForMember,
  storedKey,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

describe('CatalogMemberService.admitJoin: the refusals of step 2, in order', () => {
  it('should refuse a code nobody has as unknown and spend nothing', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));

    // Act
    const result = refusedOf(r.service.admitJoin(codeOf(99), T0));

    // Assert
    should(result.refusal).equal('share_refused');
    should(result.reason).equal('unknown');
    should(result.leftLive).be.false();
    should(joinOf(r.service.admitJoin(code, T0)).kind).equal('join');
  });

  it('should refuse a spent code as spent', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    joinOf(r.service.admitJoin(code, T0));

    // Act
    const result = refusedOf(r.service.admitJoin(code, T0));

    // Assert
    should(result.reason).equal('spent');
    should(result.leftLive).be.false();
  });

  it('should refuse a code at its expiry as expired', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));

    // Act
    const result = refusedOf(r.service.admitJoin(code, T0 + HOUR));

    // Assert
    should(result.reason).equal('expired');
    should(result.leftLive).be.false();
  });

  it('should refuse a code the owner ended as ended', async () => {
    // Arrange
    const r = await rig();
    const minted = await r.service.mint(singleFor('Alice'));
    await r.service.endShare(minted.share.shareId);

    // Act
    const result = refusedOf(r.service.admitJoin(minted.code, T0));

    // Assert
    should(result.reason).equal('ended');
    should(result.leftLive).be.false();
  });

  it('should refuse a code made for a member who has gone and leave it live', async () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { memberId: memberId(7), memberKind: 'existing' }));
    const r = await rig({ shares });

    // Act
    const result = refusedOf(r.service.admitJoin(codeOf(1), T0));

    // Assert
    should(result.reason).equal('member-gone');
    should(result.leftLive).be.true();
    should((await r.service.listShares()).shares[0]?.state).equal('live');
  });

  it('should refuse for room and leave the code live, so it works once there is room', async () => {
    // Arrange: 128 members; the code is for a new one
    const members = membersDoc(...Array.from({ length: 128 }, (_, index) => storedMember(index + 10)));
    const r = await rig({ members });
    const minted = await r.service.mint(singleFor('Alice'));

    // Act
    const full = refusedOf(r.service.admitJoin(minted.code, T0));
    await r.service.revokeMember(memberId(10));
    const retried = r.service.admitJoin(minted.code, T0);

    // Assert
    should(full.refusal).equal('members_full');
    should(full.reason).equal('members');
    should(full.leftLive).be.true();
    should(retried.ok).be.true();
  });

  it('should refuse a member who has the most browsers and leave the code live', async () => {
    // Arrange
    const keys = Array.from({ length: 200 }, (_, index) => storedKey(index + 1));
    const r = await rig({ members: membersDoc(storedMember(7, { keys })) });
    const minted = await r.service.mint(singleForMember(7));

    // Act
    const result = refusedOf(r.service.admitJoin(minted.code, T0));

    // Assert
    should(result.reason).equal('member-keys');
    should(result.leftLive).be.true();
    should((await r.service.listShares()).shares[0]?.state).equal('live');
  });

  it('should refuse a join that would give a member more catalogs than one may read', async () => {
    // Arrange: member 7 holds 60; the code brings 5 more
    const held = Array.from({ length: 60 }, (_, index) => catalogId(index + 1));
    const added = Array.from({ length: 5 }, (_, index) => catalogId(index + 61));
    const shares = sharesDoc(storedShare(1, { memberId: memberId(7), memberKind: 'existing', catalogIds: added }));
    const r = await rig({ members: membersDoc(storedMember(7, { catalogIds: held })), shares });

    // Act
    const result = refusedOf(r.service.admitJoin(codeOf(1), T0));

    // Assert
    should(result.refusal).equal('members_full');
    should(result.reason).equal('catalogs');
    should(result.leftLive).be.true();
  });

  it('should refuse the hourly most per share, leave the code live, and count each share on its own', async () => {
    // Arrange
    const r = await rig();
    const busy = await r.service.mint(multiFor('Crowd', 200));
    const quiet = await r.service.mint(multiFor('Quiet', 200));
    for (let index = 0; index < 60; index += 1) joinOf(r.service.admitJoin(busy.code, T0));

    // Act
    const sixtyFirst = refusedOf(r.service.admitJoin(busy.code, T0));
    const other = r.service.admitJoin(quiet.code, T0);

    // Assert
    should(sixtyFirst.refusal).equal('members_full');
    should(sixtyFirst.reason).equal('hourly');
    should(sixtyFirst.leftLive).be.true();
    should(other.ok).be.true();
  });

  it('should admit the busy share again once an hour has passed', async () => {
    // Arrange
    const r = await rig();
    const busy = await r.service.mint({ ...multiFor('Crowd', 200), expiresIn: '1d' });
    for (let index = 0; index < 60; index += 1) joinOf(r.service.admitJoin(busy.code, T0));

    // Act
    const sameHour = r.service.admitJoin(busy.code, T0 + HOUR - 1);
    const nextHour = r.service.admitJoin(busy.code, T0 + HOUR + 1);

    // Assert
    should(sameHour.ok).be.false();
    should(nextHour.ok).be.true();
  });
});

describe('CatalogMemberService.admitJoin: single and multi use', () => {
  it('should burn a single-use code on its first use', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));

    // Act
    const first = r.service.admitJoin(code, T0);
    const second = r.service.admitJoin(code, T0);

    // Assert
    should(first.ok).be.true();
    should(refusedOf(second).reason).equal('spent');
  });

  it('should keep a multi-use code live until it reaches its cap', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(multiFor('Crowd', 2));

    // Act
    const first = r.service.admitJoin(code, T0);
    const second = r.service.admitJoin(code, T0);
    const third = r.service.admitJoin(code, T0);

    // Assert
    should(first.ok).be.true();
    should(second.ok).be.true();
    should(refusedOf(third).reason).equal('spent');
  });

  it('should give every browser of a multi-use code the one member it names', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(multiFor('Crowd', 5));

    // Act
    const first = joinOf(r.service.admitJoin(code, T0));
    const second = joinOf(r.service.admitJoin(code, T0));

    // Assert
    should(second.memberId).equal(first.memberId);
    should(second.reservationId).not.equal(first.reservationId);
    should(second.memberLabel).equal('Crowd');
  });

  it("should hold a waiting join's slot against the next join until it is released", async () => {
    // Arrange: 127 members, two codes for two new people
    const members = membersDoc(...Array.from({ length: 127 }, (_, index) => storedMember(index + 10)));
    const r = await rig({ members });
    const alice = await r.service.mint(singleFor('Alice'));
    const bob = await r.service.mint(singleFor('Bob'));
    const waiting = joinOf(r.service.admitJoin(alice.code, T0));

    // Act
    const full = refusedOf(r.service.admitJoin(bob.code, T0));
    await r.service.release(waiting);
    const afterRelease = r.service.admitJoin(bob.code, T0);

    // Assert
    should(full.reason).equal('members');
    should(full.leftLive).be.true();
    should(afterRelease.ok).be.true();
  });
});

describe('CatalogMemberService.admitJoin: the path is the same whether or not anything is live', () => {
  const spy = () => {
    const calls: Array<[string, string]> = [];
    const compare = (left: string, right: string): boolean => {
      calls.push([left, right]);
      return left === right;
    };
    return { calls, compare };
  };

  it('should compare against the dummy once when there is no share at all', async () => {
    // Arrange
    const { calls, compare } = spy();
    const r = await rig({ compare });

    // Act
    const result = refusedOf(r.service.admitJoin(codeOf(1), T0));

    // Assert
    should(result.reason).equal('unknown');
    should(calls).eql([[DUMMY_DIGEST, digestOf(codeOf(1))]]);
  });

  it('should compare against every share and the dummy when none is live', async () => {
    // Arrange
    const { calls, compare } = spy();
    const shares = sharesDoc(
      storedShare(1, { state: 'spent' }),
      storedShare(2, { state: 'ended' }),
      storedShare(3, { expiresAt: iso(T0 - 1) }),
    );
    const r = await rig({ shares, compare });

    // Act
    const result = refusedOf(r.service.admitJoin(codeOf(2), T0));

    // Assert
    should(result.reason).equal('ended');
    should(calls).have.length(4);
    should(calls.map(([left]) => left)).eql([
      digestOf(codeOf(1)),
      digestOf(codeOf(2)),
      digestOf(codeOf(3)),
      DUMMY_DIGEST,
    ]);
    should(calls.every(([, right]) => right === digestOf(codeOf(2)))).be.true();
  });

  it('should compare the same number of times for a live code as for an unknown one', async () => {
    // Arrange
    const { calls, compare } = spy();
    const r = await rig({ shares: sharesDoc(storedShare(1), storedShare(2), storedShare(3)), compare });

    // Act
    r.service.admitJoin(codeOf(2), T0);
    const hit = calls.length;
    calls.length = 0;
    r.service.admitJoin(codeOf(99), T0);

    // Assert
    should(hit).equal(4);
    should(calls).have.length(4);
  });

  it('should compare for a redeem the same way', async () => {
    // Arrange
    const { calls, compare } = spy();
    const r = await rig({ shares: sharesDoc(storedShare(1), storedShare(2)), compare });

    // Act
    r.service.admitRedeem(codeOf(99), memberId(7), T0);

    // Assert
    should(calls).have.length(3);
  });
});

describe('CatalogMemberService.admitRedeem: owner decision Q5', () => {
  const holders = () =>
    membersDoc(
      storedMember(7, { catalogIds: [catalogId(1)], keys: [storedKey(7)] }),
      storedMember(8, { catalogIds: [catalogId(1)], keys: [storedKey(8)] }),
    );

  it('should burn a single-use code for the member it names and reserve what it adds', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(1), catalogId(2)]));

    // Act
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    const again = refusedOf(r.service.admitRedeem(code, memberId(7), T0));

    // Assert
    should(reservation.added).eql([catalogId(2)]);
    should(again.reason).equal('spent');
  });

  it('should burn a single-use code first when another member presents it, refuse, and tell the owner', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const minted = await r.service.mint(singleForMember(7, [catalogId(2)]));

    // Act
    const result = refusedOf(r.service.admitRedeem(minted.code, memberId(8), T0));
    const owner = r.service.admitRedeem(minted.code, memberId(7), T0);
    await flush();

    // Assert
    should(result.refusal).equal('share_other_member');
    should(result.reason).equal('other-member');
    should(result.leftLive).be.false();
    should(result.crossMember).eql({
      shareId: minted.share.shareId,
      memberId: memberId(8),
      shareMemberId: memberId(7),
    });
    should(refusedOf(owner).reason).equal('spent');
    should(r.audit.entries).eql([
      {
        event: 'catalog.share.cross-member',
        actor: { kind: 'anonymous' },
        subject: minted.share.shareId,
        outcome: 'succeeded',
        detail: { memberId: memberId(8), shareMemberId: memberId(7) },
      },
    ]);
  });

  it('should not let the same burned code join a browser either', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7));
    r.service.admitRedeem(code, memberId(8), T0);

    // Act
    const join = refusedOf(r.service.admitJoin(code, T0));

    // Assert
    should(join.reason).equal('spent');
  });

  it('should refuse a code made for a new member, burn it and tell the owner', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const minted = await r.service.mint(singleFor('Alice'));

    // Act
    const result = refusedOf(r.service.admitRedeem(minted.code, memberId(7), T0));
    const join = refusedOf(r.service.admitJoin(minted.code, T0));

    // Assert
    should(result.refusal).equal('share_new_member');
    should(result.reason).equal('new-member');
    should(result.leftLive).be.false();
    should(join.reason).equal('spent');
    should(r.audit.entries.map(entry => entry.event)).eql(['catalog.share.cross-member']);
  });

  it('should refuse a multi-use new-member code without counting a use or telling the owner', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(multiFor('Crowd', 2));

    // Act
    const result = refusedOf(r.service.admitRedeem(code, memberId(7), T0));
    const first = r.service.admitJoin(code, T0);
    const second = r.service.admitJoin(code, T0);
    await flush();

    // Assert
    should(result.reason).equal('new-member');
    should(result.leftLive).be.true();
    should(first.ok).be.true();
    should(second.ok).be.true();
    should(r.audit.entries).eql([]);
  });

  it('should count a use of a multi-use code only when the redeem adds a catalog', async () => {
    // Arrange: member 5 holds catalog 1; a two-use code names member 5 and offers catalogs 1 and 2
    const members = membersDoc(storedMember(5, { catalogIds: [catalogId(1)], keys: [storedKey(5)] }));
    const shares = sharesDoc(
      storedShare(1, {
        memberId: memberId(5),
        uses: { kind: 'multi', cap: 2 },
        catalogIds: [catalogId(1), catalogId(2)],
      }),
    );
    const r = await rig({ members, shares });
    const adds = redeemOf(r.service.admitRedeem(codeOf(1), memberId(5), T0));
    await r.service.commitRedeem(adds, { keyId: keyId(5), clientName: 'Browser 5' });

    // Act
    const adding = redeemOf(r.service.admitRedeem(codeOf(1), memberId(5), T0));
    const stateBefore = (await r.service.listShares()).shares[0]?.state;
    const join = r.service.admitJoin(codeOf(1), T0);
    const after = refusedOf(r.service.admitJoin(codeOf(1), T0));

    // Assert
    should(adds.added).eql([catalogId(2)]);
    should(adding.added).eql([]);
    should(stateBefore).equal('live');
    should(join.ok).be.true();
    should(after.reason).equal('spent');
  });

  it("should refuse a different member's browser for a multi-use code without counting", async () => {
    // Arrange
    const shares = sharesDoc(
      storedShare(1, {
        memberId: memberId(5),
        memberKind: 'existing',
        uses: { kind: 'multi', cap: 2 },
      }),
    );
    const r = await rig({ members: holders(), shares });

    // Act
    const result = refusedOf(r.service.admitRedeem(codeOf(1), memberId(7), T0));
    await flush();

    // Assert
    should(result.refusal).equal('share_other_member');
    should(result.leftLive).be.true();
    should(r.audit.entries).eql([]);
    should((await r.service.listShares()).shares[0]?.state).equal('live');
  });

  it('should refuse a browser whose member does not exist and keep the code', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7));

    // Act
    const result = refusedOf(r.service.admitRedeem(code, memberId(99), T0));

    // Assert
    should(result.refusal).equal('member_unknown');
    should(result.leftLive).be.true();
    should(r.service.admitRedeem(code, memberId(7), T0).ok).be.true();
  });

  it('should still refuse, and not throw, when the audit log is down', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7));
    r.audit.failing = true;

    // Act
    const result = refusedOf(r.service.admitRedeem(code, memberId(8), T0));
    await flush();

    // Assert
    should(result.reason).equal('other-member');
    should(r.audit.entries).have.length(1);
  });
});

describe('CatalogMemberService: the code is never stored', () => {
  it('should keep every code out of both files, the audit log and the lists, through a whole life', async () => {
    // Arrange
    const members = membersDoc(
      storedMember(7, { catalogIds: [catalogId(1)], keys: [storedKey(7)] }),
      storedMember(8, { keys: [storedKey(8)] }),
    );
    const r = await rig({ members });
    const alice = await r.service.mint(singleFor('Alice', [catalogId(1), catalogId(2)]));
    const forSeven = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const crowd = await r.service.mint(multiFor('Crowd', 5));
    const codes = [alice.code, forSeven.code, crowd.code];

    // Act
    const joined = joinOf(r.service.admitJoin(alice.code, T0));
    await r.service.commit(joined, newKey(1));
    r.service.admitRedeem(forSeven.code, memberId(8), T0);
    const crowdJoin = joinOf(r.service.admitJoin(crowd.code, T0));
    await r.service.commit(crowdJoin, newKey(2));
    await r.service.endShare(crowd.share.shareId);
    await r.service.revokeMember(joined.memberId);
    await flush();
    const everything = [
      ...r.members.history,
      ...r.shares.history,
      JSON.stringify(r.members.document),
      JSON.stringify(r.shares.document),
      JSON.stringify(r.audit.entries),
      JSON.stringify(await r.service.listShares()),
      JSON.stringify(await r.service.listMembers()),
    ].join('\n');

    // Assert
    for (const code of codes) {
      should(everything).not.containEql(code);
      should(everything).not.containEql(code.slice('fy_share_'.length));
      should(everything).containEql(digestOf(code));
    }
  });

  it("should hand the code back once, in the mint's answer, and nowhere in the share it describes", async () => {
    // Arrange
    const r = await rig();

    // Act
    const minted = await r.service.mint(singleFor('Alice'));

    // Assert
    should(JSON.stringify(minted.share)).not.containEql(minted.code);
    should(minted.link).containEql(minted.code);
  });
});
