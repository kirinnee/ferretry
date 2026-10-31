import { describe, it } from 'bun:test';
import { DaemonIdSchema, shareLinkUrl } from '@ferretry/protocol';
import should from 'should';
import {
  APP_ORIGIN,
  catalogId,
  codeOf,
  DAEMON_ID,
  DAEMON_URL,
  digestOf,
  failure,
  HOUR,
  iso,
  joinOf,
  memberId,
  membersDoc,
  MINUTE,
  multiFor,
  refusal,
  refusedOf,
  rig,
  shareId,
  sharesDoc,
  singleFor,
  singleForMember,
  storedKey,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

const CODE_SHAPE = /^fy_share_[A-Za-z0-9_-]{22}$/;

describe('CatalogMemberService.mint', () => {
  it("should make a share for a new person, keep only the code's digest, and hand the code back once", async () => {
    // Arrange
    const r = await rig();

    // Act
    const minted = await r.service.mint(singleFor('Alice', [catalogId(1), catalogId(2)]));

    // Assert
    should(minted.code).match(CODE_SHAPE);
    should(r.log).eql(['shares.write']);
    const stored = r.shares.document.shares[0];
    should(stored?.codeSha256).equal(digestOf(minted.code));
    should(stored?.shareId.startsWith('shr_')).be.true();
    should(stored?.memberId.startsWith('mbr_')).be.true();
    should(stored).containEql({
      memberLabel: 'Alice',
      memberKind: 'new',
      catalogIds: [catalogId(1), catalogId(2)],
      createdAt: iso(T0),
      expiresAt: iso(T0 + HOUR),
      uses: { kind: 'single' },
      used: 0,
      state: 'live',
    });
    should(minted.share).eql({
      shareId: stored?.shareId,
      memberId: stored?.memberId,
      memberLabel: 'Alice',
      catalogIds: [catalogId(1), catalogId(2)],
      createdAt: iso(T0),
      expiresAt: iso(T0 + HOUR),
      uses: { kind: 'single' },
      state: 'live',
      usedBy: [],
    });
  });

  it('should point the link at the machine, with the code in it', async () => {
    // Arrange
    const r = await rig();

    // Act
    const minted = await r.service.mint(singleFor('Alice'));

    // Assert
    should(minted.link).equal(
      shareLinkUrl(APP_ORIGIN, { daemonUrl: DAEMON_URL, daemonId: DaemonIdSchema.parse(DAEMON_ID), code: minted.code }),
    );
    should(minted.link).containEql(minted.code);
  });

  it('should make a different code, share and member every time', async () => {
    // Arrange
    const r = await rig();

    // Act
    const first = await r.service.mint(singleFor('Alice'));
    const second = await r.service.mint(singleFor('Bob'));

    // Assert
    should(second.code).not.equal(first.code);
    should(second.share.shareId).not.equal(first.share.shareId);
    should(second.share.memberId).not.equal(first.share.memberId);
    should(r.shares.document.shares).have.length(2);
  });

  it('should set the expiry from the length asked for', async () => {
    // Arrange
    const r = await rig();

    // Act
    const quarter = await r.service.mint({ ...singleFor('Alice'), expiresIn: '15m' });
    const day = await r.service.mint({ ...singleFor('Bob'), expiresIn: '1d' });

    // Assert
    should(quarter.share.expiresAt).equal(iso(T0 + 15 * MINUTE));
    should(day.share.expiresAt).equal(iso(T0 + 24 * HOUR));
  });

  it('should keep the cap of a multi-use code', async () => {
    // Arrange
    const r = await rig();

    // Act
    const minted = await r.service.mint(multiFor('Crowd', 5));

    // Assert
    should(minted.share.uses).eql({ kind: 'multi', cap: 5 });
    should(r.shares.document.shares[0]?.uses).eql({ kind: 'multi', cap: 5 });
  });

  it('should make a code for an existing member under the name they already have', async () => {
    // Arrange
    const members = membersDoc(storedMember(7, { label: 'Dana', catalogIds: [catalogId(1)], keys: [storedKey(7)] }));
    const r = await rig({ members });

    // Act
    const minted = await r.service.mint(singleForMember(7, [catalogId(2)]));

    // Assert
    should(minted.share.memberId).equal(memberId(7));
    should(minted.share.memberLabel).equal('Dana');
    should(r.shares.document.shares[0]?.memberKind).equal('existing');
  });

  it('should load the documents first when nobody has yet', async () => {
    // Arrange
    const r = await rig({ unloaded: true });

    // Act
    const minted = await r.service.mint(singleFor('Alice'));

    // Assert
    should(minted.code).match(CODE_SHAPE);
    should(r.members.reads).equal(1);
  });

  it('should make no code and write nothing when the machine has no address to put in a link', async () => {
    // Arrange
    const r = await rig({ link: { kind: 'unavailable', reason: 'The daemon is still starting.' } });

    // Act
    const error = await refusal(() => r.service.mint(singleFor('Alice')));

    // Assert
    should(error.refusal).equal('share_link_unavailable');
    should(error.message).equal('The daemon is still starting.');
    should(r.randomness.calls).equal(0);
    should(r.shares.writes).equal(0);
  });

  it('should refuse a catalog that is not on the machine, naming each one, and write nothing', async () => {
    // Arrange
    const r = await rig();

    // Act
    const error = await refusal(() =>
      r.service.mint(singleFor('Alice', [catalogId(1), catalogId(500), catalogId(501)])),
    );

    // Assert
    should(error.refusal).equal('catalog_unknown');
    should(error.message).containEql(catalogId(500));
    should(error.message).containEql(catalogId(501));
    should(error.message).not.containEql(catalogId(1));
    should(r.shares.writes).equal(0);
  });

  it('should refuse an existing member that is not there', async () => {
    // Arrange
    const r = await rig();

    // Act
    const error = await refusal(() => r.service.mint(singleForMember(99)));

    // Assert
    should(error.refusal).equal('member_unknown');
    should(r.shares.writes).equal(0);
  });

  it('should refuse a share that would leave a member reading more catalogs than one may', async () => {
    // Arrange: 60 held, 5 more asked for
    const held = Array.from({ length: 60 }, (_, index) => catalogId(index + 1));
    const asked = Array.from({ length: 5 }, (_, index) => catalogId(index + 61));
    const r = await rig({ members: membersDoc(storedMember(7, { catalogIds: held })) });

    // Act
    const error = await refusal(() => r.service.mint(singleForMember(7, asked)));

    // Assert
    should(error.refusal).equal('catalogs_full');
    should(r.shares.writes).equal(0);
  });

  it('should allow a member exactly the most catalogs, and count one they already hold once', async () => {
    // Arrange: 60 held; four new ones make 64, and one already held does not count again
    const held = Array.from({ length: 60 }, (_, index) => catalogId(index + 1));
    const asked = [catalogId(1), ...Array.from({ length: 4 }, (_, index) => catalogId(index + 61))];
    const r = await rig({ members: membersDoc(storedMember(7, { catalogIds: held })) });

    // Act
    const minted = await r.service.mint(singleForMember(7, asked));

    // Assert
    should(minted.share.catalogIds).eql(asked);
  });

  it('should refuse a new share while the most are live, and count only live ones', async () => {
    // Arrange
    const live = Array.from({ length: 63 }, (_, index) => storedShare(index + 1));
    const over = [
      storedShare(100, { state: 'spent' }),
      storedShare(101, { state: 'ended' }),
      storedShare(102, { expiresAt: iso(T0 - 1) }),
    ];
    const r = await rig({ shares: sharesDoc(...live, ...over) });

    // Act
    const last = await r.service.mint(singleFor('Alice'));
    const refused = await refusal(() => r.service.mint(singleFor('Bob')));

    // Assert
    should(last.code).match(CODE_SHAPE);
    should(refused.refusal).equal('shares_full');
    should(refused.message).containEql('64');
  });

  it('should make room again when a live share ends', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(...Array.from({ length: 64 }, (_, index) => storedShare(index + 1))) });
    await r.service.endShare(shareId(1));

    // Act
    const minted = await r.service.mint(singleFor('Alice'));

    // Assert
    should(minted.code).match(CODE_SHAPE);
  });

  it('should take the share back out when it cannot be written, and still serve the next mint', async () => {
    // Arrange
    const r = await rig();
    r.shares.failing = true;

    // Act
    const error = await failure(() => r.service.mint(singleFor('Alice')));
    r.shares.failing = false;
    const next = await r.service.mint(singleFor('Bob'));

    // Assert
    should(error.message).equal('shares disk full');
    const listed = (await r.service.listShares()).shares;
    should(listed).have.length(1);
    should(listed[0]?.shareId).equal(next.share.shareId);
  });

  it('should reach a code that was minted only after it was written', async () => {
    // Arrange
    const r = await rig();
    const minted = await r.service.mint(singleFor('Alice'));

    // Act
    const joined = joinOf(r.service.admitJoin(minted.code, T0));

    // Assert
    should(joined.shareId).equal(minted.share.shareId);
    should(joined.memberId).equal(minted.share.memberId);
    should(refusedOf(r.service.admitJoin(codeOf(1), T0)).reason).equal('unknown');
  });
});

describe('CatalogMemberService.listShares', () => {
  it('should list none for none', async () => {
    // Arrange
    const r = await rig();

    // Act
    const list = await r.service.listShares();

    // Assert
    should(list).eql({ shares: [] });
  });

  it('should list live shares first and read the time off the clock', async () => {
    // Arrange
    const shares = sharesDoc(
      storedShare(1),
      storedShare(2, { state: 'ended' }),
      storedShare(3, { expiresAt: iso(T0 + 2 * HOUR) }),
    );
    const r = await rig({ shares });
    r.clock.now = T0 + HOUR;

    // Act
    const list = await r.service.listShares();

    // Assert
    should(list.shares.map(share => [share.shareId, share.state])).eql([
      [shareId(3), 'live'],
      [shareId(1), 'expired'],
      [shareId(2), 'ended'],
    ]);
  });

  it('should show no digest and no code', async () => {
    // Arrange
    const r = await rig();
    const minted = await r.service.mint(singleFor('Alice'));

    // Act
    const text = JSON.stringify(await r.service.listShares());

    // Assert
    should(text).not.containEql(minted.code);
    should(text).not.containEql(digestOf(minted.code));
  });

  it('should load the documents first when nobody has yet', async () => {
    // Arrange
    const r = await rig({ unloaded: true, shares: sharesDoc(storedShare(1)) });

    // Act
    const list = await r.service.listShares();

    // Assert
    should(list.shares).have.length(1);
  });
});

describe('CatalogMemberService.endShare', () => {
  it('should end a live share, write it, and refuse its code from then on', async () => {
    // Arrange
    const r = await rig();
    const minted = await r.service.mint(singleFor('Alice'));
    await r.service.flushed();
    r.log.length = 0;

    // Act
    const view = await r.service.endShare(minted.share.shareId);

    // Assert
    should(view.state).equal('ended');
    should(view.shareId).equal(minted.share.shareId);
    should(r.log).eql(['shares.write']);
    should(r.shares.document.shares[0]?.state).equal('ended');
    should(refusedOf(r.service.admitJoin(minted.code, T0)).reason).equal('ended');
  });

  it('should refuse a share that is not there', async () => {
    // Arrange
    const r = await rig();

    // Act
    const error = await refusal(() => r.service.endShare(shareId(9)));

    // Assert
    should(error.refusal).equal('share_unknown');
  });

  it('should answer a share that is already over as it is, and write nothing', async () => {
    // Arrange
    const shares = sharesDoc(
      storedShare(1, { state: 'spent' }),
      storedShare(2, { state: 'ended' }),
      storedShare(3, { expiresAt: iso(T0 - 1) }),
    );
    const r = await rig({ shares });

    // Act
    const spent = await r.service.endShare(shareId(1));
    const ended = await r.service.endShare(shareId(2));
    const expired = await r.service.endShare(shareId(3));

    // Assert
    should([spent.state, ended.state, expired.state]).eql(['spent', 'ended', 'expired']);
    should(r.shares.writes).equal(0);
  });

  it('should leave the share live when the write fails', async () => {
    // Arrange
    const r = await rig({ shares: sharesDoc(storedShare(1)) });
    r.shares.failing = true;

    // Act
    const error = await failure(() => r.service.endShare(shareId(1)));

    // Assert
    should(error.message).equal('shares disk full');
    should((await r.service.listShares()).shares[0]?.state).equal('live');
    should(r.service.admitJoin(codeOf(1), T0).ok).be.true();
  });
});
