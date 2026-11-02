import { describe, it } from 'bun:test';
import { CATALOG_SHARES_LISTED_MAX } from '@ferretry/protocol';
import should from 'should';
import {
  catalogId,
  codeOf,
  DAY,
  failure,
  iso,
  joinOf,
  keyId,
  memberId,
  memberOf,
  membersDoc,
  newKey,
  redeemOf,
  refusal,
  refusedOf,
  rig,
  shareId,
  singleFor,
  singleForMember,
  sharesDoc,
  storedKey,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

const holders = () =>
  membersDoc(
    storedMember(7, { catalogIds: [catalogId(1)], keys: [storedKey(7)] }),
    storedMember(8, { catalogIds: [catalogId(1)], keys: [storedKey(8)] }),
  );
// Member 7 has room for exactly one more browser: a second reservation overruns the 200 they may have.
const crowded = () =>
  membersDoc(
    storedMember(7, {
      catalogIds: [catalogId(1)],
      keys: Array.from({ length: 199 }, (_, index) => storedKey(index + 1)),
    }),
  );
// A code for many people that names member 7. The mint refuses to make one until join-by-proof, so it is filed directly.
const roomy = (n: number, catalogs: readonly string[] = [catalogId(2)]) =>
  storedShare(n, {
    memberId: memberId(7),
    memberKind: 'existing',
    catalogIds: [...catalogs],
    uses: { kind: 'multi', cap: 10 },
  });
const by = { keyId: keyId(7), clientName: 'Browser 7' };

describe('a join in flight when the owner takes something away', () => {
  it('should not bring a revoked member back', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = joinOf(r.service.admitJoin(code, T0));

    // Act
    await r.service.revokeMember(memberId(7));
    const error = await refusal(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(error.refusal).equal('share_refused');
    should(r.members.document.members.map(member => member.memberId)).eql([memberId(8)]);
  });

  it('should not file a catalog the owner took away from that member', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(1), catalogId(2)]));
    const reservation = joinOf(r.service.admitJoin(code, T0));

    // Act
    await r.service.removeCatalog(memberId(7), catalogId(1));
    const error = await refusal(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(error.refusal).equal('share_refused');
    should(memberOf(r.members.document, 7).catalogIds).eql([]);
    should(memberOf(r.members.document, 7).keys).have.length(1);
  });

  it('should not file a catalog that was deleted meanwhile', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice', [catalogId(1), catalogId(2)]));
    const reservation = joinOf(r.service.admitJoin(code, T0));

    // Act
    await r.service.forgetCatalog(catalogId(2));
    const error = await refusal(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(error.refusal).equal('share_refused');
    should(r.members.document.members).eql([]);
  });

  it('should file only the catalogs that still exist when the directory lost one without telling the service', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice', [catalogId(1), catalogId(2)]));
    const reservation = joinOf(r.service.admitJoin(code, T0));
    r.known.delete(catalogId(2));

    // Act
    const joined = await r.service.commit(reservation, newKey(70));

    // Assert
    should(joined.catalogCount).equal(1);
    should(r.members.document.members[0]?.catalogIds).eql([catalogId(1)]);
  });

  it('should not file anything when every catalog it carried is gone', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice', [catalogId(2)]));
    const reservation = joinOf(r.service.admitJoin(code, T0));
    r.known.delete(catalogId(2));

    // Act
    const error = await refusal(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(error.refusal).equal('share_refused');
    should(r.members.document.members).eql([]);
  });

  it('should not file a join whose share the owner ended', async () => {
    // Arrange
    const r = await rig();
    const minted = await r.service.mint(singleFor('Alice'));
    const reservation = joinOf(r.service.admitJoin(minted.code, T0));

    // Act
    await r.service.endShare(minted.share.shareId);
    const error = await refusal(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(error.refusal).equal('share_refused');
    should(r.members.document.members).eql([]);
  });

  it('should free the room the voided reservation held', async () => {
    // Arrange
    const r = await rig({ members: crowded(), shares: sharesDoc(roomy(5), roomy(6, [catalogId(3)])) });
    const code = codeOf(5);
    const reservation = joinOf(r.service.admitJoin(code, T0));
    should(refusedOf(r.service.admitJoin(code, T0)).reason).equal('member-keys');

    // Act
    await r.service.forgetCatalog(catalogId(2));
    await refusal(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(r.service.admitJoin(codeOf(6), T0).ok).be.true();
    should(r.members.document.members).have.length(1);
  });

  it('should leave the other shares’ reservations alone', async () => {
    // Arrange
    const r = await rig();
    const one = await r.service.mint(singleFor('Alice'));
    const two = await r.service.mint(singleFor('Bob'));
    const kept = joinOf(r.service.admitJoin(two.code, T0));

    // Act
    await r.service.endShare(one.share.shareId);
    const joined = await r.service.commit(kept, newKey(70));

    // Assert
    should(joined.label).equal('Bob');
  });
});

describe('a redeem in flight when the owner takes something away', () => {
  it('should not add a catalog that was deleted meanwhile', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));

    // Act
    await r.service.forgetCatalog(catalogId(2));
    const error = await refusal(() => r.service.commitRedeem(reservation, by));

    // Assert
    should(error.refusal).equal('share_refused');
    should(memberOf(r.members.document, 7).catalogIds).eql([catalogId(1)]);
  });

  it('should not add a catalog the directory no longer knows', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    r.known.delete(catalogId(2));

    // Act
    const error = await refusal(() => r.service.commitRedeem(reservation, by));

    // Assert
    should(error.refusal).equal('share_refused');
  });

  it('should not add anything when the share was ended', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const minted = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(minted.code, memberId(7), T0));

    // Act
    await r.service.endShare(minted.share.shareId);
    const error = await refusal(() => r.service.commitRedeem(reservation, by));

    // Assert
    should(error.refusal).equal('share_refused');
    should(memberOf(r.members.document, 7).catalogIds).eql([catalogId(1)]);
  });
});

describe('a reservation that nobody commits', () => {
  it('should lapse after thirty seconds, free its room and refuse a late commit', async () => {
    // Arrange
    const r = await rig({ members: crowded(), shares: sharesDoc(roomy(5)) });
    const code = codeOf(5);
    const reservation = joinOf(r.service.admitJoin(code, T0));
    should(refusedOf(r.service.admitJoin(code, T0 + 29_000)).reason).equal('member-keys');

    // Act
    const later = r.service.admitJoin(code, T0 + 31_000);
    r.clock.now = T0 + 31_000;
    const error = await refusal(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(later.ok).be.true();
    should(error.refusal).equal('share_refused');
    should(memberOf(r.members.document, 7).keys).have.length(199);
  });

  it('should refuse a commit on its own after thirty seconds even when nothing else was admitted', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    r.clock.now = T0 + 30_000;

    // Act
    const error = await refusal(() => r.service.commit(reservation, newKey(70)));

    // Assert
    should(error.refusal).equal('share_refused');
  });

  it('should judge the lapse when the commit was asked, not when a slow disk ahead of it lets it run', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)), members: holders() });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    await r.service.flushed();
    r.clock.now = T0 + 29_000;
    const release = r.members.hold();
    const ahead = r.service.renameMember(memberId(7), 'Slow');

    // Act
    const asked = r.service.commit(reservation, newKey(70));
    r.clock.now = T0 + 45_000;
    release();
    await ahead;
    const joined = await asked;

    // Assert
    should(joined.memberId).equal(memberId(1));
    should(memberOf(r.members.document, 1).keys).have.length(1);
  });

  it('should judge a redeem the same way', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));
    const reservation = redeemOf(r.service.admitRedeem(code, memberId(7), T0));
    await r.service.flushed();
    r.clock.now = T0 + 29_000;
    const release = r.members.hold();
    const ahead = r.service.renameMember(memberId(8), 'Slow');

    // Act
    const asked = r.service.commitRedeem(reservation, by);
    r.clock.now = T0 + 45_000;
    release();
    await ahead;
    await asked;

    // Assert
    should(memberOf(r.members.document, 7).catalogIds).eql([catalogId(1), catalogId(2)]);
  });

  it('should refuse a reservation committed twice', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    const reservation = joinOf(r.service.admitJoin(codeOf(1), T0));
    await r.service.commit(reservation, newKey(70));

    // Act
    const error = await refusal(() => r.service.commit(reservation, newKey(71)));

    // Assert
    should(error.refusal).equal('share_refused');
    should(r.members.document.members[0]?.keys).have.length(1);
  });
});

describe('an admission is on disk before it is answered', () => {
  const stored = (r: Awaited<ReturnType<typeof rig>>) => r.shares.document.shares[0];

  it('should write the burn of a successful join before the answer is final', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    const before = r.shares.writes;

    // Act
    const admitted = r.service.admitJoin(code, T0);
    await admitted.persisted;

    // Assert
    should(r.shares.writes).equal(before + 1);
    should(stored(r)?.state).equal('spent');
    should(stored(r)?.used).equal(1);
  });

  it('should write a counted use of a multi-use code', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint({ ...singleFor('Crowd'), uses: { kind: 'multi', cap: 5 } });

    // Act
    await r.service.admitJoin(code, T0).persisted;

    // Assert
    should(stored(r)?.used).equal(1);
    should(stored(r)?.successes).eql([T0]);
  });

  it('should write the burn of a Q5 refusal', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(2)]));

    // Act
    const refused = refusedOf(r.service.admitRedeem(code, memberId(8), T0));
    await (refused as unknown as { persisted: Promise<void> }).persisted;

    // Assert
    should(stored(r)?.state).equal('spent');
    should(stored(r)?.used).equal(1);
    should(stored(r)?.usedBy).eql([]);
  });

  it('should write the burn of a redeem that adds nothing', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const { code } = await r.service.mint(singleForMember(7, [catalogId(1)]));

    // Act
    const admitted = r.service.admitRedeem(code, memberId(7), T0);
    await admitted.persisted;

    // Assert
    should(admitted.ok).be.true();
    should(stored(r)?.state).equal('spent');
  });

  it('should write nothing for a refusal that changed nothing', async () => {
    // Arrange
    const r = await rig();
    const before = r.shares.writes;

    // Act
    const refused = r.service.admitJoin(codeOf(99), T0);
    await refused.persisted;

    // Assert
    should(refused.ok).be.false();
    should(r.shares.writes).equal(before);
  });

  it('should reject the persisted promise when the disk fails, and keep the code burned in memory', async () => {
    // Arrange
    const r = await rig();
    const { code } = await r.service.mint(singleFor('Alice'));
    r.shares.failing = true;

    // Act
    const admitted = r.service.admitJoin(code, T0);
    const error = await failure(() => admitted.persisted);

    // Assert
    should(error.message).equal('shares disk full');
    should(refusedOf(r.service.admitJoin(code, T0)).reason).equal('spent');
  });

  it('should settle the queue once every admission write has finished', async () => {
    // Arrange
    const r = await rig();
    const first = await r.service.mint(singleFor('Alice'));
    const second = await r.service.mint(singleFor('Bob'));
    const release = r.shares.hold();
    r.service.admitJoin(first.code, T0);
    r.service.admitJoin(second.code, T0);
    let settled = false;

    // Act
    const waiting = r.service.flushed().then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const whileHeld = settled;
    release();
    await waiting;

    // Assert
    should(whileHeld).be.false();
    should(r.shares.document.shares.map(share => share.state)).eql(['spent', 'spent']);
  });
});

describe('minting reads what exists inside the queue', () => {
  it('should refuse a catalog deleted while an earlier operation was still writing', async () => {
    // Arrange
    const r = await rig();
    const release = r.shares.hold();
    const pending = r.service.mint(singleFor('Seed'));
    await new Promise(resolve => setTimeout(resolve, 5));
    r.known.delete(catalogId(1));

    // Act
    const error = refusal(() => r.service.mint(singleFor('Alice')));
    release();
    await pending;

    // Assert
    should((await error).refusal).equal('catalog_unknown');
  });

  it('should refuse an existing member revoked while an earlier operation was still writing', async () => {
    // Arrange
    const r = await rig({ members: holders() });
    const release = r.members.hold();
    const revoking = r.service.revokeMember(memberId(7));

    // Act
    const error = refusal(() => r.service.mint(singleForMember(7, [catalogId(2)])));
    release();
    await revoking;

    // Assert
    should((await error).refusal).equal('member_unknown');
  });
});

describe('the stored list of shares', () => {
  it('should forget a share that is over for thirty days when anything is written', async () => {
    // Arrange
    const old = storedShare(1, { state: 'ended', expiresAt: iso(T0 - 31 * DAY) });
    const recent = storedShare(2, { state: 'ended', expiresAt: iso(T0 - 29 * DAY) });
    const r = await rig({ shares: sharesDoc(old, recent) });

    // Act
    await r.service.mint(singleFor('Alice'));

    // Assert
    should(r.shares.document.shares.map(share => share.shareId)).not.containEql(shareId(1));
    should(r.shares.document.shares.map(share => share.shareId)).containEql(shareId(2));
  });

  it('should forget old shares on a sweep, with no other change', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1, { expiresAt: iso(T0 - 31 * DAY) })) });

    // Act
    await r.service.sweep();

    // Assert
    should(r.shares.document.shares).eql([]);
  });

  it('should keep a share that is still live however old it is', async () => {
    // Arrange
    const r = await rig({
      shares: sharesDoc(storedShare(1, { createdAt: iso(T0 - 90 * DAY), expiresAt: iso(T0 + DAY) })),
    });

    // Act
    await r.service.sweep();

    // Assert
    should(r.shares.document.shares).have.length(1);
  });

  it('should refuse a mint once the list is as long as it may be, with a sentence', async () => {
    // Arrange
    const full = Array.from({ length: CATALOG_SHARES_LISTED_MAX }, (_, index) =>
      storedShare(index + 1, {
        state: 'ended',
        expiresAt: iso(T0 - DAY),
        codeSha256: `${String(index).padStart(64, '0')}`,
      }),
    );
    const r = await rig({ shares: sharesDoc(...full) });

    // Act
    const error = await refusal(() => r.service.mint(singleFor('Alice')));

    // Assert
    should(error.refusal).equal('shares_full');
    should(error.message).match(/500 shares are stored/);
    should(r.shares.document.shares).have.length(CATALOG_SHARES_LISTED_MAX);
  });
});
