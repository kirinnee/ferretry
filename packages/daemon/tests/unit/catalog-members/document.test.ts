import { describe, it } from 'bun:test';
import { CATALOG_SHARES_LISTED_MAX } from '@ferretry/protocol';
import should from 'should';
import {
  CATALOG_MEMBERS_SCHEMA_VERSION,
  CATALOG_SHARES_SCHEMA_VERSION,
  documentProblem,
  EMPTY_MEMBERS_DOCUMENT,
  EMPTY_SHARES_DOCUMENT,
  MembersDocumentSchema,
  SHARE_SUCCESS_WINDOW_MAX,
  SharesDocumentSchema,
} from '../../../src/lib/catalog-members/document.ts';
import {
  catalogId,
  codeOf,
  digestOf,
  keyId,
  keysOf,
  memberId,
  membersDoc,
  sharesDoc,
  shareId,
  storedKey,
  storedMember,
  storedShare,
} from './support.ts';

describe('the stored member and share documents', () => {
  it('should start both documents empty at schema version 1', () => {
    // Arrange / Act / Assert
    should(CATALOG_MEMBERS_SCHEMA_VERSION).equal(1);
    should(CATALOG_SHARES_SCHEMA_VERSION).equal(1);
    should(SHARE_SUCCESS_WINDOW_MAX).equal(60);
    should(MembersDocumentSchema.safeParse(EMPTY_MEMBERS_DOCUMENT).success).be.true();
    should(SharesDocumentSchema.safeParse(EMPTY_SHARES_DOCUMENT).success).be.true();
  });

  it('should accept a member with browsers and a share with its history', () => {
    // Arrange
    const member = storedMember(1, {
      catalogIds: [catalogId(1), catalogId(2)],
      keys: [storedKey(1, { lastSeenAt: '2026-03-02T00:00:00.000Z', passkeyWindowEndsAt: '2026-03-01T12:10:00.000Z' })],
    });
    const share = storedShare(1, {
      used: 1,
      successes: [1_700_000_000_000],
      usedBy: [{ clientName: 'Firefox', keyId: keyId(1), at: '2026-03-01T12:00:00.000Z' }],
    });

    // Act
    const members = MembersDocumentSchema.safeParse(membersDoc(member));
    const shares = SharesDocumentSchema.safeParse(sharesDoc(share));

    // Assert
    should(members.success).be.true();
    should(shares.success).be.true();
  });

  it('should refuse a member listed twice', () => {
    // Arrange
    const document = membersDoc(storedMember(1), storedMember(1));

    // Act
    const problem = documentProblem(MembersDocumentSchema.safeParse(document));

    // Assert
    should(problem).equal(`${memberId(1)} is listed twice (at members)`);
  });

  it('should refuse a browser key id listed twice across members', () => {
    // Arrange
    const document = membersDoc(storedMember(1, { keys: [storedKey(1)] }), storedMember(2, { keys: [storedKey(1)] }));

    // Act
    const problem = documentProblem(MembersDocumentSchema.safeParse(document));

    // Assert
    should(problem).equal(`${keyId(1)} is listed twice (at members)`);
  });

  it('should refuse more browsers across members than the publisher allows', () => {
    // Arrange: 200 + 200 + 113 = 513, one past the most
    const document = membersDoc(
      storedMember(1, { keys: keysOf(1, 200) }),
      storedMember(2, { keys: keysOf(201, 200) }),
      storedMember(3, { keys: keysOf(401, 113) }),
    );

    // Act
    const problem = documentProblem(MembersDocumentSchema.safeParse(document));

    // Assert
    should(problem).equal('it holds 513 member keys; the most is 512 (at members)');
  });

  it('should accept exactly the most browsers across members', () => {
    // Arrange
    const document = membersDoc(
      storedMember(1, { keys: keysOf(1, 200) }),
      storedMember(2, { keys: keysOf(201, 200) }),
      storedMember(3, { keys: keysOf(401, 112) }),
    );

    // Act
    const parsed = MembersDocumentSchema.safeParse(document);

    // Assert
    should(parsed.success).be.true();
  });

  it('should refuse one member with more browsers than a member may have', () => {
    // Arrange
    const document = membersDoc(storedMember(1, { keys: keysOf(1, 201) }));

    // Act
    const parsed = MembersDocumentSchema.safeParse(document);

    // Assert
    should(parsed.success).be.false();
  });

  it('should refuse a catalog named twice for one member', () => {
    // Arrange
    const document = membersDoc(storedMember(1, { catalogIds: [catalogId(1), catalogId(1)] }));

    // Act
    const problem = documentProblem(MembersDocumentSchema.safeParse(document));

    // Assert
    should(problem).containEql('each catalog is named once');
  });

  it('should refuse a share listed twice', () => {
    // Arrange
    const document = sharesDoc(storedShare(1), storedShare(1, { codeSha256: digestOf(codeOf(2)) }));

    // Act
    const problem = documentProblem(SharesDocumentSchema.safeParse(document));

    // Assert
    should(problem).equal(`${shareId(1)} is listed twice (at shares)`);
  });

  it('should refuse two shares with the same code', () => {
    // Arrange
    const document = sharesDoc(storedShare(1), storedShare(2, { codeSha256: digestOf(codeOf(1)) }));

    // Act
    const problem = documentProblem(SharesDocumentSchema.safeParse(document));

    // Assert
    should(problem).equal(`${shareId(2)} has the same code as another share (at shares)`);
  });

  it('should refuse a share that carries a code in clear', () => {
    // Arrange: the schema is strict, so there is no field a code could be filed under
    const document = { ...sharesDoc(), shares: [{ ...storedShare(1), code: codeOf(1) }] };

    // Act
    const parsed = SharesDocumentSchema.safeParse(document);

    // Assert
    should(parsed.success).be.false();
  });

  it('should refuse a digest that is not lowercase hex of 64 characters', () => {
    // Arrange
    const upper = sharesDoc(storedShare(1, { codeSha256: digestOf(codeOf(1)).toUpperCase() }));
    const short = sharesDoc(storedShare(1, { codeSha256: 'abc' }));

    // Act / Assert
    should(SharesDocumentSchema.safeParse(upper).success).be.false();
    should(SharesDocumentSchema.safeParse(short).success).be.false();
  });

  it('should refuse a field the schema does not name', () => {
    // Arrange
    const member = { ...storedMember(1), extra: true };
    const key = { ...storedKey(1), password: 'x' };

    // Act / Assert
    should(MembersDocumentSchema.safeParse({ ...membersDoc(), members: [member] }).success).be.false();
    should(
      MembersDocumentSchema.safeParse({ ...membersDoc(), members: [storedMember(1, { keys: [key] })] }).success,
    ).be.false();
  });

  it('should refuse a document of another schema version', () => {
    // Arrange / Act / Assert
    should(MembersDocumentSchema.safeParse({ schemaVersion: 2, members: [] }).success).be.false();
    should(SharesDocumentSchema.safeParse({ schemaVersion: 2, shares: [] }).success).be.false();
  });

  it('should refuse a browser key that is not an Ed25519 key', () => {
    // Arrange
    const document = membersDoc(storedMember(1, { keys: [storedKey(1, { memberKey: 'A'.repeat(59) })] }));

    // Act
    const parsed = MembersDocumentSchema.safeParse(document);

    // Assert
    should(parsed.success).be.false();
  });
});

describe('documentProblem', () => {
  it('should answer null for a document that parsed', () => {
    // Arrange / Act
    const problem = documentProblem(MembersDocumentSchema.safeParse(EMPTY_MEMBERS_DOCUMENT));

    // Assert
    should(problem).be.null();
  });

  it('should name the first problem and where it is', () => {
    // Arrange
    const parsed = SharesDocumentSchema.safeParse({ schemaVersion: 1, shares: [{ ...storedShare(1), used: -1 }] });

    // Act
    const problem = documentProblem(parsed);

    // Assert
    should(problem).containEql('(at shares.0.used)');
  });

  it('should leave out the place when the problem is the whole document', () => {
    // Arrange
    const parsed = MembersDocumentSchema.safeParse('not a document');

    // Act
    const problem = documentProblem(parsed);

    // Assert
    should(problem).be.a.String();
    should(problem).not.containEql('(at ');
  });

  it('should say the document is malformed when the failure carries no issue', () => {
    // Arrange / Act
    const problem = documentProblem({ success: false });

    // Assert
    should(problem).equal('it is malformed');
  });
});

describe('the stored list of shares: size', () => {
  it('should refuse a document that lists more shares than a list may hold', () => {
    // Arrange
    const shares = Array.from({ length: CATALOG_SHARES_LISTED_MAX + 1 }, (_, index) => storedShare(index + 1));

    // Act
    const parsed = SharesDocumentSchema.safeParse(sharesDoc(...shares));

    // Assert
    should(parsed.success).be.false();
  });
});
