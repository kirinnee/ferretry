import { describe, it } from 'bun:test';
import should from 'should';
import { parseAbsoluteHome } from '../../../daemon/lib/state-home.ts';

describe('parseAbsoluteHome (a state home handed in is checked, never resolved)', () => {
  it('should accept an absolute path and normalise it', () => {
    should(parseAbsoluteHome('/srv/ferretry/../ferretry/home', 'FY_HOME')).equal('/srv/ferretry/home');
  });

  it('should refuse an empty or blank value and name its source', () => {
    should(() => parseAbsoluteHome('   ', 'FY_HOME')).throw('invalid state home: FY_HOME must not be empty');
  });

  it('should refuse a relative path', () => {
    should(() => parseAbsoluteHome('state/home', 'config')).throw(
      'invalid state home: config must be an absolute path',
    );
  });

  it('should refuse the filesystem root, however it is spelled', () => {
    for (const root of ['/', '//', '/a/..']) {
      should(() => parseAbsoluteHome(root, 'FY_HOME')).throw(
        'invalid state home: FY_HOME must not be a filesystem root',
      );
    }
  });

  it('should carry the refused value and a name on the error', () => {
    try {
      parseAbsoluteHome('relative', 'FY_HOME');
      should.fail(undefined, undefined, 'it should have thrown');
    } catch (error) {
      should((error as Error).name).equal('InvalidStateHomeError');
      should((error as { value: string }).value).equal('relative');
      should((error as { reason: string }).reason).equal('FY_HOME must be an absolute path');
    }
  });
});
