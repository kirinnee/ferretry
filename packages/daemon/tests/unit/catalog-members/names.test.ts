import { describe, it } from 'bun:test';
import should from 'should';
import { freeMemberName, renameNotice } from '../../../src/lib/catalog-members/names.ts';
import { memberId } from './support.ts';

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

describe('renameNotice', () => {
  it('should tell one rename in the owner’s words', () => {
    should(renameNotice([{ memberId: memberId(2), from: 'Alice', to: 'Alice (2)' }])).equal(
      '2 people had the same user ID, so the later one was renamed: Alice → Alice (2). Each still signs in with their passkeys. Rename or remove whichever is wrong in Sharing › People.',
    );
  });

  it('should say how many, and who, when there are several', () => {
    should(
      renameNotice([
        { memberId: memberId(2), from: 'Alice', to: 'Alice (2)' },
        { memberId: memberId(3), from: 'Bob', to: 'Bob (2)' },
      ]),
    ).equal(
      'Several people had the same user ID, so the later ones were renamed: Alice → Alice (2), Bob → Bob (2). Each still signs in with their passkeys. Rename or remove whichever is wrong in Sharing › People.',
    );
  });
});
