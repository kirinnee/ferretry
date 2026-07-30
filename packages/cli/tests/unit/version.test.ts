import { describe, it } from 'bun:test';
import should from 'should';
import { assertSemver, isSemver } from '../../src/lib/version';

describe('semver guard', () => {
  it('should accept plain release versions', () => {
    // Act
    const actual = isSemver('1.2.3');

    // Assert
    should(actual).be.true();
  });

  it('should accept pre-release and build metadata', () => {
    // Act
    const actual = isSemver('1.2.3-beta.1+build.5');

    // Assert
    should(actual).be.true();
  });

  it('should reject non-semver strings', () => {
    // Act + Assert
    for (const value of ['', 'v1.2.3', '1.2', '01.2.3', '1.2.3.4', 'latest']) {
      should(isSemver(value)).be.false();
    }
  });

  it('should return a valid version unchanged from assertSemver', () => {
    // Act
    const actual = assertSemver('0.1.0');

    // Assert
    should(actual).equal('0.1.0');
  });

  it('should throw from assertSemver on an invalid version', () => {
    // Act + Assert
    should(() => assertSemver('not-a-version')).throw();
  });
});
