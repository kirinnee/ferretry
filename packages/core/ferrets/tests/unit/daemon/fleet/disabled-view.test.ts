import { describe, it } from 'bun:test';
import should from 'should';
import { disabledOf, runtimeDisabledView } from '../../../src/lib/fleet/disabled-view.ts';

describe('disabledOf', () => {
  it('should show a reason and turn a bare date into an instant', () => {
    should(disabledOf({ reason: 'spend limit', until: '2026-11-01' }, 'login')).eql({
      reason: 'spend limit',
      until: '2026-11-01T00:00:00.000Z',
      source: 'login',
    });
  });

  it('should leave out what was not said, and an until that reads as nothing', () => {
    should(disabledOf({}, 'runtime')).eql({ source: 'runtime' });
    should(disabledOf({ until: 'garbled' }, 'runtime')).eql({ source: 'runtime' });
  });
});

describe('runtimeDisabledView', () => {
  it('should prefer the runtime switch over the login switch', () => {
    const clauses: readonly string[] = [];
    should(runtimeDisabledView({ own: { reason: 'a' }, login: { reason: 'b' }, clauses })).eql({
      reason: 'a',
      source: 'runtime',
    });
    should(runtimeDisabledView({ login: { reason: 'b' }, clauses })).eql({ reason: 'b', source: 'login' });
  });
});
