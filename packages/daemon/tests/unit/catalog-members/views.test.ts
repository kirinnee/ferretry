import { describe, it } from 'bun:test';
import { CATALOG_SHARES_LISTED_MAX } from '@ferretry/protocol';
import should from 'should';
import { listedShares, memberView, shareView } from '../../../src/lib/catalog-members/views.ts';
import {
  catalogId,
  codeOf,
  digestOf,
  HOUR,
  iso,
  keyId,
  memberId,
  shareId,
  storedKey,
  storedMember,
  storedShare,
  T0,
} from './support.ts';

describe('memberView', () => {
  it('should show the member and each browser by name, with its passkeys and no key material', () => {
    // Arrange
    const member = storedMember(1, {
      catalogIds: [catalogId(1), catalogId(2)],
      keys: [storedKey(1, { passkeyCount: 2 })],
    });

    // Act
    const view = memberView(member);

    // Assert
    should(view).eql({
      memberId: memberId(1),
      label: 'Member 1',
      catalogIds: [catalogId(1), catalogId(2)],
      createdAt: iso(T0),
      keys: [{ keyId: keyId(1), clientName: 'Browser 1', joinedAt: iso(T0), passkeys: 2 }],
    });
  });

  it('should show when a browser was last seen and when its passkey window closes, if it has them', () => {
    // Arrange
    const key = storedKey(1, {
      passkeyCount: 0,
      lastSeenAt: iso(T0 + HOUR),
      passkeyWindowEndsAt: iso(T0 + 600_000),
    });

    // Act
    const view = memberView(storedMember(1, { keys: [key] }));

    // Assert
    should(view.keys[0]).eql({
      keyId: keyId(1),
      clientName: 'Browser 1',
      joinedAt: iso(T0),
      lastSeenAt: iso(T0 + HOUR),
      passkeys: 0,
      passkeyWindowEndsAt: iso(T0 + 600_000),
    });
  });

  it('should never carry a browser key or a box key', () => {
    // Arrange
    const key = storedKey(1);

    // Act
    const text = JSON.stringify(memberView(storedMember(1, { keys: [key] })));

    // Assert
    should(text).not.containEql(key.memberKey);
    should(text).not.containEql(key.boxKey);
  });

  it('should copy the catalog list rather than share it', () => {
    // Arrange
    const member = storedMember(1, { catalogIds: [catalogId(1)] });

    // Act
    const view = memberView(member);

    // Assert
    should(view.catalogIds).not.equal(member.catalogIds);
  });
});

describe('shareView', () => {
  it('should show a live share and who used it', () => {
    // Arrange
    const share = storedShare(1, {
      uses: { kind: 'multi', cap: 5 },
      used: 1,
      usedBy: [{ clientName: 'Firefox', keyId: keyId(1), at: iso(T0) }],
    });

    // Act
    const view = shareView(share, T0);

    // Assert
    should(view).eql({
      shareId: shareId(1),
      memberId: memberId(1),
      memberLabel: 'Member 1',
      catalogIds: [catalogId(1)],
      createdAt: iso(T0),
      expiresAt: iso(T0 + HOUR),
      uses: { kind: 'multi', cap: 5 },
      state: 'live',
      usedBy: [{ clientName: 'Firefox', keyId: keyId(1), at: iso(T0) }],
    });
  });

  it('should read a share past its expiry as expired', () => {
    // Arrange
    const share = storedShare(1);

    // Act
    const view = shareView(share, T0 + HOUR);

    // Assert
    should(view.state).equal('expired');
  });

  it('should carry no digest, no code and no success times', () => {
    // Arrange
    const share = storedShare(1, { successes: [T0] });

    // Act
    const text = JSON.stringify(shareView(share, T0));

    // Assert
    should(text).not.containEql(digestOf(codeOf(1)));
    should(text).not.containEql('codeSha256');
    should(text).not.containEql('successes');
    should(text).not.containEql(codeOf(1));
  });
});

describe('listedShares', () => {
  it('should answer nothing for no shares', () => {
    // Arrange / Act / Assert
    should(listedShares([], T0)).eql([]);
  });

  it('should list the live shares first, each group newest first', () => {
    // Arrange
    const shares = [
      storedShare(1, { createdAt: iso(T0 + 1_000), state: 'ended' }),
      storedShare(2, { createdAt: iso(T0 + 2_000) }),
      storedShare(3, { createdAt: iso(T0 + 3_000), state: 'spent' }),
      storedShare(4, { createdAt: iso(T0 + 4_000) }),
      storedShare(5, { createdAt: iso(T0 - 5_000), expiresAt: iso(T0 - 1) }),
    ];

    // Act
    const listed = listedShares(shares, T0);

    // Assert
    should(listed.map(view => view.shareId)).eql([shareId(4), shareId(2), shareId(3), shareId(1), shareId(5)]);
    should(listed.map(view => view.state)).eql(['live', 'live', 'spent', 'ended', 'expired']);
  });

  it('should answer no more than the list holds, keeping the live ones', () => {
    // Arrange: 501 ended shares and one live, the live one the oldest
    const ended = Array.from({ length: CATALOG_SHARES_LISTED_MAX + 1 }, (_, index) =>
      storedShare(index + 10, { state: 'ended', createdAt: iso(T0 + index * 1_000) }),
    );
    const live = storedShare(1, { createdAt: iso(T0 - 1_000_000) });

    // Act
    const listed = listedShares([...ended, live], T0);

    // Assert
    should(listed).have.length(CATALOG_SHARES_LISTED_MAX);
    should(listed[0]?.shareId).equal(shareId(1));
    should(listed.at(-1)?.createdAt).equal(iso(T0 + 2_000));
  });
});
