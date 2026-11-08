/** The collaborators a daemon has before any host seam is wired: every one that cannot answer refuses with UNAVAILABLE. */
import { describe, it } from 'bun:test';
import { fakeLoginChanges, fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import should from 'should';
import { UNAVAILABLE, unavailableCatalogDeps, unavailableSetupDeps } from '../../../daemon/lib/service/assembly.ts';

const catalogDeps = () => unavailableCatalogDeps(() => 0, fakeLogins([]), fakeLoginChanges());

describe('the setup collaborators before any host seam is wired', () => {
  it('should refuse the Claude status line with the one sentence that names the state', () => {
    const deps = unavailableSetupDeps(catalogDeps());
    should(() => deps.catalog.claudeStatusline()).throw(UNAVAILABLE);
  });

  it('should refuse to plan a tool install, and refuse to run one', async () => {
    const deps = unavailableSetupDeps(catalogDeps());
    should(() => deps.tools.plans(['claude'])).throw(UNAVAILABLE);
    await should(deps.tools.install({ harnesses: ['claude'] } as never, undefined)).be.rejectedWith(UNAVAILABLE);
  });

  it('should refuse a scan, a read and every secret call the same way', async () => {
    const deps = unavailableSetupDeps(catalogDeps());
    await should(deps.scan()).be.rejectedWith(UNAVAILABLE);
    await should(deps.readFolder('/anywhere')).be.rejectedWith(UNAVAILABLE);
    await should(deps.secrets.names()).be.rejectedWith(UNAVAILABLE);
  });
});
