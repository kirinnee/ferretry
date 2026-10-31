import { describe, it } from 'bun:test';
import should from 'should';
import { EMPTY_SHARES_DOCUMENT } from '../../../src/lib/catalog-members/document.ts';
import {
  catalogId,
  codeOf,
  failure,
  flush,
  iso,
  joinOf,
  joinReservation,
  keyId,
  memberId,
  membersDoc,
  memberOf,
  MINUTE,
  newKey,
  redeemOf,
  refusal,
  refusedOf,
  rig,
  shareId,
  shareOf,
  sharesDoc,
  singleForMember,
  storedKey,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

describe('CatalogMemberService: loading', () => {
  it('should read each file once, however many callers ask at the same time', async () => {
    // Arrange
    const r = await rig({ unloaded: true });

    // Act
    await Promise.all([r.service.ready(), r.service.ready(), r.service.listShares(), r.service.listMembers()]);
    await r.service.ready();

    // Assert
    should(r.members.reads).equal(1);
    should(r.shares.reads).equal(1);
  });

  it('should fail loudly on a damaged file, and load once the file is whole again', async () => {
    // Arrange
    const r = await rig({ unloaded: true });
    r.members.unreadable = new Error('members.json is damaged');

    // Act
    const first = await failure(() => r.service.ready());
    const listing = await failure(() => r.service.listMembers());
    r.members.unreadable = undefined;
    await r.service.ready();

    // Assert
    should(first.message).equal('members.json is damaged');
    should(listing.message).equal('members.json is damaged');
    should(r.members.reads).equal(3);
    should((await r.service.listMembers()).members).eql([]);
  });

  it('should fail on a damaged shares file as well', async () => {
    // Arrange
    const r = await rig({ unloaded: true });
    r.shares.unreadable = new Error('shares.json is damaged');

    // Act
    const error = await failure(() => r.service.listShares());

    // Assert
    should(error.message).equal('shares.json is damaged');
  });

  it('should refuse a join, spending nothing, when the caller forgot to wait for ready', async () => {
    // Arrange
    const r = await rig({ unloaded: true, shares: sharesDoc(storedShare(1)) });

    // Act
    const join = refusedOf(r.service.admitJoin(codeOf(1), T0));
    const redeem = refusedOf(r.service.admitRedeem(codeOf(1), memberId(1), T0));
    await r.service.ready();

    // Assert
    should(join.refusal).equal('share_refused');
    should(join.reason).equal('unknown');
    should(join.leftLive).be.false();
    should(join.shares).equal(EMPTY_SHARES_DOCUMENT);
    should(redeem.reason).equal('unknown');
    should(r.service.admitJoin(codeOf(1), T0).ok).be.true();
  });

  it('should say the store was not read, not guess, when a commit comes before ready', async () => {
    // Arrange
    const r = await rig({ unloaded: true });

    // Act
    const error = await refusal(() => r.service.commit(joinReservation(1, 1), newKey(1)));

    // Assert
    should(error.refusal).equal('store_damaged');
    should(r.members.writes).equal(0);
  });

  it('should do nothing at all to release a slot when nothing was read', async () => {
    // Arrange
    const r = await rig({ unloaded: true });

    // Act
    await r.service.release(joinReservation(1, 1));

    // Assert
    should(r.shares.writes).equal(0);
  });
});

describe('CatalogMemberService.commit', () => {
  it('should file a new member and their key, shares first, and answer the joined member', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    r.log.length = 0;

    // Act
    const joined = await r.service.commit(reservation, newKey(1, 'Firefox'));

    // Assert
    should(r.log).eql(['shares.write', 'members.write']);
    should(joined.memberId).equal(memberId(1));
    should(joined.keyId.startsWith('mk_')).be.true();
    should(joined.label).equal('Member 1');
    should(joined.catalogCount).equal(1);
    should(joined.passkeyWindowEndsAt).equal(iso(T0 + 10 * MINUTE));
    const member = memberOf(r.members.document, 1);
    should(member.catalogIds).eql([catalogId(1)]);
    should(member.createdAt).equal(iso(T0));
    should(member.keys).have.length(1);
    should(member.keys[0]).eql({
      keyId: joined.keyId,
      memberKey: newKey(1).memberKey,
      boxKey: newKey(1).boxKey,
      clientName: 'Firefox',
      joinedAt: iso(T0),
      passkeyCount: 0,
      passkeyWindowEndsAt: iso(T0 + 10 * MINUTE),
    });
    const share = shareOf(r.shares.document, 1);
    should(share.state).equal('spent');
    should(share.usedBy).eql([{ clientName: 'Firefox', keyId: joined.keyId, at: iso(T0) }]);
  });

  it('should stamp the key with the time of the commit, not of the admission', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    r.clock.now = T0 + 5 * MINUTE;

    // Act
    const joined = await r.service.commit(reservation, newKey(1));

    // Assert
    should(joined.passkeyWindowEndsAt).equal(iso(T0 + 15 * MINUTE));
    should(memberOf(r.members.document, 1).createdAt).equal(iso(T0 + 5 * MINUTE));
  });

  it('should add a browser to an existing member and merge the catalogs without repeating one', async () => {
    // Arrange
    const members = membersDoc(storedMember(7, { catalogIds: [catalogId(1)], keys: [storedKey(7)] }));
    const shares = sharesDoc(
      storedShare(1, { memberId: memberId(7), memberKind: 'existing', catalogIds: [catalogId(1), catalogId(2)] }),
    );
    const r = await rig({ members, shares });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));

    // Act
    const joined = await r.service.commit(reservation, newKey(8));

    // Assert
    const member = memberOf(r.members.document, 7);
    should(joined.catalogCount).equal(2);
    should(joined.label).equal('Member 7');
    should(member.catalogIds).eql([catalogId(1), catalogId(2)]);
    should(member.keys.map(key => key.keyId)).eql([keyId(7), joined.keyId]);
    should(r.members.document.members).have.length(1);
  });

  it('should give two browsers of one multi-use code the one member, and two different key ids', async () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { uses: { kind: 'multi', cap: 3 } }));
    const r = await rig({ shares });
    const first = joinOf(r.service.admitJoin(codeOf(1), T0));
    const second = joinOf(r.service.admitJoin(codeOf(1), T0));

    // Act
    const one = await r.service.commit(first, newKey(1));
    const two = await r.service.commit(second, newKey(2));

    // Assert
    should(two.memberId).equal(one.memberId);
    should(two.keyId).not.equal(one.keyId);
    should(memberOf(r.members.document, 1).keys).have.length(2);
    should(shareOf(r.shares.document, 1).usedBy).have.length(2);
  });

  it('should refuse a browser key that is already registered, and write nothing', async () => {
    // Arrange
    const members = membersDoc(storedMember(7, { keys: [storedKey(5)] }));
    const r = await rig({ members, shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));

    // Act
    const error = await refusal(() => r.service.commit(reservation, newKey(5)));

    // Assert
    should(error.refusal).equal('share_refused');
    should(error.message).equal('that browser key is already registered here');
    should(r.members.writes).equal(0);
    should(r.shares.writes).equal(0);
  });

  it('should leave the code spent and take the member back out when the members file will not write', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.commit(reservation, newKey(1)));
    await r.service.release(reservation);

    // Assert
    should(error.message).equal('members disk full');
    should((await r.service.listMembers()).members).eql([]);
    const share = (await r.service.listShares()).shares[0];
    should(share?.state).equal('spent');
    should(share?.usedBy).eql([]);
    should(refusedOf(r.service.admitJoin(codeOf(1), T0)).reason).equal('spent');
  });

  it('should not try the members file when the shares file will not write', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    r.shares.failing = true;

    // Act
    const error = await failure(() => r.service.commit(reservation, newKey(1)));

    // Assert
    should(error.message).equal('shares disk full');
    should(r.members.writes).equal(0);
    should((await r.service.listMembers()).members).eql([]);
  });

  it('should keep a change made while its write was waiting, and put back only what is still its own', async () => {
    // Arrange: park the commit's shares write, spend another code, then let the first write fail
    const r = await rig({ shares: sharesDoc(storedShare(1), storedShare(2)) });
    const first = joinOf(r.service.admitJoin(codeOf(1), T0));
    const resume = r.shares.hold();
    const settled = r.service.commit(first, newKey(1)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();

    // Act
    joinOf(r.service.admitJoin(codeOf(2), T0));
    r.shares.failing = true;
    resume();
    const error = await settled;

    // Assert
    should((error as Error).message).equal('shares disk full');
    should((await r.service.listMembers()).members).eql([]);
    const listed = (await r.service.listShares()).shares;
    should(listed.map(share => share.state)).eql(['spent', 'spent']);
    should(listed.find(share => share.shareId === shareId(1))?.usedBy).have.length(1);
    should(refusedOf(r.service.admitJoin(codeOf(2), T0)).reason).equal('spent');
  });

  it('should write one commit after another even when they are asked together', async () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { uses: { kind: 'multi', cap: 3 } }));
    const r = await rig({ shares });
    const first = joinOf(r.service.admitJoin(codeOf(1), T0));
    const second = joinOf(r.service.admitJoin(codeOf(1), T0));
    r.log.length = 0;

    // Act
    await Promise.all([r.service.commit(first, newKey(1)), r.service.commit(second, newKey(2))]);

    // Assert
    should(r.log).eql(['shares.write', 'members.write', 'shares.write', 'members.write']);
    should(memberOf(r.members.document, 1).keys).have.length(2);
  });

  it('should carry on with the next write after one that failed', async () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { uses: { kind: 'multi', cap: 3 } }));
    const r = await rig({ shares });
    const first = joinOf(r.service.admitJoin(codeOf(1), T0));
    const second = joinOf(r.service.admitJoin(codeOf(1), T0));
    r.members.failing = true;
    const error = await failure(() => r.service.commit(first, newKey(1)));
    r.members.failing = false;

    // Act
    await r.service.commit(second, newKey(2));

    // Assert
    should(error.message).equal('members disk full');
    should(memberOf(r.members.document, 1).keys).have.length(1);
  });
});

describe('CatalogMemberService.release', () => {
  it('should free the slot but leave the code spent, and write the burn to disk', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    should(shareOf(r.shares.document, 1).state).equal('live');

    // Act
    await r.service.release(reservation);

    // Assert
    should(shareOf(r.shares.document, 1).state).equal('spent');
    should(refusedOf(r.service.admitJoin(codeOf(1), T0)).reason).equal('spent');
  });

  it('should not complain when the disk that just failed fails again', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    r.shares.failing = true;

    // Act
    await r.service.release(reservation);

    // Assert
    should(r.shares.writes).equal(1);
    should(shareOf(r.shares.document, 1).state).equal('live');
    should(refusedOf(r.service.admitJoin(codeOf(1), T0)).reason).equal('spent');
  });
});

describe('CatalogMemberService.commitRedeem', () => {
  const holders = () =>
    membersDoc(
      storedMember(7, { catalogIds: [catalogId(1)], keys: [storedKey(7)] }),
      storedMember(8, { catalogIds: [catalogId(1)], keys: [storedKey(8)] }),
    );
  const by = { keyId: keyId(7), clientName: 'Browser 7' };

  it('should file the catalogs a redeem adds and record who spent it, shares first', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(1), catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    r.log.length = 0;

    // Act
    await r.service.commitRedeem(reservation, by);

    // Assert
    should(r.log).eql(['shares.write', 'members.write']);
    should(memberOf(r.members.document, 7).catalogIds).eql([catalogId(1), catalogId(2)]);
    should(r.shares.document.shares[0]?.usedBy).eql([{ clientName: 'Browser 7', keyId: keyId(7), at: iso(T0) }]);
    should(memberOf(r.members.document, 8).catalogIds).eql([catalogId(1)]);
  });

  it('should write nothing for a redeem that adds nothing', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(1)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    const writes = [r.members.writes, r.shares.writes];

    // Act
    await r.service.commitRedeem(reservation, by);

    // Assert
    should(reservation.added).eql([]);
    should([r.members.writes, r.shares.writes]).eql(writes);
  });

  it('should refuse when the member has gone since the admission', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    await r.service.revokeMember(memberId(7));

    // Act
    const error = await refusal(() => r.service.commitRedeem(reservation, by));

    // Assert
    should(error.refusal).equal('member_unknown');
  });

  it('should put the catalogs back, and leave the code spent, when the members file will not write', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.commitRedeem(reservation, by));

    // Assert
    should(error.message).equal('members disk full');
    should((await r.service.listMembers()).members.find(member => member.memberId === memberId(7))?.catalogIds).eql([
      catalogId(1),
    ]);
    const share = (await r.service.listShares()).shares[0];
    should(share?.state).equal('spent');
    should(share?.usedBy).eql([]);
  });

  it('should put the catalogs back when the shares file will not write, and not touch the members file', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    r.shares.failing = true;
    const writes = r.members.writes;

    // Act
    const error = await failure(() => r.service.commitRedeem(reservation, by));

    // Assert
    should(error.message).equal('shares disk full');
    should(r.members.writes).equal(writes);
    should((await r.service.listMembers()).members[0]?.catalogIds).eql([catalogId(1)]);
  });
});
