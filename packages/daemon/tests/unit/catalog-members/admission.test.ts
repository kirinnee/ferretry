import { describe, it } from 'bun:test';
import should from 'should';
import type { StoredShare } from '../../../src/lib/catalog-members/document.ts';
import {
  admitJoin,
  admitRedeem,
  HOUR_MS,
  locateShare,
  shareState,
} from '../../../src/lib/catalog-members/admission.ts';
import {
  catalogId,
  catalogIds,
  codeOf,
  DUMMY_DIGEST,
  digestOf,
  iso,
  joinOf,
  joinReservation,
  keysOf,
  memberId,
  membersDoc,
  probeOf,
  redeemOf,
  refusedOf,
  shareId,
  shareOf,
  sharesDoc,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

const recent = (count: number): number[] => Array.from({ length: count }, (_, index) => T0 - 1_000 - index);

describe('shareState', () => {
  it('should read a stored live share as live before its expiry', () => {
    // Arrange
    const share = storedShare(1, { expiresAt: iso(T0 + 1) });

    // Act / Assert
    should(shareState(share, T0)).equal('live');
  });

  it('should read a stored live share as expired at and after its expiry', () => {
    // Arrange
    const share = storedShare(1, { expiresAt: iso(T0) });

    // Act / Assert
    should(shareState(share, T0)).equal('expired');
    should(shareState(share, T0 + 1)).equal('expired');
  });

  it('should keep a share that is already spent or ended as it is, whatever the time', () => {
    // Arrange
    const spent = storedShare(1, { state: 'spent', expiresAt: iso(T0 - HOUR_MS) });
    const ended = storedShare(2, { state: 'ended', expiresAt: iso(T0 - HOUR_MS) });
    const expired = storedShare(3, { state: 'expired' });

    // Act / Assert
    should(shareState(spent, T0)).equal('spent');
    should(shareState(ended, T0)).equal('ended');
    should(shareState(expired, T0)).equal('expired');
  });
});

describe('locateShare', () => {
  it('should find the share whose digest matches', () => {
    // Arrange
    const shares = sharesDoc(storedShare(1), storedShare(2), storedShare(3));

    // Act
    const found = locateShare(shares, digestOf(codeOf(2)), (left, right) => left === right);

    // Assert
    should(found?.shareId).equal(shareId(2));
  });

  it('should find nothing for a digest no share has', () => {
    // Arrange
    const shares = sharesDoc(storedShare(1));

    // Act
    const found = locateShare(shares, digestOf(codeOf(9)), (left, right) => left === right);

    // Assert
    should(found).be.undefined();
  });

  it('should compare against every share and then a dummy, whether or not one matched', () => {
    // Arrange
    const shares = sharesDoc(storedShare(1), storedShare(2), storedShare(3));
    const seen: Array<[string, string]> = [];
    const compare = (left: string, right: string): boolean => {
      seen.push([left, right]);
      return left === right;
    };

    // Act
    locateShare(shares, digestOf(codeOf(1)), compare);
    const hit = seen.length;
    seen.length = 0;
    locateShare(shares, digestOf(codeOf(9)), compare);
    const miss = seen.length;

    // Assert
    should(hit).equal(4);
    should(miss).equal(4);
    should(seen[3]).eql([DUMMY_DIGEST, digestOf(codeOf(9))]);
  });

  it('should still compare once, against the dummy, when there is no share at all', () => {
    // Arrange
    const seen: string[] = [];

    // Act
    const found = locateShare(sharesDoc(), digestOf(codeOf(1)), (left, right) => {
      seen.push(left);
      return left === right;
    });

    // Assert
    should(found).be.undefined();
    should(seen).eql([DUMMY_DIGEST]);
  });
});

describe('admitJoin: step 2 refusals, in order', () => {
  it('should refuse a code nobody has as unknown, and say it is not live', () => {
    // Arrange
    const probe = probeOf({ code: codeOf(9), shares: sharesDoc(storedShare(1)) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('share_refused');
    should(result.reason).equal('unknown');
    should(result.leftLive).be.false();
    should(result.shares).equal(probe.shares);
  });

  it('should refuse a spent code as spent', () => {
    // Arrange
    const probe = probeOf({ shares: sharesDoc(storedShare(1, { state: 'spent', used: 1 })) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('share_refused');
    should(result.reason).equal('spent');
    should(result.leftLive).be.false();
  });

  it('should refuse a code past its expiry as expired', () => {
    // Arrange
    const probe = probeOf({ shares: sharesDoc(storedShare(1, { expiresAt: iso(T0) })) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('share_refused');
    should(result.reason).equal('expired');
    should(result.leftLive).be.false();
  });

  it('should refuse a code the owner ended as ended', () => {
    // Arrange
    const probe = probeOf({ shares: sharesDoc(storedShare(1, { state: 'ended' })) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('share_refused');
    should(result.reason).equal('ended');
    should(result.leftLive).be.false();
  });

  it('should refuse a code made for a member who has since gone, and leave it alone', () => {
    // Arrange
    const probe = probeOf({ shares: sharesDoc(storedShare(1, { memberKind: 'existing' })) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('share_refused');
    should(result.reason).equal('member-gone');
    should(result.leftLive).be.true();
    should(result.shares).equal(probe.shares);
  });

  it('should not look for room before it has looked for a live code', () => {
    // Arrange: the publisher is full AND the code is spent
    const full = membersDoc(...Array.from({ length: 128 }, (_, index) => storedMember(index + 10)));
    const probe = probeOf({ members: full, shares: sharesDoc(storedShare(1, { state: 'spent' })) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.reason).equal('spent');
  });
});

describe('admitJoin: room', () => {
  const full = membersDoc(...Array.from({ length: 128 }, (_, index) => storedMember(index + 10)));

  it('should refuse a new member when the publisher already has the most members, and leave the code live', () => {
    // Arrange
    const probe = probeOf({ members: full, shares: sharesDoc(storedShare(1)) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('members_full');
    should(result.reason).equal('members');
    should(result.leftLive).be.true();
    should(result.shares).equal(probe.shares);
  });

  it('should admit a browser of a member who already exists even when the publisher is full', () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { memberId: memberId(10), memberKind: 'existing' }));
    const probe = probeOf({ members: full, shares });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(result.ok).be.true();
  });

  it('should count a join waiting for its key as a member', () => {
    // Arrange: 127 stored + one new member already holding a slot + this one = 129
    const members = membersDoc(...Array.from({ length: 127 }, (_, index) => storedMember(index + 10)));
    const probe = probeOf({
      members,
      shares: sharesDoc(storedShare(1)),
      pending: [joinReservation(2, 900)],
    });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.reason).equal('members');
    should(result.leftLive).be.true();
  });

  it('should not count a waiting join for a member that is already stored as a new member', () => {
    // Arrange: 127 stored, and the waiting join is for one of them
    const members = membersDoc(...Array.from({ length: 127 }, (_, index) => storedMember(index + 10)));
    const probe = probeOf({
      members,
      shares: sharesDoc(storedShare(1)),
      pending: [joinReservation(2, 10)],
    });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(result.ok).be.true();
  });

  it('should refuse a browser when the publisher already has the most browsers', () => {
    // Arrange: 200 + 200 + 111 + 1 = 512, and the member joining already exists
    const members = membersDoc(
      storedMember(10, { keys: keysOf(1, 200) }),
      storedMember(11, { keys: keysOf(201, 200) }),
      storedMember(12, { keys: keysOf(401, 111) }),
      storedMember(13, { keys: keysOf(600, 1) }),
    );
    const probe = probeOf({
      members,
      shares: sharesDoc(storedShare(1, { memberId: memberId(13), memberKind: 'existing' })),
    });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('members_full');
    should(result.reason).equal('keys');
    should(result.leftLive).be.true();
  });

  it('should count a waiting join as a browser', () => {
    // Arrange: 511 stored + one waiting + this one = 513
    const members = membersDoc(
      storedMember(10, { keys: keysOf(1, 200) }),
      storedMember(11, { keys: keysOf(201, 200) }),
      storedMember(12, { keys: keysOf(401, 111) }),
    );
    const probe = probeOf({
      members,
      shares: sharesDoc(storedShare(1, { memberId: memberId(12), memberKind: 'existing' })),
      pending: [joinReservation(2, 11)],
    });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.reason).equal('keys');
  });

  it('should refuse a browser when the member already has the most browsers', () => {
    // Arrange
    const members = membersDoc(storedMember(1, { keys: keysOf(1, 200) }));
    const probe = probeOf({ members, shares: sharesDoc(storedShare(1, { memberKind: 'existing' })) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('members_full');
    should(result.reason).equal('member-keys');
    should(result.leftLive).be.true();
  });

  it('should admit the last browser a member may have', () => {
    // Arrange
    const members = membersDoc(storedMember(1, { keys: keysOf(1, 199) }));
    const probe = probeOf({ members, shares: sharesDoc(storedShare(1, { memberKind: 'existing' })) });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(result.ok).be.true();
  });

  it("should count a waiting join for the same member against that member's browsers", () => {
    // Arrange: 199 stored + one waiting + this one = 201
    const members = membersDoc(storedMember(1, { keys: keysOf(1, 199) }));
    const probe = probeOf({
      members,
      shares: sharesDoc(storedShare(1, { memberKind: 'existing' })),
      pending: [joinReservation(2, 1)],
    });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.reason).equal('member-keys');
  });

  it("should not count a waiting join for another member against this member's browsers", () => {
    // Arrange
    const members = membersDoc(storedMember(1, { keys: keysOf(1, 199) }), storedMember(2));
    const probe = probeOf({
      members,
      shares: sharesDoc(storedShare(1, { memberKind: 'existing' })),
      pending: [joinReservation(2, 2)],
    });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(result.ok).be.true();
  });

  it('should refuse when the catalogs together would pass the most a member may read', () => {
    // Arrange: 60 held + 5 new = 65
    const members = membersDoc(storedMember(1, { catalogIds: catalogIds(1, 60) }));
    const shares = sharesDoc(storedShare(1, { memberKind: 'existing', catalogIds: catalogIds(61, 5) }));
    const probe = probeOf({ members, shares });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('members_full');
    should(result.reason).equal('catalogs');
    should(result.leftLive).be.true();
  });

  it('should count a catalog the member already reads once', () => {
    // Arrange: 60 held + 5 offered of which 3 are held = 62
    const members = membersDoc(storedMember(1, { catalogIds: catalogIds(1, 60) }));
    const shares = sharesDoc(storedShare(1, { memberKind: 'existing', catalogIds: catalogIds(58, 5) }));
    const probe = probeOf({ members, shares });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(result.ok).be.true();
  });

  it('should refuse a share whose own catalogs pass the most, for a member who does not exist yet', () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { catalogIds: catalogIds(1, 65) }));
    const probe = probeOf({ shares });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.reason).equal('catalogs');
  });

  it('should report the members limit before the browsers limit', () => {
    // Arrange: 128 members holding 512+ browsers, and a new member joining
    const members = membersDoc(
      storedMember(10, { keys: keysOf(1, 200) }),
      storedMember(11, { keys: keysOf(201, 200) }),
      storedMember(12, { keys: keysOf(401, 112) }),
      ...Array.from({ length: 125 }, (_, index) => storedMember(index + 20)),
    );
    const probe = probeOf({ members, shares: sharesDoc(storedShare(1)) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.reason).equal('members');
  });

  it("should report the browsers limit before the member's own browsers limit", () => {
    // Arrange: the joining member has 200 browsers and the publisher is past the most too
    const members = membersDoc(
      storedMember(1, { keys: keysOf(1, 200) }),
      storedMember(2, { keys: keysOf(201, 200) }),
      storedMember(3, { keys: keysOf(401, 112) }),
    );
    const probe = probeOf({ members, shares: sharesDoc(storedShare(1, { memberKind: 'existing' })) });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.reason).equal('keys');
  });

  it("should report the member's own browsers limit before the catalogs limit", () => {
    // Arrange
    const members = membersDoc(storedMember(1, { keys: keysOf(1, 200), catalogIds: catalogIds(1, 64) }));
    const shares = sharesDoc(storedShare(1, { memberKind: 'existing', catalogIds: catalogIds(70, 1) }));
    const probe = probeOf({ members, shares });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.reason).equal('member-keys');
  });

  it('should refuse for room before it looks at the hourly count', () => {
    // Arrange
    const members = membersDoc(storedMember(1, { keys: keysOf(1, 200) }));
    const shares = sharesDoc(storedShare(1, { memberKind: 'existing', successes: recent(60) }));

    // Act
    const result = refusedOf(admitJoin(probeOf({ members, shares })));

    // Assert
    should(result.reason).equal('member-keys');
  });
});

describe('admitJoin: the hourly count', () => {
  it('should refuse the join after the most successes in the last hour, and leave the code live', () => {
    // Arrange
    const probe = probeOf({
      shares: sharesDoc(storedShare(1, { uses: { kind: 'multi', cap: 200 }, used: 60, successes: recent(60) })),
    });

    // Act
    const result = refusedOf(admitJoin(probe));

    // Assert
    should(result.refusal).equal('members_full');
    should(result.reason).equal('hourly');
    should(result.leftLive).be.true();
    should(result.shares).equal(probe.shares);
  });

  it('should admit the sixtieth success of the hour', () => {
    // Arrange
    const probe = probeOf({
      shares: sharesDoc(storedShare(1, { uses: { kind: 'multi', cap: 200 }, used: 59, successes: recent(59) })),
    });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(result.ok).be.true();
    should(shareOf(result.shares, 1).successes).have.length(60);
  });

  it('should stop counting a success once it is an hour old, boundary included', () => {
    // Arrange: 59 recent and one exactly an hour old
    const successes = [...recent(59), T0 - HOUR_MS];
    const probe = probeOf({
      shares: sharesDoc(storedShare(1, { uses: { kind: 'multi', cap: 200 }, used: 60, successes })),
    });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(result.ok).be.true();
    should(shareOf(result.shares, 1).successes).eql([...recent(59), T0]);
  });

  it('should count each share on its own', () => {
    // Arrange
    const busy = storedShare(1, { uses: { kind: 'multi', cap: 200 }, used: 60, successes: recent(60) });
    const quiet = storedShare(2, { uses: { kind: 'multi', cap: 200 } });
    const shares = sharesDoc(busy, quiet);

    // Act
    const refused = admitJoin(probeOf({ shares, code: codeOf(1) }));
    const admitted = admitJoin(probeOf({ shares, code: codeOf(2) }));

    // Assert
    should(refused.ok).be.false();
    should(admitted.ok).be.true();
  });
});

describe('admitJoin: spending the code', () => {
  it("should burn a single-use code and reserve the key's slot for the share's member", () => {
    // Arrange
    const share = storedShare(1, { memberLabel: 'Alice', catalogIds: [catalogId(1), catalogId(2)] });
    const probe = probeOf({ shares: sharesDoc(share) });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(result.ok).be.true();
    should(joinOf(result)).eql({
      kind: 'join',
      reservationId: 'rsv-new',
      shareId: shareId(1),
      memberId: memberId(1),
      memberLabel: 'Alice',
      catalogIds: [catalogId(1), catalogId(2)],
    });
    const spent = shareOf(result.shares, 1);
    should(spent.state).equal('spent');
    should(spent.used).equal(1);
    should(spent.successes).eql([T0]);
    should(probe.shares.shares[0]?.state).equal('live');
  });

  it('should count one use of a multi-use code and keep it live below its cap', () => {
    // Arrange
    const share = storedShare(1, { uses: { kind: 'multi', cap: 3 }, used: 1, successes: [T0 - 5] });
    const probe = probeOf({ shares: sharesDoc(share) });

    // Act
    const result = admitJoin(probe);

    // Assert
    const after = shareOf(result.shares, 1);
    should(after.state).equal('live');
    should(after.used).equal(2);
    should(after.successes).eql([T0 - 5, T0]);
  });

  it('should spend a multi-use code at its cap', () => {
    // Arrange
    const share = storedShare(1, { uses: { kind: 'multi', cap: 3 }, used: 2 });
    const probe = probeOf({ shares: sharesDoc(share) });

    // Act
    const result = admitJoin(probe);

    // Assert
    const after = shareOf(result.shares, 1);
    should(after.state).equal('spent');
    should(after.used).equal(3);
  });

  it('should name the member by the stored label when the member exists', () => {
    // Arrange
    const members = membersDoc(storedMember(1, { label: 'Alice (renamed)' }));
    const shares = sharesDoc(storedShare(1, { memberLabel: 'Alice', memberKind: 'new' }));

    // Act
    const reservation = joinOf(admitJoin(probeOf({ members, shares })));

    // Assert
    should(reservation.memberLabel).equal('Alice (renamed)');
  });

  it('should leave every other share alone', () => {
    // Arrange
    const other = storedShare(2);
    const probe = probeOf({ shares: sharesDoc(storedShare(1), other) });

    // Act
    const result = admitJoin(probe);

    // Assert
    should(shareOf(result.shares, 2)).equal(other);
  });
});

describe('admitRedeem: the code', () => {
  it('should refuse an unknown code before it looks at the member', () => {
    // Arrange
    const probe = probeOf({ code: codeOf(9), shares: sharesDoc(storedShare(1)) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(404)));

    // Assert
    should(result.refusal).equal('share_refused');
    should(result.reason).equal('unknown');
    should(result.leftLive).be.false();
  });

  it('should refuse a spent code as spent', () => {
    // Arrange
    const probe = probeOf({
      members: membersDoc(storedMember(1)),
      shares: sharesDoc(storedShare(1, { state: 'spent' })),
    });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.reason).equal('spent');
    should(result.leftLive).be.false();
  });

  it('should refuse a browser whose member does not exist, and leave the code live', () => {
    // Arrange
    const probe = probeOf({ shares: sharesDoc(storedShare(1)) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.refusal).equal('member_unknown');
    should(result.reason).equal('unknown-member');
    should(result.leftLive).be.true();
    should(result.shares).equal(probe.shares);
  });
});

describe('admitRedeem: a single-use code (owner decision Q5)', () => {
  const holder = storedMember(1, { catalogIds: [catalogId(1)] });

  it("should burn the code and reserve the catalogs it adds, in the share's order", () => {
    // Arrange
    const share = storedShare(1, { memberKind: 'existing', catalogIds: [catalogId(3), catalogId(1), catalogId(2)] });
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(share) });

    // Act
    const result = admitRedeem(probe, memberId(1));

    // Assert
    should(redeemOf(result)).eql({
      kind: 'redeem',
      reservationId: 'rsv-new',
      shareId: shareId(1),
      memberId: memberId(1),
      added: [catalogId(3), catalogId(2)],
    });
    const spent = shareOf(result.shares, 1);
    should(spent.state).equal('spent');
    should(spent.successes).eql([T0]);
  });

  it('should burn the code even when the redeem adds nothing', () => {
    // Arrange
    const share = storedShare(1, { memberKind: 'existing', catalogIds: [catalogId(1)] });
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(share) });

    // Act
    const result = admitRedeem(probe, memberId(1));

    // Assert
    should(redeemOf(result).added).eql([]);
    should(shareOf(result.shares, 1).state).equal('spent');
  });

  it("should burn the code first when another member's browser presents it, then refuse and say who", () => {
    // Arrange: the code was made for member 2; member 1's browser presents it
    const share = storedShare(2, { memberKind: 'existing' });
    const probe = probeOf({ members: membersDoc(holder, storedMember(2)), shares: sharesDoc(share), code: codeOf(2) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.refusal).equal('share_other_member');
    should(result.reason).equal('other-member');
    should(result.leftLive).be.false();
    should(result.crossMember).eql({ shareId: shareId(2), memberId: memberId(1), shareMemberId: memberId(2) });
    const burned = shareOf(result.shares, 2);
    should(burned.state).equal('spent');
    should(burned.used).equal(1);
    should(burned.successes).eql([]);
  });

  it('should refuse a code made for a new member as a new-member code, and still burn it', () => {
    // Arrange
    const share = storedShare(2, { memberKind: 'new' });
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(share), code: codeOf(2) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.refusal).equal('share_new_member');
    should(result.reason).equal('new-member');
    should(result.leftLive).be.false();
    should(shareOf(result.shares, 2).state).equal('spent');
    should(result.crossMember?.shareMemberId).equal(memberId(2));
  });

  it("should refuse for the catalogs limit and leave the code live when the owner's own browser would pass it", () => {
    // Arrange: 60 held + 5 new = 65
    const member = storedMember(1, { catalogIds: catalogIds(1, 60) });
    const share = storedShare(1, { memberKind: 'existing', catalogIds: catalogIds(61, 5) });
    const probe = probeOf({ members: membersDoc(member), shares: sharesDoc(share) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.refusal).equal('members_full');
    should(result.reason).equal('catalogs');
    should(result.leftLive).be.true();
    should(result.shares).equal(probe.shares);
  });

  it("should not look at the catalogs limit for another member's browser: it burns and refuses", () => {
    // Arrange
    const member = storedMember(1, { catalogIds: catalogIds(1, 60) });
    const share = storedShare(2, { memberKind: 'existing', catalogIds: catalogIds(61, 5) });
    const probe = probeOf({ members: membersDoc(member), shares: sharesDoc(share), code: codeOf(2) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.reason).equal('other-member');
    should(result.leftLive).be.false();
  });

  it('should refuse for the hourly count before it burns anything, and leave the code live', () => {
    // Arrange: a cross-member presentation, but the share is at its hourly most
    const share = storedShare(2, { memberKind: 'existing', successes: recent(60) });
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(share), code: codeOf(2) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.refusal).equal('members_full');
    should(result.reason).equal('hourly');
    should(result.leftLive).be.true();
    should(result.shares).equal(probe.shares);
    should(result).not.have.property('crossMember');
  });

  it('should refuse a matching member for the hourly count too', () => {
    // Arrange
    const share = storedShare(1, { memberKind: 'existing', successes: recent(60) });
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(share) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.reason).equal('hourly');
    should(result.leftLive).be.true();
  });
});

describe('admitRedeem: a multi-use code (owner decision Q5)', () => {
  const holder = storedMember(1, { catalogIds: [catalogId(1)] });
  const multi = (overrides: Partial<StoredShare> = {}) =>
    storedShare(1, { uses: { kind: 'multi', cap: 3 }, catalogIds: [catalogId(1), catalogId(2)], ...overrides });

  it('should count a use when the redeem adds a catalog', () => {
    // Arrange
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(multi()) });

    // Act
    const result = admitRedeem(probe, memberId(1));

    // Assert
    should(redeemOf(result).added).eql([catalogId(2)]);
    const after = shareOf(result.shares, 1);
    should(after.used).equal(1);
    should(after.state).equal('live');
    should(after.successes).eql([T0]);
  });

  it('should spend the code when the use it counts reaches the cap', () => {
    // Arrange
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(multi({ used: 2 })) });

    // Act
    const result = admitRedeem(probe, memberId(1));

    // Assert
    should(shareOf(result.shares, 1).state).equal('spent');
  });

  it('should count nothing when the redeem adds no catalog', () => {
    // Arrange
    const member = storedMember(1, { catalogIds: [catalogId(1), catalogId(2)] });
    const probe = probeOf({ members: membersDoc(member), shares: sharesDoc(multi()) });

    // Act
    const result = admitRedeem(probe, memberId(1));

    // Assert
    should(redeemOf(result).added).eql([]);
    should(result.shares).equal(probe.shares);
  });

  it("should refuse a different member's browser without counting, for an existing-member share", () => {
    // Arrange: the code names member 2; member 1's browser presents it
    const share = multi({ memberId: memberId(2), memberKind: 'existing' });
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(share) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.refusal).equal('share_other_member');
    should(result.reason).equal('other-member');
    should(result.leftLive).be.true();
    should(result.shares).equal(probe.shares);
    should(result).not.have.property('crossMember');
  });

  it("should refuse a different member's browser without counting, for a new-member share", () => {
    // Arrange
    const share = multi({ memberId: memberId(2), memberKind: 'new' });
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(share) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.refusal).equal('share_new_member');
    should(result.reason).equal('new-member');
    should(result.leftLive).be.true();
    should(result.shares).equal(probe.shares);
  });

  it('should refuse for the catalogs limit and leave the code live', () => {
    // Arrange
    const member = storedMember(1, { catalogIds: catalogIds(1, 60) });
    const share = multi({ catalogIds: catalogIds(61, 5) });
    const probe = probeOf({ members: membersDoc(member), shares: sharesDoc(share) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.reason).equal('catalogs');
    should(result.leftLive).be.true();
  });

  it('should refuse for the hourly count and leave the code live', () => {
    // Arrange
    const probe = probeOf({ members: membersDoc(holder), shares: sharesDoc(multi({ successes: recent(60) })) });

    // Act
    const result = refusedOf(admitRedeem(probe, memberId(1)));

    // Assert
    should(result.reason).equal('hourly');
    should(result.leftLive).be.true();
  });
});
