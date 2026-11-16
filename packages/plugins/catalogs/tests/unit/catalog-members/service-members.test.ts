import { describe, it } from 'bun:test';
import should from 'should';
import {
  catalogId,
  codeOf,
  failure,
  keyId,
  memberId,
  memberOf,
  membersDoc,
  refusal,
  refusedOf,
  rig,
  shareOf,
  sharesDoc,
  storedKey,
  storedMember,
  storedShare,
  DAY,
  T0,
} from './support.ts';

const seven = () => storedMember(7, { catalogIds: [catalogId(1), catalogId(2)], keys: [storedKey(71), storedKey(72)] });

const fixture = () => ({
  members: membersDoc(seven(), storedMember(8, { keys: [storedKey(81)] })),
  shares: sharesDoc(
    storedShare(1, { memberId: memberId(7), memberKind: 'existing' }),
    storedShare(2, { memberId: memberId(7), memberKind: 'existing', state: 'spent' }),
    storedShare(3, { memberId: memberId(8), memberKind: 'existing' }),
  ),
});

describe('CatalogMemberService.listMembers', () => {
  it('should list nobody for nobody', async () => {
    // Arrange
    const r = await rig();

    // Act / Assert
    should(await r.service.listMembers()).eql({ members: [] });
  });

  it('should list each member and their browsers by name, and never a key', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven(), storedMember(8)) });

    // Act
    const list = await r.service.listMembers();

    // Assert
    should(list.members.map(member => member.memberId)).eql([memberId(7), memberId(8)]);
    should(list.members[0]?.keys.map(key => key.clientName)).eql(['Browser 71', 'Browser 72']);
    const text = JSON.stringify(list);
    should(text).not.containEql(storedKey(71).memberKey);
    should(text).not.containEql(storedKey(71).boxKey);
  });

  it('should load the documents first when nobody has yet', async () => {
    // Arrange
    const r = await rig({ unloaded: true, members: membersDoc(seven()) });

    // Act
    const list = await r.service.listMembers();

    // Assert
    should(list.members).have.length(1);
  });
});

describe('CatalogMemberService.renameMember', () => {
  it('should rename the member, write the members file first, and answer the new view', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    const view = await r.service.renameMember(memberId(7), 'Dana');

    // Assert
    should(view.label).equal('Dana');
    should(view.memberId).equal(memberId(7));
    should(memberOf(r.members.document, 7).label).equal('Dana');
    should(r.log).eql(['members.write', 'shares.write']);
  });

  it("should carry the new name to that member's shares, and to no one else's", async () => {
    // Arrange
    const shares = sharesDoc(
      storedShare(1, { memberId: memberId(7), memberLabel: 'Old', memberKind: 'existing' }),
      storedShare(2, { memberId: memberId(8), memberLabel: 'Other' }),
    );
    const r = await rig({ members: membersDoc(seven()), shares });

    // Act
    await r.service.renameMember(memberId(7), 'Dana');

    // Assert
    should(shareOf(r.shares.document, 1).memberLabel).equal('Dana');
    should(shareOf(r.shares.document, 2).memberLabel).equal('Other');
  });

  it('should refuse a member that is not there, and write nothing', async () => {
    // Arrange
    const r = await rig();

    // Act
    const error = await refusal(() => r.service.renameMember(memberId(9), 'Dana'));

    // Assert
    should(error.refusal).equal('member_unknown');
    should(r.log).eql([]);
  });

  it('should keep the old name, and leave the shares alone, when the members file will not write', async () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { memberId: memberId(7), memberLabel: 'Old', memberKind: 'existing' }));
    const r = await rig({ members: membersDoc(seven()), shares });
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.renameMember(memberId(7), 'Dana'));

    // Assert
    should(error.message).equal('members disk full');
    should((await r.service.listMembers()).members[0]?.label).equal('Member 7');
    should(r.shares.writes).equal(0);
  });

  it('should throw, with the member already renamed, when only the shares file will not write', async () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { memberId: memberId(7), memberLabel: 'Old', memberKind: 'existing' }));
    const r = await rig({ members: membersDoc(seven()), shares });
    r.shares.failing = true;

    // Act
    const error = await failure(() => r.service.renameMember(memberId(7), 'Dana'));

    // Assert
    should(error.message).equal('shares disk full');
    should((await r.service.listShares()).shares[0]?.memberLabel).equal('Old');
    should((await r.service.listMembers()).members[0]?.label).equal('Dana');
  });
});

describe('CatalogMemberService.revokeMember', () => {
  it('should write the members file, then the shares file, then close what is open, and count what went', async () => {
    // Arrange
    const r = await rig(fixture());

    // Act
    const revoked = await r.service.revokeMember(memberId(7));

    // Assert — every browser goes as removing one does, so each one's passkeys are forgotten too
    should(revoked).eql({ memberId: memberId(7), keysRemoved: 2, sharesEnded: 1 });
    should(r.log).eql([
      'members.write',
      'shares.write',
      `closeMember:${memberId(7)}`,
      `closeKey:${memberId(7)}:${keyId(71)}`,
      `closeKey:${memberId(7)}:${keyId(72)}`,
    ]);
    should(r.members.document.members.map(member => member.memberId)).eql([memberId(8)]);
  });

  it('should end only the live shares that name the person', async () => {
    // Arrange
    const r = await rig(fixture());

    // Act
    await r.service.revokeMember(memberId(7));

    // Assert
    should(shareOf(r.shares.document, 1).state).equal('ended');
    should(shareOf(r.shares.document, 2).state).equal('spent');
    should(shareOf(r.shares.document, 3).state).equal('live');
    should(refusedOf(r.service.admitJoin(codeOf(1), T0)).reason).equal('ended');
  });

  it('should leave the shares file alone for a person with no live share', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    const revoked = await r.service.revokeMember(memberId(7));

    // Assert
    should(revoked.sharesEnded).equal(0);
    should(r.log).eql([
      'members.write',
      `closeMember:${memberId(7)}`,
      `closeKey:${memberId(7)}:${keyId(71)}`,
      `closeKey:${memberId(7)}:${keyId(72)}`,
    ]);
  });

  it('should end the live shares of someone who never joined, and write no members file', async () => {
    // Arrange: a new person was invited, then the invitation is withdrawn by removing them
    const r = await rig({ shares: sharesDoc(storedShare(1)) });

    // Act
    const revoked = await r.service.revokeMember(memberId(1));

    // Assert
    should(revoked).eql({ memberId: memberId(1), keysRemoved: 0, sharesEnded: 1 });
    should(r.log).eql(['shares.write', `closeMember:${memberId(1)}`]);
  });

  it('should refuse a person who is not there, close nothing, and write nothing', async () => {
    // Arrange
    const r = await rig(fixture());

    // Act
    const error = await refusal(() => r.service.revokeMember(memberId(9)));

    // Assert
    should(error.refusal).equal('member_unknown');
    should(r.log).eql([]);
  });

  it('should answer a second revoke as unknown and change nothing', async () => {
    // Arrange
    const r = await rig(fixture());
    await r.service.revokeMember(memberId(7));
    await r.service.flushed();
    r.log.length = 0;

    // Act
    const error = await refusal(() => r.service.revokeMember(memberId(7)));

    // Assert
    should(error.refusal).equal('member_unknown');
    should(r.log).eql([]);
  });

  it('should close the sessions and still throw when the members file will not write', async () => {
    // Arrange
    const r = await rig(fixture());
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.revokeMember(memberId(7)));

    // Assert
    should(error.message).equal('members disk full');
    should(r.log).containEql(`closeMember:${memberId(7)}`);
    // The person is still on disk, so their browsers' passkeys stay for the next attempt.
    should(r.log.filter(entry => entry.startsWith('closeKey:'))).eql([]);
    should((await r.service.listMembers()).members.map(member => member.memberId)).eql([memberId(8)]);
  });

  it('should finish the job from the files when asked again after a restart', async () => {
    // Arrange: the members file would not write, so the disk still holds the person and the live share
    const first = await rig(fixture());
    first.members.failing = true;
    await failure(() => first.service.revokeMember(memberId(7)));
    const restarted = await rig({ members: first.members.document, shares: first.shares.document });

    // Act
    const revoked = await restarted.service.revokeMember(memberId(7));

    // Assert
    should(revoked).eql({ memberId: memberId(7), keysRemoved: 2, sharesEnded: 1 });
    should(restarted.members.document.members.map(member => member.memberId)).eql([memberId(8)]);
    should(shareOf(restarted.shares.document, 1).state).equal('ended');
  });

  it('should finish the shares from the files when only the shares file failed', async () => {
    // Arrange
    const first = await rig(fixture());
    first.shares.failing = true;
    const error = await failure(() => first.service.revokeMember(memberId(7)));
    const restarted = await rig({ members: first.members.document, shares: first.shares.document });

    // Act
    const revoked = await restarted.service.revokeMember(memberId(7));

    // Assert
    should(error.message).equal('shares disk full');
    should(first.log).containEql(`closeMember:${memberId(7)}`);
    // The person was already gone from disk, so their browsers' passkeys went with them despite the shares failure.
    should(first.log).containEql(`closeKey:${memberId(7)}:${keyId(71)}`);
    should(first.log).containEql(`closeKey:${memberId(7)}:${keyId(72)}`);
    should(revoked).eql({ memberId: memberId(7), keysRemoved: 0, sharesEnded: 1 });
    should(restarted.members.writes).equal(0);
    should(shareOf(restarted.shares.document, 1).state).equal('ended');
  });
});

describe('CatalogMemberService.revokeMember: removal is final', () => {
  it('should keep the person gone, and the invites ended, when the shares file fails and the same process asks again', async () => {
    // Arrange
    const r = await rig(fixture());
    r.shares.failing = true;
    await failure(() => r.service.revokeMember(memberId(7)));
    r.shares.failing = false;

    // Act
    const revoked = await r.service.revokeMember(memberId(7));

    // Assert
    should(revoked.sharesEnded).equal(0);
    should(r.members.document.members.map(member => member.memberId)).eql([memberId(8)]);
    should(shareOf(r.shares.document, 1).state).equal('ended');
    should(
      (await r.service.listShares()).shares.find(share => share.shareId === shareOf(r.shares.document, 1).shareId)
        ?.state,
    ).equal('ended');
  });

  it('should write the members file again on a retry after that write failed', async () => {
    // Arrange
    const r = await rig(fixture());
    r.members.failing = true;
    await failure(() => r.service.revokeMember(memberId(7)));
    r.members.failing = false;

    // Act
    await r.service.revokeMember(memberId(7));

    // Assert
    should(r.members.document.members.map(member => member.memberId)).eql([memberId(8)]);
    should(shareOf(r.shares.document, 1).state).equal('ended');
  });

  it('should refuse a third ask once the retry finished the job', async () => {
    // Arrange
    const r = await rig(fixture());
    r.shares.failing = true;
    await failure(() => r.service.revokeMember(memberId(7)));
    r.shares.failing = false;
    await r.service.revokeMember(memberId(7));

    // Act
    const error = await refusal(() => r.service.revokeMember(memberId(7)));

    // Assert
    should(error.refusal).equal('member_unknown');
  });
});

describe('CatalogMemberService.removeKey', () => {
  it('should remove one browser, keep the rest, and close its sessions after the write', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    const removed = await r.service.removeKey(memberId(7), keyId(71));

    // Assert
    should(removed).eql({ memberId: memberId(7), keyId: keyId(71) });
    should(memberOf(r.members.document, 7).keys.map(key => key.keyId)).eql([keyId(72)]);
    should(r.log).eql(['members.write', `closeKey:${memberId(7)}:${keyId(71)}`]);
  });

  it('should refuse a member that is not there', async () => {
    // Arrange
    const r = await rig();

    // Act
    const error = await refusal(() => r.service.removeKey(memberId(7), keyId(71)));

    // Assert
    should(error.refusal).equal('member_unknown');
  });

  it('should refuse a browser the member does not have, and write nothing', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    const error = await refusal(() => r.service.removeKey(memberId(7), keyId(99)));

    // Assert
    should(error.refusal).equal('member_key_unknown');
    should(r.log).eql([]);
  });

  it('should put the browser back and close nothing when the write fails', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.removeKey(memberId(7), keyId(71)));

    // Assert
    should(error.message).equal('members disk full');
    should((await r.service.listMembers()).members[0]?.keys).have.length(2);
    should(r.log.some(entry => entry.startsWith('closeKey'))).be.false();
  });
});

describe('CatalogMemberService.removeCatalog', () => {
  it('should take the catalog from the member and from their shares, members file first', async () => {
    // Arrange
    const shares = sharesDoc(
      storedShare(1, { memberId: memberId(7), memberKind: 'existing', catalogIds: [catalogId(1), catalogId(3)] }),
      storedShare(2, { memberId: memberId(8), memberKind: 'existing', catalogIds: [catalogId(1)] }),
    );
    const r = await rig({ members: membersDoc(seven()), shares });

    // Act
    const removed = await r.service.removeCatalog(memberId(7), catalogId(1));

    // Assert
    should(removed).eql({ memberId: memberId(7), catalogId: catalogId(1) });
    should(r.log).eql(['members.write', 'shares.write', `closeMember:${memberId(7)}`]);
    should(memberOf(r.members.document, 7).catalogIds).eql([catalogId(2)]);
    should(shareOf(r.shares.document, 1).catalogIds).eql([catalogId(3)]);
    should(shareOf(r.shares.document, 1).state).equal('live');
    should(shareOf(r.shares.document, 2).catalogIds).eql([catalogId(1)]);
  });

  it('should end a live share left with nothing to give, and leave a spent one spent', async () => {
    // Arrange
    const shares = sharesDoc(
      storedShare(1, { memberId: memberId(7), memberKind: 'existing', catalogIds: [catalogId(1)] }),
      storedShare(2, { memberId: memberId(7), memberKind: 'existing', catalogIds: [catalogId(1)], state: 'spent' }),
    );
    const r = await rig({ members: membersDoc(seven()), shares });

    // Act
    await r.service.removeCatalog(memberId(7), catalogId(1));

    // Assert
    should(shareOf(r.shares.document, 1)).containEql({ catalogIds: [], state: 'ended' });
    should(shareOf(r.shares.document, 2)).containEql({ catalogIds: [], state: 'spent' });
  });

  it('should refuse a member that is not there', async () => {
    // Arrange
    const r = await rig();

    // Act
    const error = await refusal(() => r.service.removeCatalog(memberId(7), catalogId(1)));

    // Assert
    should(error.refusal).equal('member_unknown');
  });

  it('should refuse a catalog the member cannot read, and write nothing', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    const error = await refusal(() => r.service.removeCatalog(memberId(7), catalogId(9)));

    // Assert
    should(error.refusal).equal('catalog_unknown');
    should(r.log).eql([]);
  });

  it('should put the catalog back, and touch no share, when the members file will not write', async () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { memberId: memberId(7), memberKind: 'existing' }));
    const r = await rig({ members: membersDoc(seven()), shares });
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.removeCatalog(memberId(7), catalogId(1)));

    // Assert
    should(error.message).equal('members disk full');
    should(r.log.some(entry => entry.startsWith('closeMember'))).be.false();
    should((await r.service.listMembers()).members[0]?.catalogIds).eql([catalogId(1), catalogId(2)]);
    should(r.shares.writes).equal(0);
  });

  it('should put the shares back when only the shares file will not write', async () => {
    // Arrange
    const shares = sharesDoc(storedShare(1, { memberId: memberId(7), memberKind: 'existing' }));
    const r = await rig({ members: membersDoc(seven()), shares });
    r.shares.failing = true;

    // Act
    const error = await failure(() => r.service.removeCatalog(memberId(7), catalogId(1)));

    // Assert
    should(error.message).equal('shares disk full');
    should(r.log.some(entry => entry.startsWith('closeMember'))).be.false();
    should((await r.service.listShares()).shares[0]?.catalogIds).eql([catalogId(1)]);
  });
});

describe('CatalogMemberService.forgetCatalog', () => {
  it('should take a deleted catalog from every member and every share, members file first', async () => {
    // Arrange
    const members = membersDoc(
      seven(),
      storedMember(8, { catalogIds: [catalogId(1)] }),
      storedMember(9, { catalogIds: [catalogId(2)] }),
    );
    const shares = sharesDoc(
      storedShare(1, { catalogIds: [catalogId(1), catalogId(2)] }),
      storedShare(2, { catalogIds: [catalogId(1)] }),
      storedShare(3, { catalogIds: [catalogId(1)], state: 'spent' }),
      storedShare(4, { catalogIds: [catalogId(2)] }),
    );
    const r = await rig({ members, shares });
    await r.service.flushed();
    r.log.length = 0;

    // Act
    await r.service.forgetCatalog(catalogId(1));

    // Assert — and the two members who were reading it stop, after both writes
    should(r.log).eql(['members.write', 'shares.write', `closeMember:${memberId(7)}`, `closeMember:${memberId(8)}`]);
    should(memberOf(r.members.document, 7).catalogIds).eql([catalogId(2)]);
    should(memberOf(r.members.document, 8).catalogIds).eql([]);
    should(memberOf(r.members.document, 9).catalogIds).eql([catalogId(2)]);
    should(shareOf(r.shares.document, 1)).containEql({ catalogIds: [catalogId(2)], state: 'live' });
    should(shareOf(r.shares.document, 2)).containEql({ catalogIds: [], state: 'ended' });
    should(shareOf(r.shares.document, 3)).containEql({ catalogIds: [], state: 'spent' });
    should(shareOf(r.shares.document, 4)).containEql({ catalogIds: [catalogId(2)], state: 'live' });
  });

  it('should write nothing for a catalog nobody holds', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()), shares: sharesDoc(storedShare(1)) });

    // Act
    await r.service.forgetCatalog(catalogId(50));

    // Assert
    should(r.log).eql([]);
  });

  it('should write only the members file when no share names the catalog', async () => {
    // Arrange
    const r = await rig({
      members: membersDoc(seven()),
      shares: sharesDoc(storedShare(1, { catalogIds: [catalogId(3)] })),
    });

    // Act
    await r.service.forgetCatalog(catalogId(1));

    // Assert
    should(r.log).eql(['members.write', `closeMember:${memberId(7)}`]);
  });

  it('should write only the shares file when no member holds the catalog', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(storedMember(8)), shares: sharesDoc(storedShare(1)) });

    // Act
    await r.service.forgetCatalog(catalogId(1));

    // Assert
    should(r.log).eql(['shares.write']);
    should(shareOf(r.shares.document, 1).state).equal('ended');
  });

  it('should leave the shares alone and throw when the members file will not write', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()), shares: sharesDoc(storedShare(1)) });
    r.members.failing = true;

    // Act
    const error = await failure(() => r.service.forgetCatalog(catalogId(1)));

    // Assert
    should(error.message).equal('members disk full');
    should(r.shares.writes).equal(0);
    should(r.log.some(entry => entry.startsWith('closeMember'))).be.false();
    should((await r.service.listMembers()).members[0]?.catalogIds).eql([catalogId(1), catalogId(2)]);
  });

  it('should throw when the shares file will not write, with the share still naming the catalog', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    r.shares.failing = true;

    // Act
    const error = await failure(() => r.service.forgetCatalog(catalogId(1)));

    // Assert
    should(error.message).equal('shares disk full');
    should((await r.service.listShares()).shares[0]).containEql({ catalogIds: [catalogId(1)], state: 'live' });
  });
});

describe('CatalogMemberService.access', () => {
  it('should answer the browser as it stands now, window included when it has one', async () => {
    // Arrange
    const key = storedKey(71, { passkeyCount: 0, passkeyWindowEndsAt: new Date(T0 + 1000).toISOString() });
    const r = await rig({ members: membersDoc(storedMember(7, { catalogIds: [catalogId(2)], keys: [key] })) });

    // Act
    const access = await r.service.access(keyId(71));

    // Assert
    should(access).eql({
      memberId: memberId(7),
      keyId: keyId(71),
      label: 'Member 7',
      memberKey: key.memberKey,
      clientName: 'Browser 71',
      catalogIds: [catalogId(2)],
      passkeyCount: 0,
      passkeyWindowEndsAt: key.passkeyWindowEndsAt,
    });
  });

  it('should leave the window out when the browser has none', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    const access = await r.service.access(keyId(72));

    // Assert
    should(access).not.be.undefined();
    should(access).not.have.property('passkeyWindowEndsAt');
  });

  it('should answer nothing for a browser nobody filed', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    const access = await r.service.access(keyId(99));

    // Assert
    should(access).be.undefined();
  });
});

describe('CatalogMemberService: a key that time has ended', () => {
  const EXPIRED = (r: Awaited<ReturnType<typeof rig>>) => memberOf(r.members.document, 7).keys[0];

  it('should answer nothing for a key idle past 90 days, even before the sweep has removed it', async () => {
    // Arrange — the probed case: last used at T0, asked at T0 + 91 days
    const r = await rig({ members: membersDoc(seven()) });
    r.clock.now = T0 + 91 * DAY;

    // Act
    const access = await r.service.access(keyId(71));

    // Assert
    should(access).be.undefined();
    should(EXPIRED(r)?.keyId).equal(keyId(71));
  });

  it('should never refresh an idle-expired key, so opening a session cannot revive it', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });
    r.clock.now = T0 + 91 * DAY;

    // Act
    await r.service.touchKey(keyId(71));

    // Assert
    should(EXPIRED(r)?.lastSeenAt).be.undefined();
    should(r.members.writes).equal(0);
  });

  it('should still answer a key one moment short of 90 days', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });
    r.clock.now = T0 + 90 * DAY - 1;

    // Act
    const access = await r.service.access(keyId(71));

    // Assert
    should(access?.keyId).equal(keyId(71));
  });

  it('should answer nothing for a key with no passkey once its window has closed', async () => {
    // Arrange
    const key = storedKey(71, { passkeyCount: 0, passkeyWindowEndsAt: new Date(T0 + 1000).toISOString() });
    const r = await rig({ members: membersDoc(storedMember(7, { keys: [key] })) });
    r.clock.now = T0 + 1000;

    // Act
    const access = await r.service.access(keyId(71));
    await r.service.touchKey(keyId(71));

    // Assert
    should(access).be.undefined();
    should(r.members.writes).equal(0);
  });
});

describe('CatalogMemberService.touchKey', () => {
  const seen = (r: Awaited<ReturnType<typeof rig>>) => memberOf(r.members.document, 7).keys[0]?.lastSeenAt;

  it('should file when a browser was seen, and not again inside ten minutes', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    await r.service.touchKey(keyId(71));
    r.clock.now = T0 + 10 * 60_000 - 1;
    await r.service.touchKey(keyId(71));

    // Assert
    should(seen(r)).equal(new Date(T0).toISOString());
    should(r.members.writes).equal(1);
  });

  it('should file it again once ten minutes have passed', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });
    await r.service.touchKey(keyId(71));

    // Act
    r.clock.now = T0 + 10 * 60_000;
    await r.service.touchKey(keyId(71));

    // Assert
    should(seen(r)).equal(new Date(T0 + 10 * 60_000).toISOString());
    should(r.members.writes).equal(2);
  });

  it('should write nothing for a browser nobody filed', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    await r.service.touchKey(keyId(99));

    // Assert
    should(r.members.writes).equal(0);
  });
});

describe('CatalogMemberService.passkeyAdded', () => {
  it('should count the passkey and file it', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(storedMember(7, { keys: [storedKey(71, { passkeyCount: 0 })] })) });

    // Act
    const count = await r.service.passkeyAdded(keyId(71));

    // Assert
    should(count).equal(1);
    should(memberOf(r.members.document, 7).keys[0]?.passkeyCount).equal(1);
  });

  it('should stop counting at sixteen', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(storedMember(7, { keys: [storedKey(71, { passkeyCount: 16 })] })) });

    // Act
    const count = await r.service.passkeyAdded(keyId(71));

    // Assert
    should(count).equal(16);
  });

  it('should refuse a browser nobody filed, and write nothing', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(seven()) });

    // Act
    const error = await refusal(() => r.service.passkeyAdded(keyId(99)));

    // Assert
    should(error.refusal).equal('member_key_unknown');
    should(r.members.writes).equal(0);
  });

  it('should take two passkeys filed at once one after the other', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(storedMember(7, { keys: [storedKey(71, { passkeyCount: 0 })] })) });

    // Act
    const counts = await Promise.all([r.service.passkeyAdded(keyId(71)), r.service.passkeyAdded(keyId(71))]);

    // Assert
    should(counts).eql([1, 2]);
  });
});
