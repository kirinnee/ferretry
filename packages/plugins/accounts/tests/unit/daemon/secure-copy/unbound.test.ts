import { describe, it } from 'bun:test';
import should from 'should';
import type { BrowsersApi } from '@ferretry/plugin-browsers/contract';
import { absentWhileUnbound, BrowsersCopyGuards } from '../../../../daemon/adapters/secure-copy/index.ts';

/**
 * A port a plugin only `uses` is read through `ctx.uses.<name>.current()`, and while the plugin is still BUILDING the
 * kernel answers that call by THROWING ("an optional port is unbound during build"), not by answering `undefined`.
 * Ferrets announces every ferret's state as the daemon comes up, so the `ferrets.changed` subscriber runs in that window:
 * it must find "no Browsers yet" and carry on, not fail (the kernel logged `a subscriber failed [accounts]` for every
 * stopped ferret of a migrated home, and the approvals the same subscriber settles were skipped with it).
 */
const unboundDuringBuild = (): BrowsersApi | undefined => {
  throw new TypeError('accounts: an optional port is unbound during build');
};

describe('a port read while the plugin is still building', () => {
  it('should read as absent, not throw', () => {
    should(absentWhileUnbound(unboundDuringBuild)()).equal(undefined);
  });

  it('should hand a bound port through untouched', () => {
    const api = {} as BrowsersApi;
    should(absentWhileUnbound(() => api)()).equal(api);
  });

  it('should let a ferret that ended be forgotten by the guards before Browsers is bound', () => {
    const guards = new BrowsersCopyGuards(absentWhileUnbound(unboundDuringBuild));
    should(() => guards.drop('F1')).not.throw();
  });
});
