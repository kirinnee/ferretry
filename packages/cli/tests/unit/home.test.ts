import { describe, it } from 'bun:test';
import should from 'should';
import { adminTokenPath, daemonRunPath, resolveHome } from '../../src/lib/home.ts';

describe('resolveHome', () => {
  it('should default to the dot-product directory under the user home', () => {
    should(resolveHome('/home/a', undefined, 'ferretry')).equal('/home/a/.ferretry');
    should(resolveHome('/home/a', '  ', 'ferretry')).equal('/home/a/.ferretry');
  });

  it('should take an absolute FY_HOME, trimmed', () => {
    should(resolveHome('/home/a', ' /srv/fy ', 'ferretry')).equal('/srv/fy');
  });

  it('should refuse a relative FY_HOME and a relative user home', () => {
    should(() => resolveHome('/home/a', 'relative/fy', 'ferretry')).throw('FY_HOME must be an absolute path');
    should(() => resolveHome('home/a', undefined, 'ferretry')).throw('the user home directory is not an absolute path');
  });
});

describe('the two daemon documents a client reads', () => {
  it('should place the admin token and the kernel run record under the home', () => {
    should(adminTokenPath('/h')).equal('/h/state/gate/admin-token');
    should(daemonRunPath('/h')).equal('/h/run/daemon.json');
  });
});
