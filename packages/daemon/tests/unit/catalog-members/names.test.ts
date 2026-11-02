import { describe, it } from 'bun:test';
import should from 'should';
import { freeMemberName, renameNotice, uniqueMemberNames } from '../../../src/lib/catalog-members/names.ts';
import { memberId, iso, storedMember, T0 } from './support.ts';

const keys = (...names: string[]): Set<string> => new Set(names);

describe('freeMemberName', () => {
  it('should keep a name nobody has', () => {
    should(freeMemberName('Alice', keys('bob'))).equal('Alice');
  });

  it('should count up from (2) to the first name nobody has', () => {
    should(freeMemberName('Alice', keys('alice'))).equal('Alice (2)');
    should(freeMemberName('Alice', keys('alice', 'alice (2)', 'alice (3)'))).equal('Alice (4)');
  });

  it('should stay within 80 characters, cutting the base and not the suffix', () => {
    const long = 'a'.repeat(80);
    const free = freeMemberName(long, keys(long));
    should(free).equal(`${'a'.repeat(76)} (2)`);
    should(free.length).equal(80);
  });

  it('should never cut a character in two', () => {
    const long = '😀'.repeat(40);
    const free = freeMemberName(long, keys(long.toLowerCase()));
    should(Array.from(free).every(char => char === '😀' || ' (2)'.includes(char))).be.true();
    should(free.length).be.belowOrEqual(80);
    should(free.endsWith(' (2)')).be.true();
  });

  it('should not leave a space before the suffix when the cut lands on one', () => {
    const name = `${'a'.repeat(75)} bbbb`;
    const free = freeMemberName(name, keys(name));
    should(free).equal(`${'a'.repeat(75)} (2)`);
  });
});

describe('uniqueMemberNames', () => {
  it('should never rename a person whose name was already unique, nor hand anyone an ID somebody holds', () => {
    const members = [
      storedMember(1, { label: 'Alice', createdAt: iso(T0) }),
      storedMember(2, { label: 'alice', createdAt: iso(T0 + 1_000) }),
      storedMember(3, { label: 'Alice (2)', createdAt: iso(T0 + 2_000) }),
    ];

    const result = uniqueMemberNames(members);

    should(result.members.map(member => member.label)).eql(['Alice', 'alice (3)', 'Alice (2)']);
    should(result.renames).eql([{ memberId: memberId(2), from: 'alice', to: 'alice (3)' }]);
  });

  it('should change nobody whose name is unique, whatever the others hold', () => {
    const members = [
      storedMember(1, { label: 'Sam', createdAt: iso(T0) }),
      storedMember(2, { label: 'Sam (2)', createdAt: iso(T0 + 1_000) }),
      storedMember(3, { label: 'sam', createdAt: iso(T0 + 2_000) }),
      storedMember(4, { label: 'SAM (3)', createdAt: iso(T0 + 3_000) }),
      storedMember(5, { label: 'Bea', createdAt: iso(T0 + 4_000) }),
    ];

    const result = uniqueMemberNames(members);

    should(result.members.map(member => member.label)).eql(['Sam', 'Sam (2)', 'sam (4)', 'SAM (3)', 'Bea']);
    should(result.renames.map(rename => rename.memberId)).eql([memberId(3)]);
  });

  it('should answer the same members when no two share a name', () => {
    const members = [storedMember(1, { label: 'Alice' }), storedMember(2, { label: 'Bob' })];

    const result = uniqueMemberNames(members);

    should(result.members).equal(members);
    should(result.renames).eql([]);
  });

  it('should let the oldest keep the name and number the later ones', () => {
    const members = [
      storedMember(1, { label: 'alice', createdAt: iso(T0 + 2_000) }),
      storedMember(2, { label: 'Alice', createdAt: iso(T0) }),
      storedMember(3, { label: 'ALICE', createdAt: iso(T0 + 1_000) }),
    ];

    const result = uniqueMemberNames(members);

    should(result.members.map(member => member.label)).eql(['alice (3)', 'Alice', 'ALICE (2)']);
    should(result.renames).eql([
      { memberId: memberId(3), from: 'ALICE', to: 'ALICE (2)' },
      { memberId: memberId(1), from: 'alice', to: 'alice (3)' },
    ]);
  });

  it('should break a tie in age by the order of the file', () => {
    const members = [storedMember(1, { label: 'Sam' }), storedMember(2, { label: 'sam' })];

    const result = uniqueMemberNames(members);

    should(result.members.map(member => member.label)).eql(['Sam', 'sam (2)']);
  });

  it('should not clash with a name that is already numbered', () => {
    const members = [
      storedMember(1, { label: 'Sam', createdAt: iso(T0) }),
      storedMember(2, { label: 'Sam (2)', createdAt: iso(T0 + 1) }),
      storedMember(3, { label: 'Sam', createdAt: iso(T0 + 2) }),
    ];

    const result = uniqueMemberNames(members);

    should(result.members.map(member => member.label)).eql(['Sam', 'Sam (2)', 'Sam (3)']);
  });

  it('should be idempotent: a second pass finds nothing to do', () => {
    const once = uniqueMemberNames([storedMember(1, { label: 'Sam' }), storedMember(2, { label: 'Sam' })]);

    const twice = uniqueMemberNames(once.members);

    should(twice.renames).eql([]);
    should(twice.members).equal(once.members);
  });
});

describe('renameNotice', () => {
  it('should tell one rename in the owner’s words', () => {
    should(renameNotice([{ memberId: memberId(2), from: 'Alice', to: 'Alice (2)' }])).equal(
      'Two people here had the same name, so one is now Alice (2). Rename or remove whichever is wrong in Sharing › People.',
    );
  });

  it('should say how many, and who, when there are several', () => {
    should(
      renameNotice([
        { memberId: memberId(2), from: 'Alice', to: 'Alice (2)' },
        { memberId: memberId(3), from: 'Bob', to: 'Bob (2)' },
      ]),
    ).equal(
      'Several people here had the same name, so 2 are now Alice (2), Bob (2). Rename or remove whichever is wrong in Sharing › People.',
    );
  });
});
