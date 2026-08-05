import { describe, it } from 'bun:test';
import should from 'should';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import {
  clampUsagePercent,
  escapePrometheusLabel,
  type FleetUsageClock,
  FleetUsageCollector,
  type FleetUsageProbe,
  FleetUsageProbeResultSchema,
  FleetUsageSnapshotSchema,
  isAtLimit,
  isCorroboratedAuthRejection,
  normalizeResetAt,
  normalizeUsageWindows,
  renderFleetUsageJson,
  renderFleetUsageMetrics,
  usedPercentFromRemaining,
} from '../../src/lib/usage.ts';

const manifest = (accounts: readonly Record<string, unknown>[]): FleetManifest =>
  ({ accounts }) as unknown as FleetManifest;

const account = (id: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: 'claude',
  mode: 'auto',
  wrapper: `claude-auto-${id}`,
  home: `/tmp/${id}`,
  displayName: id,
  defaultModel: 'opus',
  models: [{ id: 'opus', available: true }],
  available: true,
  ...patch,
});

const probe = (run: FleetUsageProbe['probe']): FleetUsageProbe => ({ probe: run });

/** A pinned instant: the collector stamps the snapshot, so a real clock would make it unassertable. */
const clock: FleetUsageClock = { now: () => 1_700_000_000_000 };

describe('FleetUsageCollector', () => {
  it('uses only manifest account IDs, even when wrapper attributes look like aliases', async () => {
    // Arrange
    const seen: string[] = [];
    const collector = new FleetUsageCollector(
      probe(async current => {
        seen.push(current.id);
        return { provider: 'anthropic', usageBased: true, ok: true, shortWindow: { usedPercent: 12 } };
      }),
      clock,
    );
    const input = manifest([
      account('acct-z', { wrapper: 'claude-auto-north-west', displayName: 'north-west' }),
      account('acct-a', { wrapper: 'crc-auto-atomi', displayName: 'auto-atomi' }),
    ]);

    // Act
    const actual = await collector.collect(input);

    // Assert
    should(seen).deepEqual(['acct-a', 'acct-z']);
    should(actual.accounts.map(row => row.accountId)).deepEqual(['acct-a', 'acct-z']);
    should(actual.accounts.map(row => row.kind)).deepEqual(['claude', 'claude']);
  });

  it('keeps unavailable accounts and all-disabled model accounts as explicit rows without probing', async () => {
    // Arrange
    let calls = 0;
    const collector = new FleetUsageCollector(
      probe(async () => {
        calls += 1;
        return { usageBased: true, ok: true };
      }),
      clock,
    );
    const input = manifest([
      account('declared-down', { available: false, unavailableReason: 'maintenance' }),
      account('models-down', {
        models: [
          { id: 'one', available: false, unavailableReason: 'model retired' },
          { id: 'two', available: false },
        ],
      }),
    ]);

    // Act
    const actual = await collector.collect(input);

    // Assert
    should(calls).equal(0);
    should(actual.accounts).deepEqual([
      {
        accountId: 'declared-down',
        kind: 'claude',
        usageBased: false,
        ok: false,
        unavailable: true,
        unavailableReason: 'maintenance',
        atLimit: false,
      },
      {
        accountId: 'models-down',
        kind: 'claude',
        usageBased: false,
        ok: false,
        unavailable: true,
        unavailableReason: 'model retired',
        atLimit: false,
      },
    ]);
  });

  it('fails open for transient errors but preserves a probe-proven unavailable verdict', async () => {
    // Arrange
    const collector = new FleetUsageCollector(
      probe(async current => {
        if (current.id === 'network-error') throw new Error('connection refused');
        return { provider: 'cliproxy', usageBased: false, ok: false, unavailable: true, unavailableReason: 'auth' };
      }),
      clock,
    );

    // Act
    const actual = await collector.collect(manifest([account('network-error'), account('rejected')]));

    // Assert
    should(actual.accounts[0]).match({ accountId: 'network-error', unavailable: false, atLimit: false, ok: false });
    should(actual.accounts[0]?.error).equal('connection refused');
    should(actual.accounts[1]).match({ accountId: 'rejected', unavailable: true, atLimit: true, ok: false });
  });

  it('limits concurrent probes while retaining stable output ordering', async () => {
    // Arrange
    let active = 0;
    let maximum = 0;
    const collector = new FleetUsageCollector(
      probe(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Bun.sleep(5);
        active -= 1;
        return { usageBased: true, ok: true };
      }),
      clock,
      { concurrency: 2 },
    );

    // Act
    const actual = await collector.collect(
      manifest([account('e'), account('d'), account('c'), account('b'), account('a')]),
    );

    // Assert
    should(maximum).equal(2);
    should(actual.accounts.map(row => row.accountId)).deepEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('fleet usage renderers', () => {
  it('renders the exact JSON endpoint envelope', () => {
    // Arrange
    const snapshot = {
      at: 5,
      accounts: [{ accountId: 'a', kind: 'codex', usageBased: false, ok: false, unavailable: false, atLimit: false }],
    };

    // Act
    const actual = renderFleetUsageJson(snapshot);

    // Assert
    should(actual).equal(
      '{"at":5,"accounts":[{"accountId":"a","kind":"codex","usageBased":false,"ok":false,"unavailable":false,"atLimit":false}]}',
    );
  });

  it('renders escaped Prometheus labels, known values, reset seconds, and a never age', () => {
    // Arrange
    const snapshot = {
      at: 0,
      accounts: [
        {
          accountId: 'a"\\\n',
          kind: 'claude',
          provider: 'z.ai',
          usageBased: true,
          ok: true,
          unavailable: false,
          authOk: false,
          atLimit: true,
          shortWindow: { usedPercent: 100, resetAt: 12_345 },
        },
      ],
    };

    // Act
    const actual = renderFleetUsageMetrics(snapshot, 9_999_999);

    // Assert
    should(actual).containEql('fy_fleet_usage_probe_age_seconds -1');
    should(actual).containEql('account_id="a\\"\\\\\\n",kind="claude",provider="z.ai"');
    should(actual).containEql('fy_fleet_account_auth_ok{account_id="a\\"\\\\\\n",kind="claude",provider="z.ai"} 0');
    should(actual).containEql(
      'fy_fleet_account_usage_5h_reset_seconds{account_id="a\\"\\\\\\n",kind="claude",provider="z.ai"} 12',
    );
    should(actual).not.containEql('usage_weekly_percent{');
  });

  it('escapes each Prometheus special character', () => {
    // Arrange
    const input = 'one\\two"three\nfour';

    // Act
    const actual = escapePrometheusLabel(input);

    // Assert
    should(actual).equal('one\\\\two\\"three\\nfour');
  });
});

describe('fleet usage normalization', () => {
  it('clamps percentages and converts remaining capacity to used capacity', () => {
    // Arrange
    const over = 180;
    const remaining = 25;

    // Act
    const clamped = clampUsagePercent(over);
    const used = usedPercentFromRemaining(remaining);

    // Assert
    should(clamped).equal(100);
    should(used).equal(75);
    should(clampUsagePercent(Number.NaN)).equal(undefined);
  });

  it('normalizes ISO values and epoch seconds into milliseconds', () => {
    // Arrange
    const iso = '2024-01-01T00:00:00.000Z';

    // Act
    const fromIso = normalizeResetAt(iso);
    const fromSeconds = normalizeResetAt(1_704_067_200);

    // Assert
    should(fromIso).equal(1_704_067_200_000);
    should(fromSeconds).equal(1_704_067_200_000);
    should(normalizeResetAt('not a date')).equal(undefined);
  });

  it('orders unnamed quota windows by reset horizon and exhausts on either window', () => {
    // Arrange
    const windows = normalizeUsageWindows([
      { usedPercent: 20, resetAt: 1_700_100_000_000 },
      { remainingPercent: 0, resetAt: 1_700_000_000 },
    ]);

    // Act
    const atLimit = isAtLimit(windows.shortWindow, windows.longWindow);

    // Assert
    should(windows.shortWindow).deepEqual({ usedPercent: 100, resetAt: 1_700_000_000_000 });
    should(windows.longWindow).deepEqual({ usedPercent: 20, resetAt: 1_700_100_000_000 });
    should(atLimit).equal(true);
  });

  it('requires every attempt to corroborate an authentication rejection', () => {
    // Arrange
    const rejected = [false, false, false] as const;
    const transient = [false, undefined, false] as const;

    // Act
    const proven = isCorroboratedAuthRejection(rejected);
    const inconclusive = isCorroboratedAuthRejection(transient);

    // Assert
    should(proven).equal(true);
    should(inconclusive).equal(false);
  });

  it('keeps public schemas strict', () => {
    // Arrange
    const invalidProbe = { usageBased: true, ok: true, surprise: true };
    const invalidSnapshot = { at: 0, accounts: [], surprise: true };

    // Act
    const parseProbe = (): unknown => FleetUsageProbeResultSchema.parse(invalidProbe);
    const parseSnapshot = (): unknown => FleetUsageSnapshotSchema.parse(invalidSnapshot);

    // Assert
    should(parseProbe).throw();
    should(parseSnapshot).throw();
  });
});

describe('FleetUsageCollector probing once per credential', () => {
  it('should probe an identity once and give every account on it the same reading', async () => {
    // Arrange — three lanes of one provider account. They share a quota, so asking three times asks
    // the same question three times, and on a throttled account those are the worst calls to spend.
    const probed: string[] = [];
    const subject = new FleetUsageCollector(
      probe(account_ => {
        probed.push(account_.id);
        return Promise.resolve({ provider: 'anthropic', usageBased: true, ok: true, shortWindow: { usedPercent: 42 } });
      }),
      clock,
      { identityOf: () => 'claude:kirin' },
    );

    // Act
    const snapshot = await subject.collect(manifest([account('a'), account('b'), account('c')]));

    // Assert — one call, three rows, all carrying the reading.
    should(probed).deepEqual(['a']);
    should(snapshot.accounts).have.length(3);
    should(snapshot.accounts.map(row => row.shortWindow?.usedPercent)).deepEqual([42, 42, 42]);
    should(snapshot.accounts.map(row => row.accountId)).deepEqual(['a', 'b', 'c']);
  });

  it('should probe each identity separately', async () => {
    // Arrange
    const probed: string[] = [];
    const subject = new FleetUsageCollector(
      probe(account_ => {
        probed.push(account_.id);
        return Promise.resolve({ usageBased: true, ok: true });
      }),
      clock,
      { identityOf: account_ => (account_.id === 'c' ? 'claude:other' : 'claude:kirin') },
    );

    // Act
    await subject.collect(manifest([account('a'), account('b'), account('c')]));

    // Assert — two credentials, two calls.
    should(probed.sort()).deepEqual(['a', 'c']);
  });

  it('should probe once per account when no grouping is supplied', async () => {
    // Arrange — the previous behaviour, unchanged for a caller that shares nothing.
    const probed: string[] = [];
    const subject = new FleetUsageCollector(
      probe(account_ => {
        probed.push(account_.id);
        return Promise.resolve({ usageBased: true, ok: true });
      }),
      clock,
    );

    // Act
    await subject.collect(manifest([account('a'), account('b')]));

    // Assert
    should(probed.sort()).deepEqual(['a', 'b']);
  });

  it('should never probe or represent an account the manifest declares unavailable', async () => {
    // Arrange — an unavailable lane must not be able to suppress its siblings by being chosen first.
    const probed: string[] = [];
    const subject = new FleetUsageCollector(
      probe(account_ => {
        probed.push(account_.id);
        return Promise.resolve({ usageBased: true, ok: true, shortWindow: { usedPercent: 7 } });
      }),
      clock,
      { identityOf: () => 'claude:kirin' },
    );
    const accounts = manifest([
      account('a', { available: false, unavailableReason: 'the harness is missing' }),
      account('b'),
    ]);

    // Act
    const snapshot = await subject.collect(accounts);

    // Assert — 'a' sorts first but was skipped; 'b' represented the identity and still got its reading.
    should(probed).deepEqual(['b']);
    const [first, second] = snapshot.accounts;
    should(first?.unavailable).be.true();
    should(first?.unavailableReason).equal('the harness is missing');
    should(second?.shortWindow?.usedPercent).equal(7);
  });

  it('should give every account on a failed identity the same honest failure', async () => {
    // Arrange
    const subject = new FleetUsageCollector(
      probe(() => Promise.reject(new Error('socket hang up'))),
      clock,
      { identityOf: () => 'claude:kirin' },
    );

    // Act
    const snapshot = await subject.collect(manifest([account('a'), account('b')]));

    // Assert — a failure fans out as a failure, never as a reading and never as at-limit.
    should(snapshot.accounts.map(row => row.ok)).deepEqual([false, false]);
    should(snapshot.accounts.map(row => row.error)).deepEqual(['socket hang up', 'socket hang up']);
    should(snapshot.accounts.map(row => row.atLimit)).deepEqual([false, false]);
  });

  it('should not let a failed probe mark a shared identity at its limit', async () => {
    // Arrange — the stricter-than-source rule, now that one failure reaches many rows.
    const subject = new FleetUsageCollector(
      probe(() => Promise.resolve({ usageBased: true, ok: false, atLimit: true, shortWindow: { usedPercent: 100 } })),
      clock,
      { identityOf: () => 'claude:kirin' },
    );

    // Act
    const snapshot = await subject.collect(manifest([account('a'), account('b')]));

    // Assert
    should(snapshot.accounts.map(row => row.atLimit)).deepEqual([false, false]);
  });

  it('should fan a proven-unavailable reading to every account on the identity', async () => {
    // Arrange
    const subject = new FleetUsageCollector(
      probe(() =>
        Promise.resolve({
          usageBased: true,
          ok: false,
          unavailable: true,
          unavailableReason: 'this credential was rejected',
        }),
      ),
      clock,
      { identityOf: () => 'claude:kirin' },
    );

    // Act
    const snapshot = await subject.collect(manifest([account('a'), account('b')]));

    // Assert — one dead credential takes out every lane on it, which is the truth.
    should(snapshot.accounts.map(row => row.unavailable)).deepEqual([true, true]);
    should(snapshot.accounts.map(row => row.atLimit)).deepEqual([true, true]);
  });
});
