import { describe, it } from 'bun:test';
import should from 'should';
import { resolveKey, resolveMember } from '../../../src/lib/catalog-share/resolve';
import { KEY_ID, memberView, MEMBER_ID, OTHER_KEY_ID, OTHER_MEMBER_ID } from './fixtures';

const sam = memberView();
const alex = memberView({ memberId: OTHER_MEMBER_ID, label: 'Alex' });

describe('resolving a person', () => {
  it('should find a person by id, by exact name and by name ignoring case', () => {
    should(resolveMember([sam, alex], MEMBER_ID)).equal(sam);
    should(resolveMember([sam, alex], 'Alex')).equal(alex);
    should(resolveMember([sam, alex], 'sAM')).equal(sam);
    should(resolveMember([sam, alex], '  Sam  ')).equal(sam);
  });

  it('should prefer an exact name over a case-insensitive match', () => {
    const lower = memberView({ memberId: OTHER_MEMBER_ID, label: 'sam' });
    should(resolveMember([sam, lower], 'sam')).equal(lower);
    should(resolveMember([sam, lower], 'Sam')).equal(sam);
  });

  it('should refuse a name two people share, naming their ids', () => {
    const twin = memberView({ memberId: OTHER_MEMBER_ID, label: 'Sam' });
    should(() => resolveMember([sam, twin], 'Sam')).throw(
      `more than one person is called "Sam" — use its id: ${MEMBER_ID}, ${OTHER_MEMBER_ID}`,
    );
    const shouting = memberView({ memberId: OTHER_MEMBER_ID, label: 'SAM' });
    should(() => resolveMember([sam, shouting], 'sam')).throw(/more than one person/u);
  });

  it('should refuse an unknown or empty reference', () => {
    should(() => resolveMember([sam], 'Nobody')).throw('no person "Nobody"');
    should(() => resolveMember([], 'Sam')).throw('no person "Sam"');
    should(() => resolveMember([sam], '  ')).throw('a person id or name is required');
  });
});

describe('resolving one of a person’s browsers', () => {
  const other = { ...sam.keys[0]!, keyId: OTHER_KEY_ID, clientName: 'Safari on a phone' };
  const member = memberView({ keys: [...sam.keys, other] });

  it('should find a browser by id, by exact name and by name ignoring case', () => {
    should(resolveKey(member, KEY_ID).clientName).equal('Firefox on a Mac');
    should(resolveKey(member, 'Safari on a phone').keyId).equal(OTHER_KEY_ID);
    should(resolveKey(member, 'FIREFOX ON A MAC').keyId).equal(KEY_ID);
  });

  it('should refuse two browsers with one name, naming their ids', () => {
    const twin = memberView({ keys: [sam.keys[0]!, { ...sam.keys[0]!, keyId: OTHER_KEY_ID }] });
    should(() => resolveKey(twin, 'Firefox on a Mac')).throw(
      `more than one browser of Sam is called "Firefox on a Mac" — use its id: ${KEY_ID}, ${OTHER_KEY_ID}`,
    );
  });

  it('should refuse an unknown browser, saying whose', () => {
    should(() => resolveKey(member, 'Opera')).throw('no browser of Sam "Opera"');
    should(() => resolveKey(memberView({ keys: [] }), 'Opera')).throw('no browser of Sam "Opera"');
  });
});
