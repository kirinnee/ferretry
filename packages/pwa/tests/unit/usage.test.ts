import type { SessionView } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonUsageIndex, hasReadout, type ResolvedQuota } from '../../src/lib/usage.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });

/** A session carrying only the identity and state the quota join reads. */
const session = (agent: string, state: Record<string, unknown> = {}): SessionView =>
  ({
    config: { id: `session-on-${agent}`, name: agent, agent, mode: 'auto', cwd: '/work' },
    state: { id: `session-on-${agent}`, status: 'running', turn: 1, ...state },
  }) as unknown as SessionView;

const feed = (accounts: readonly Record<string, unknown>[], stale = false): unknown => ({
  at: '2026-07-31T00:00:00.000Z',
  stale,
  accounts,
});

describe('hasReadout', () => {
  it('rejects no data and an all-undefined record, so neither can imply zero usage', () => {
    should(hasReadout(null)).be.false();
    should(hasReadout({})).be.false();
    // Reset instants alone are not a readout: there is no number to render.
    should(hasReadout({ fiveHourResetAt: 1_760_000_000, weeklyResetAt: 1_760_000_000 })).be.false();
    should(hasReadout({ authOk: true })).be.false();
    should(hasReadout({ atLimit: false })).be.false();
  });

  it('accepts an auth failure and every usable number, including a genuine zero', () => {
    should(hasReadout({ authOk: false })).be.true();
    should(hasReadout({ atLimit: true })).be.true();
    // Zero percent IS a readout when the daemon actually said so — the null
    // contract exists so absent data is never rendered as this value.
    should(hasReadout({ fiveHourPercent: 0 })).be.true();
    should(hasReadout({ weeklyPercent: 41 })).be.true();
  });
});

describe('DaemonUsageIndex', () => {
  it("prefers a session's own stamped state over the daemon-wide feed", () => {
    const index = new DaemonUsageIndex();
    const applied = index.apply(daemonA.daemonId, feed([{ agent: 'claude', fiveHourPercent: 12, weeklyPercent: 30 }]));
    should(applied).be.true();

    const quota = index.quotaFor(
      daemonA.daemonId,
      session('claude', {
        usage5hPercent: 88,
        usageWeeklyPercent: 91,
        usage5hResetAt: 1_760_000_000,
        usageWeeklyResetAt: 1_760_600_000,
        usageAtLimit: true,
        usageAuthOk: true,
      }),
    );

    should(quota).eql({
      fiveHourPercent: 88,
      weeklyPercent: 91,
      fiveHourResetAt: 1_760_000_000,
      weeklyResetAt: 1_760_600_000,
      atLimit: true,
      authOk: true,
    } satisfies ResolvedQuota);
  });

  it('treats any single stamped field as state, but reset instants alone as unstamped', () => {
    const index = new DaemonUsageIndex();
    index.apply(daemonA.daemonId, feed([{ agent: 'codex', weeklyPercent: 30 }]));

    // Each field the monitor loop may stamp on its own is enough to win.
    should(index.quotaFor(daemonA.daemonId, session('codex', { usageAuthOk: false }))?.authOk).be.false();
    should(index.quotaFor(daemonA.daemonId, session('codex', { usage5hPercent: 7 }))?.fiveHourPercent).equal(7);
    should(index.quotaFor(daemonA.daemonId, session('codex', { usageWeeklyPercent: 8 }))?.weeklyPercent).equal(8);
    should(index.quotaFor(daemonA.daemonId, session('codex', { usageAtLimit: false }))?.atLimit).be.false();

    // A reset instant is not a readout, so the feed still fills this session in.
    should(index.quotaFor(daemonA.daemonId, session('codex', { usage5hResetAt: 1_760_000_000 }))?.weeklyPercent).equal(
      30,
    );
  });

  it('fills an unmonitored session from its own daemon feed', () => {
    const index = new DaemonUsageIndex();
    index.apply(
      daemonA.daemonId,
      feed([{ agent: 'claude', fiveHourPercent: 12, weeklyPercent: 30, fiveHourResetAt: 1_760_000_000, authOk: true }]),
    );

    should(index.quotaFor(daemonA.daemonId, session('claude'))).eql({
      fiveHourPercent: 12,
      weeklyPercent: 30,
      fiveHourResetAt: 1_760_000_000,
      weeklyResetAt: undefined,
      atLimit: undefined,
      authOk: true,
    } satisfies ResolvedQuota);
  });

  it('returns null rather than zero when neither source knows the wrapper', () => {
    const index = new DaemonUsageIndex();

    // No feed at all for this daemon.
    should(index.quotaFor(daemonA.daemonId, session('claude'))).be.null();

    // A feed that simply has no row for this session's agent.
    index.apply(daemonA.daemonId, feed([{ agent: 'codex', weeklyPercent: 30 }]));
    should(index.quotaFor(daemonA.daemonId, session('claude'))).be.null();
    should(hasReadout(index.quotaFor(daemonA.daemonId, session('claude')))).be.false();
  });

  it('resolves the same agent name to different quota on different daemons', () => {
    const index = new DaemonUsageIndex();
    index.apply(daemonA.daemonId, feed([{ agent: 'claude', fiveHourPercent: 12 }]));
    index.apply(daemonB.daemonId, feed([{ agent: 'claude', fiveHourPercent: 97, atLimit: true }]));

    // Identical wrapper name, unrelated machines: one index would serve daemon
    // A's 12% under daemon B's name.
    should(index.quotaFor(daemonA.daemonId, session('claude'))?.fiveHourPercent).equal(12);
    should(index.quotaFor(daemonB.daemonId, session('claude'))?.fiveHourPercent).equal(97);
    should(index.quotaFor(daemonA.daemonId, session('claude'))?.atLimit).be.undefined();
    should(index.quotaFor(daemonB.daemonId, session('claude'))?.atLimit).be.true();
  });

  it('exposes each daemon feed for its own staleness readout', () => {
    const index = new DaemonUsageIndex();
    should(index.feed(daemonA.daemonId)).be.undefined();

    index.apply(daemonA.daemonId, feed([{ agent: 'claude' }], true));
    should(index.feed(daemonA.daemonId)?.stale).be.true();
    should(index.feed(daemonA.daemonId)?.at).equal('2026-07-31T00:00:00.000Z');
    should(index.feed(daemonB.daemonId)).be.undefined();
  });

  it('rejects a malformed feed whole and keeps the last valid one', () => {
    const index = new DaemonUsageIndex();
    should(index.apply(daemonA.daemonId, feed([{ agent: 'claude', fiveHourPercent: 12 }]))).be.true();

    // A percentage outside 0-100, a missing agent name, a non-array accounts
    // field and a non-object body are each rejected as a whole response: a
    // partially parsed feed would read as "no quota" for the dropped rows.
    should(index.apply(daemonA.daemonId, feed([{ agent: 'claude', fiveHourPercent: 140 }]))).be.false();
    should(index.apply(daemonA.daemonId, feed([{ agent: '', weeklyPercent: 5 }]))).be.false();
    should(index.apply(daemonA.daemonId, { stale: false, accounts: 'none' })).be.false();
    should(index.apply(daemonA.daemonId, feed([{ agent: 'claude' }, { weeklyPercent: 5 }]))).be.false();
    should(index.apply(daemonA.daemonId, null)).be.false();

    should(index.quotaFor(daemonA.daemonId, session('claude'))?.fiveHourPercent).equal(12);
    should(index.feed(daemonA.daemonId)?.accounts).have.length(1);
  });

  it('clears only the daemon it is asked to clear', () => {
    const index = new DaemonUsageIndex();
    index.apply(daemonA.daemonId, feed([{ agent: 'claude', fiveHourPercent: 12 }]));
    index.apply(daemonB.daemonId, feed([{ agent: 'claude', fiveHourPercent: 97 }]));

    should(index.clearDaemon(daemonA.daemonId)).be.true();
    should(index.feed(daemonA.daemonId)).be.undefined();
    should(index.quotaFor(daemonA.daemonId, session('claude'))).be.null();

    // The other paired daemon is untouched, and clearing twice is a no-op.
    should(index.quotaFor(daemonB.daemonId, session('claude'))?.fiveHourPercent).equal(97);
    should(index.clearDaemon(daemonA.daemonId)).be.false();

    // A cleared daemon that pairs again starts from its own fresh feed, never
    // from what it had before.
    should(index.apply(daemonA.daemonId, feed([{ agent: 'claude', weeklyPercent: 3 }]))).be.true();
    should(index.quotaFor(daemonA.daemonId, session('claude'))).eql({
      fiveHourPercent: undefined,
      weeklyPercent: 3,
      fiveHourResetAt: undefined,
      weeklyResetAt: undefined,
      atLimit: undefined,
      authOk: undefined,
    } satisfies ResolvedQuota);
  });
});
