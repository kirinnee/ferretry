import { describe, it } from 'bun:test';
import should from 'should';
import { assertSemver } from '../../src/lib/version.ts';

describe('semver guard', () => {
  it('should accept plain release versions', () => {
    // Act
    const actual = assertSemver('1.2.3');

    // Assert
    should(actual).equal('1.2.3');
  });

  it('should accept pre-release and build metadata', () => {
    // Act
    const actual = assertSemver('1.2.3-beta.1+build.5');

    // Assert
    should(actual).equal('1.2.3-beta.1+build.5');
  });

  it('should reject non-semver strings', () => {
    // Act + Assert
    for (const value of ['', 'v1.2.3', '1.2', '01.2.3', '1.2.3.4', 'latest']) {
      should(() => assertSemver(value)).throw();
    }
  });
});
