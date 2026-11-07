import { describe, it } from 'bun:test';
import should from 'should';
import { slugName } from '../../../daemon/lib/account/document.ts';

describe('slugName', () => {
  it.each([
    ['Work Laptop', 'Work-Laptop'],
    ['--a__b--', 'a-b'],
    ['x'.repeat(70), 'x'.repeat(64)],
    [`${'x'.repeat(63)} y`, 'x'.repeat(63)],
  ])('should turn %j into %j', (value, expected) => {
    // Act
    const actual = slugName(value, 'fallback');

    // Assert
    should(actual).equal(expected);
  });

  it('should answer the fallback when nothing of the value survives', () => {
    // Act + Assert
    should(slugName('!!!', 'fallback')).equal('fallback');
    should(slugName('', 'fallback')).equal('fallback');
  });
});
