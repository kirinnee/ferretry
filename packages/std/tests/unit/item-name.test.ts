import { describe, it } from 'bun:test';
import should from 'should';
import { ITEM_NAME_PATTERN } from '../../src/schemas.ts';

describe('ITEM_NAME_PATTERN', () => {
  it('should take ASCII letters and digits in words joined by single dashes, case kept', () => {
    for (const name of ['a', 'A1', 'notes', 'My-Server-2', 'claude-code', '9-lives'])
      should(ITEM_NAME_PATTERN.test(name)).equal(true);
  });

  it('should refuse a name that could be read as a path or that looks like one that could', () => {
    const refused = ['', '-a', 'a-', 'a--b', 'a/b', 'a.b', 'a b', 'a\nb', 'a\u0000b', '..', 'ａ', 'é', 'a_b'];
    for (const name of refused) should(ITEM_NAME_PATTERN.test(name)).equal(false);
  });
});
