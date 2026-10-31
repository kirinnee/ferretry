import { describe, it } from 'bun:test';
import should from 'should';
import { keyExpired, sweepMembers } from '../../../src/lib/catalog-members/sweep.ts';
import { DAY, iso, keyId, memberId, membersDoc, MINUTE, storedKey, storedMember, T0 } from './support.ts';

const WINDOW = 10 * MINUTE;

describe('sweepMembers: the passkey window', () => {
  it('should remove a browser with no passkey once its window has closed', () => {
    // Arrange
    const key = storedKey(1, { passkeyCount: 0, passkeyWindowEndsAt: iso(T0) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed).eql([{ memberId: memberId(1), keyId: keyId(1), why: 'passkey-window' }]);
    should(swept.members.members[0]?.keys).eql([]);
    should(swept.members.members[0]?.memberId).equal(memberId(1));
  });

  it('should keep a browser with no passkey while its window is still open', () => {
    // Arrange
    const key = storedKey(1, { passkeyCount: 0, passkeyWindowEndsAt: iso(T0 + 1) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed).eql([]);
    should(swept.members).equal(document);
  });

  it('should keep a browser that registered a passkey, and stop showing its closed window', () => {
    // Arrange
    const key = storedKey(1, { passkeyCount: 1, passkeyWindowEndsAt: iso(T0 - 1) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed).eql([]);
    should(swept.members).not.equal(document);
    const kept = swept.members.members[0]?.keys[0];
    should(kept?.keyId).equal(keyId(1));
    should(kept).not.have.property('passkeyWindowEndsAt');
  });

  it("should leave a passkey holder's open window as it is", () => {
    // Arrange
    const key = storedKey(1, { passkeyCount: 1, passkeyWindowEndsAt: iso(T0 + WINDOW) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.members).equal(document);
  });
});

describe('sweepMembers: idle browsers', () => {
  it('should remove a browser last seen 90 days ago, boundary included', () => {
    // Arrange
    const key = storedKey(1, { lastSeenAt: iso(T0 - 90 * DAY) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed).eql([{ memberId: memberId(1), keyId: keyId(1), why: 'idle' }]);
  });

  it('should keep a browser last seen a moment less than 90 days ago', () => {
    // Arrange
    const key = storedKey(1, { lastSeenAt: iso(T0 - 90 * DAY + 1) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed).eql([]);
    should(swept.members).equal(document);
  });

  it('should count from the day it joined when it has never been seen again', () => {
    // Arrange
    const old = storedKey(1, { joinedAt: iso(T0 - 91 * DAY) });
    const fresh = storedKey(2, { joinedAt: iso(T0 - 10 * DAY) });
    const document = membersDoc(storedMember(1, { keys: [old, fresh] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed.map(removed => removed.keyId)).eql([keyId(1)]);
    should(swept.members.members[0]?.keys.map(key => key.keyId)).eql([keyId(2)]);
  });

  it('should prefer the last seen day over the day it joined', () => {
    // Arrange: joined long ago but seen yesterday
    const key = storedKey(1, { joinedAt: iso(T0 - 200 * DAY), lastSeenAt: iso(T0 - DAY) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed).eql([]);
  });

  it('should name the window rather than idleness when a browser is both', () => {
    // Arrange
    const key = storedKey(1, {
      passkeyCount: 0,
      joinedAt: iso(T0 - 200 * DAY),
      passkeyWindowEndsAt: iso(T0 - 199 * DAY),
    });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed[0]?.why).equal('passkey-window');
  });

  it('should remove an idle browser that never had a window', () => {
    // Arrange
    const key = storedKey(1, { passkeyCount: 0, joinedAt: iso(T0 - 100 * DAY) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed[0]?.why).equal('idle');
  });
});

describe('sweepMembers: the document', () => {
  it('should answer the same document when there is nothing to sweep', () => {
    // Arrange
    const document = membersDoc(storedMember(1, { keys: [storedKey(1)] }), storedMember(2));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.members).equal(document);
    should(swept.removed).eql([]);
  });

  it('should keep a member whose every browser went, and leave the other members untouched', () => {
    // Arrange
    const gone = storedKey(1, { passkeyCount: 0, passkeyWindowEndsAt: iso(T0 - 1) });
    const untouched = storedMember(2, { keys: [storedKey(2)] });
    const document = membersDoc(storedMember(1, { keys: [gone] }), untouched);

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.members.members).have.length(2);
    should(swept.members.members[0]?.keys).eql([]);
    should(swept.members.members[1]).equal(untouched);
  });

  it('should list the browsers it removed across members, in document order', () => {
    // Arrange
    const first = storedKey(1, { passkeyCount: 0, passkeyWindowEndsAt: iso(T0) });
    const second = storedKey(2, { joinedAt: iso(T0 - 100 * DAY) });
    const document = membersDoc(storedMember(1, { keys: [first] }), storedMember(2, { keys: [second] }));

    // Act
    const swept = sweepMembers(document, T0);

    // Assert
    should(swept.removed).eql([
      { memberId: memberId(1), keyId: keyId(1), why: 'passkey-window' },
      { memberId: memberId(2), keyId: keyId(2), why: 'idle' },
    ]);
  });

  it('should not change the document it was given', () => {
    // Arrange
    const key = storedKey(1, { passkeyCount: 0, passkeyWindowEndsAt: iso(T0) });
    const document = membersDoc(storedMember(1, { keys: [key] }));

    // Act
    sweepMembers(document, T0);

    // Assert
    should(document.members[0]?.keys).have.length(1);
  });
});

describe('keyExpired', () => {
  it('should be the same verdict the sweep removes on, whichever reason ended the key', () => {
    // Arrange
    const keys = [
      storedKey(1, { passkeyCount: 0, passkeyWindowEndsAt: iso(T0) }),
      storedKey(2, { lastSeenAt: iso(T0 - 90 * DAY) }),
      storedKey(3, { lastSeenAt: iso(T0 - 90 * DAY + 1) }),
      storedKey(4, { passkeyCount: 0, passkeyWindowEndsAt: iso(T0 + 1) }),
    ];

    // Act
    const verdicts = keys.map(key => keyExpired(key, T0));
    const removed = sweepMembers(membersDoc(storedMember(1, { keys })), T0).removed.map(entry => entry.keyId);

    // Assert
    should(verdicts).eql([true, true, false, false]);
    should(removed).eql([keyId(1), keyId(2)]);
  });
});
