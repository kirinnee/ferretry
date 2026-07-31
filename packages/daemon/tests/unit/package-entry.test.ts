import { describe, it } from 'bun:test';
import should from 'should';
import { daemonVersion, packageRole } from '../../src/lib/index.ts';

describe('daemon package entry', () => {
  it('should expose its workspace role', () => {
    // Act
    const actual = packageRole;

    // Assert
    should(actual).equal('daemon');
  });

  it('should expose the package manifest version as semver', () => {
    // Act
    const actual = daemonVersion;

    // Assert
    should(actual).match(/^\d+\.\d+\.\d+/);
  });
});
