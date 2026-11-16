import { describe, it } from 'bun:test';
import type { CatalogShareMintRequest } from '../../../daemon/lib/boundary.ts';
import should from 'should';
import {
  catalogId,
  codeOf,
  DAY,
  joinOf,
  memberId,
  membersDoc,
  refusal,
  refusedOf,
  rig,
  shareId,
  sharesDoc,
  singleFor,
  singleForMember,
  singleForMemberD8,
  storedKey,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

const dana = (passkeys: number) =>
  storedMember(7, {
    label: 'Dana',
    catalogIds: [catalogId(1)],
    keys: [storedKey(7, { passkeyCount: passkeys })],
  });

describe('CatalogMemberService.mint: the owner’s "they need a new passkey" mark (D8)', () => {
  it('should file the mark on a single-use invite for a person who is here, and show it', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });

    // Act
    const minted = await r.service.mint(singleForMemberD8(7));

    // Assert
    should(r.shares.document.shares[0]?.newPasskey).be.true();
    should(minted.share.newPasskey).be.true();
  });

  it('should leave the invite unmarked when the owner did not mark it, though nobody can prove a passkey', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(0)) });

    // Act
    const minted = await r.service.mint(singleForMember(7));

    // Assert
    should(minted.noPasskeyLeft).be.true();
    should(r.shares.document.shares[0]).not.have.property('newPasskey');
    should(minted.share).not.have.property('newPasskey');
  });

  it('should not read a mark that is false as a mark', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });

    // Act
    const minted = await r.service.mint({ ...singleForMember(7), newPasskey: false });

    // Assert
    should(r.shares.document.shares[0]).not.have.property('newPasskey');
    should(minted.share).not.have.property('newPasskey');
  });

  it('should refuse the mark on a multi-use code, and write nothing', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const request: CatalogShareMintRequest = { ...singleForMemberD8(7), uses: { kind: 'multi', cap: 5 } };

    // Act
    const error = await refusal(() => r.service.mint(request));

    // Assert
    should(error.refusal).equal('new_passkey_multi');
    should(r.shares.writes).equal(0);
  });

  it('should say no passkey is left only for a person who is here and has none on any browser', async () => {
    // Arrange
    const none = await rig({ members: membersDoc(dana(0)) });
    const some = await rig({ members: membersDoc(dana(1)) });
    const nobrowser = await rig({ members: membersDoc(storedMember(7, { label: 'Dana' })) });
    const fresh = await rig();

    // Act
    const answers = {
      none: await none.service.mint(singleForMember(7)),
      some: await some.service.mint(singleForMember(7)),
      nobrowser: await nobrowser.service.mint(singleForMember(7)),
      fresh: await fresh.service.mint(singleFor('Alice')),
    };

    // Assert
    should(answers.none.noPasskeyLeft).be.true();
    should(answers.nobrowser.noPasskeyLeft).be.true();
    should(answers.some).not.have.property('noPasskeyLeft');
    should(answers.fresh).not.have.property('noPasskeyLeft');
  });
});

describe('CatalogMemberService.markNewPasskey', () => {
  it('should put the mark on a live single-use invite, write it, and show it', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(0)) });
    const minted = await r.service.mint(singleForMember(7));
    await r.service.flushed();
    r.log.length = 0;

    // Act
    const view = await r.service.markNewPasskey(minted.share.shareId, true);

    // Assert
    should(view.newPasskey).be.true();
    should(r.log).eql(['shares.write']);
    should(r.shares.document.shares[0]?.newPasskey).be.true();
  });

  it('should take the mark off again, and show the invite as unmarked', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const minted = await r.service.mint(singleForMemberD8(7));

    // Act
    const view = await r.service.markNewPasskey(minted.share.shareId, false);

    // Assert
    should(view).not.have.property('newPasskey');
    should(r.shares.document.shares[0]?.newPasskey).be.false();
    should(refusedOf(r.service.admitJoin(minted.code, T0)).reason).equal('proof-required');
  });

  it('should write nothing when the invite already is as asked', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const marked = await r.service.mint(singleForMemberD8(7));
    const unmarked = await r.service.mint(singleForMember(7));
    await r.service.flushed();
    const writes = r.shares.writes;

    // Act
    const on = await r.service.markNewPasskey(marked.share.shareId, true);
    const off = await r.service.markNewPasskey(unmarked.share.shareId, false);

    // Assert
    should(on.newPasskey).be.true();
    should(off).not.have.property('newPasskey');
    should(r.shares.writes).equal(writes);
  });

  it('should refuse an invite that is not there', async () => {
    // Arrange
    const r = await rig();

    // Act
    const error = await refusal(() => r.service.markNewPasskey(shareId(9), true));

    // Assert
    should(error.refusal).equal('share_unknown');
  });

  it('should refuse an invite that is no longer open, ended, spent or expired', async () => {
    // Arrange
    const shares = sharesDoc(
      storedShare(1, { state: 'ended' }),
      storedShare(2, { state: 'spent' }),
      storedShare(3, { expiresAt: new Date(T0 - 1).toISOString() }),
    );
    const r = await rig({ shares });

    // Act
    const errors = [
      await refusal(() => r.service.markNewPasskey(shareId(1), true)),
      await refusal(() => r.service.markNewPasskey(shareId(2), true)),
      await refusal(() => r.service.markNewPasskey(shareId(3), false)),
    ];

    // Assert
    for (const error of errors) should(error.refusal).equal('share_not_live');
    should(r.shares.writes).equal(0);
  });

  it('should refuse to put the mark on a multi-use code, but let it be taken off one', async () => {
    // Arrange
    const r = await rig({
      shares: sharesDoc(storedShare(1, { uses: { kind: 'multi', cap: 5 }, memberKind: 'new' })),
    });

    // Act
    const error = await refusal(() => r.service.markNewPasskey(shareId(1), true));
    const off = await r.service.markNewPasskey(shareId(1), false);

    // Assert
    should(error.refusal).equal('new_passkey_multi');
    should(off).not.have.property('newPasskey');
    should(r.shares.writes).equal(0);
  });

  it('should let the marked invite join like a first browser, though the person has a passkey', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const minted = await r.service.mint(singleForMember(7));
    should(refusedOf(r.service.admitJoin(minted.code, T0)).reason).equal('proof-required');

    // Act
    await r.service.markNewPasskey(minted.share.shareId, true);
    const admitted = joinOf(r.service.admitJoin(minted.code, T0));

    // Assert
    should(admitted.entry).equal('owner-approved');
  });
});

describe('CatalogMemberService.joinNeed', () => {
  it('should answer nothing for a code nobody has, and before the documents are read', async () => {
    // Arrange
    const r = await rig();
    const early = await rig({ unloaded: true });

    // Act / Assert
    should(r.service.joinNeed(codeOf(99), T0)).be.undefined();
    should(early.service.joinNeed(codeOf(1), T0)).be.undefined();
  });

  it('should answer nothing for a code that is no longer live', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const ended = await r.service.mint(singleForMemberD8(7));
    const expiring = await r.service.mint(singleForMemberD8(7));
    await r.service.endShare(ended.share.shareId);

    // Act / Assert
    should(r.service.joinNeed(ended.code, T0)).be.undefined();
    should(r.service.joinNeed(expiring.code, T0 + 2 * DAY)).be.undefined();
  });

  it('should answer nothing for a code made for a person who has since gone', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1, { memberId: memberId(7), memberKind: 'existing' })) });

    // Act / Assert
    should(r.service.joinNeed(codeOf(1), T0)).be.undefined();
  });

  it('should say a new person’s first browser needs nothing', async () => {
    // Arrange
    const r = await rig();
    const minted = await r.service.mint(singleFor('Alice'));

    // Act
    const needed = r.service.joinNeed(minted.code, T0);

    // Assert
    should(needed).eql({
      need: 'first-browser',
      shareId: minted.share.shareId,
      memberId: minted.share.memberId,
      memberLabel: 'Alice',
    });
  });

  it('should say a person with a passkey must prove one, under the name they have now', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const minted = await r.service.mint(singleForMember(7));

    // Act
    const needed = r.service.joinNeed(minted.code, T0);

    // Assert
    should(needed).eql({
      need: 'proof',
      shareId: minted.share.shareId,
      memberId: memberId(7),
      memberLabel: 'Dana',
    });
  });

  it('should say a person with no passkey left is blocked until the owner marks the invite', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(0)) });
    const minted = await r.service.mint(singleForMember(7));

    // Act
    const before = r.service.joinNeed(minted.code, T0)?.need;
    await r.service.markNewPasskey(minted.share.shareId, true);
    const after = r.service.joinNeed(minted.code, T0)?.need;

    // Assert
    should(before).equal('blocked');
    should(after).equal('owner-approved');
  });

  it('should spend nothing and write nothing', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const minted = await r.service.mint(singleForMember(7));
    await r.service.flushed();
    const writes = r.shares.writes;

    // Act
    r.service.joinNeed(minted.code, T0);
    r.service.joinNeed(minted.code, T0);

    // Assert
    should(r.shares.writes).equal(writes);
    should(r.shares.document.shares[0]?.state).equal('live');
    should(refusedOf(r.service.admitJoin(minted.code, T0)).leftLive).be.true();
  });
});

describe('CatalogMemberService.admitJoin: a proof for the person', () => {
  it('should admit the proven person, and say the entry was a proof', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const minted = await r.service.mint(singleForMember(7));

    // Act
    const refused = refusedOf(r.service.admitJoin(minted.code, T0));
    const admitted = joinOf(
      r.service.admitJoin(minted.code, T0, { shareId: minted.share.shareId, memberId: memberId(7) }),
    );

    // Assert
    should(refused.reason).equal('proof-required');
    should(refused.leftLive).be.true();
    should(admitted.entry).equal('proof');
  });

  it('should refuse a proof that was verified for another person, and leave the code live', async () => {
    // Arrange
    const r = await rig({ members: membersDoc(dana(1)) });
    const minted = await r.service.mint(singleForMember(7));

    // Act
    const refused = refusedOf(
      r.service.admitJoin(minted.code, T0, { shareId: minted.share.shareId, memberId: memberId(8) }),
    );

    // Assert
    should(refused.reason).equal('proof-required');
    should(refused.leftLive).be.true();
  });
});
