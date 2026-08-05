import { describe, it } from 'bun:test';
import should from 'should';
import { FleetHealthCollector, type FleetHealthProbe } from '../../src/lib/health.ts';
import type { FleetManifest } from '../../src/lib/manifest.ts';

const account = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  kind: 'claude',
  mode: 'auto',
  wrapper: `fy-${id}`,
  home: `/tmp/${id}`,
  displayName: id,
  models: [],
  available: true,
  ...patch,
});
const manifest = (accounts: readonly Record<string, unknown>[]): FleetManifest =>
  ({ version: 1, generatedAt: '2026-08-05T00:00:00.000Z', accounts }) as unknown as FleetManifest;
const clock = { now: () => 1_786_000_000_000 };

describe('FleetHealthCollector', () => {
  it('requires a positive probe result and preserves a failed reason', async () => {
    const probe: FleetHealthProbe = {
      probe: async current =>
        current.id === 'good'
          ? { state: 'healthy', cached: false, checkedAt: clock.now(), ms: 4 }
          : {
              state: 'down',
              cached: false,
              checkedAt: clock.now(),
              ms: 5,
              failureKind: 'unexpected_reply',
              error: 'no sentinel',
            },
    };
    const actual = await new FleetHealthCollector(probe, clock).collect(manifest([account('bad'), account('good')]));
    should(actual.accounts).deepEqual([
      {
        accountId: 'bad',
        kind: 'claude',
        state: 'down',
        cached: false,
        checkedAt: clock.now(),
        ms: 5,
        failureKind: 'unexpected_reply',
        error: 'no sentinel',
      },
      { accountId: 'good', kind: 'claude', state: 'healthy', cached: false, checkedAt: clock.now(), ms: 4 },
    ]);
  });

  it('fails closed when an account was not probed', async () => {
    let calls = 0;
    const actual = await new FleetHealthCollector(
      {
        probe: async () => {
          calls += 1;
          throw new Error('unreachable');
        },
      },
      clock,
    ).collect(
      manifest([account('declared', { available: false, unavailableReason: 'maintenance' }), account('broken')]),
    );
    should(calls).equal(1);
    should(actual.accounts.map(row => row.state)).deepEqual(['unknown', 'unknown']);
    should(actual.accounts[0]?.error).equal('maintenance');
    should(actual.accounts[1]?.error).equal('unreachable');
  });
});
