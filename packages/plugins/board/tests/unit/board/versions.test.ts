import { describe, it } from 'bun:test';
import should from 'should';
import { compareVersions, ReleaseVersionSchema } from '../../../daemon/lib/board/index.ts';

describe('release versions', () => {
  it('should accept semver and refuse anything else', () => {
    should(ReleaseVersionSchema.safeParse('5.0.0-rc.1+build.7').success).be.true();
    should(ReleaseVersionSchema.safeParse('five').success).be.false();
  });

  it('should be undefined when either side is not a release version', () => {
    should(compareVersions('nope', '1.0.0')).be.undefined();
    should(compareVersions('1.0.0', 'nope')).be.undefined();
  });

  it('should order the core numbers first', () => {
    should(compareVersions('1.2.3', '1.2.3')).equal(0);
    should(compareVersions('2.0.0', '1.9.9')).equal(1);
    should(compareVersions('1.2.3', '1.10.0')).equal(-1);
  });

  it('should put a prerelease before its release', () => {
    should(compareVersions('1.0.0-rc.1', '1.0.0')).equal(-1);
    should(compareVersions('1.0.0', '1.0.0-rc.1')).equal(1);
    should(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).equal(0);
  });

  it('should order prerelease parts: numeric by value, numeric before text, text by text, shorter first', () => {
    should(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).equal(-1);
    should(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).equal(1);
    should(compareVersions('1.0.0-1', '1.0.0-alpha')).equal(-1);
    should(compareVersions('1.0.0-alpha', '1.0.0-1')).equal(1);
    should(compareVersions('1.0.0-alpha', '1.0.0-beta')).equal(-1);
    should(compareVersions('1.0.0-beta', '1.0.0-alpha')).equal(1);
    should(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).equal(-1);
    should(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).equal(1);
  });
});
