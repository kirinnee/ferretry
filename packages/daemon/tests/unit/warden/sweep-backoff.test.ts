import { describe, it } from 'bun:test';
import should from 'should';
import { enabled, harness, NOW, session } from './sweep-harness.ts';

/**
 * The sweep's spend after an investigation: the backoff ladder per (ferret, kind, subject), a LEAVE that
 * sticks to its subject, and leftover browsers closed by rule with no investigation at all.
 */

const MINUTE = 60_000;

const clock = (): { now: () => number; advance: (minutes: number) => void } => {
  let now = NOW;
  return {
    now: () => now,
    advance: minutes => {
      now += minutes * MINUTE;
    },
  };
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** A ferret whose one command has run 20 minutes with nothing moving — `sus_subprocess` as of `nowMs`. */
const stuck = (nowMs: number, command = 'pid:40', turn = 4) =>
  session({
    id: 's1',
    status: 'running',
    state: {
      turn,
      turnState: 'working',
      startedAt: iso(nowMs - 86_400_000),
      lastSubprocessAt: iso(nowMs - 5_000),
      subprocessSince: iso(nowMs - 20 * MINUTE),
      subprocessKey: command,
    },
  });

/** Every report the harness is asked for says the same thing. */
const reportsSaying = (verdict: 'LEAVE' | 'NUDGE') =>
  new Proxy(
    {},
    {
      get: () =>
        `Verdict: ${verdict}\n\n# Warden report — s1\n\n- **Anomaly kind:** sus_subprocess\n\n## Summary\n- **Recommended action:** ${verdict} — checked\n`,
    },
  ) as Record<string, string>;

/** Sweep every ten minutes for `hours`, the fleet re-measured each time; the minutes each spawn happened. */
async function sweepFor(
  hours: number,
  verdict: 'LEAVE' | 'NUDGE',
  fleetAt: (nowMs: number) => ReturnType<typeof stuck> = stuck,
): Promise<{ readonly spawnedAt: readonly number[]; readonly subject: ReturnType<typeof harness> }> {
  const time = clock();
  const subject = harness({
    config: enabled({ caps: { ...enabled().caps, investigationUsdPerDay: 100 } }),
    fleet: [fleetAt(time.now())],
    now: time.now,
    reports: reportsSaying(verdict),
  });
  const spawnedAt: number[] = [];
  for (let minute = 0; minute <= hours * 60; minute += 10) {
    subject.setFleet([fleetAt(time.now())]);
    const before = subject.spawns.length;
    await subject.service.run({ force: false });
    if (subject.spawns.length > before) spawnedAt.push(minute);
    time.advance(10);
  }
  return { spawnedAt, subject };
}

describe('the investigation backoff', () => {
  it('should look again at an unchanged stuck command after 30m, then 2h, then 8h, then a day', async () => {
    // Act
    const { spawnedAt } = await sweepFor(36, 'NUDGE');

    // Assert — each gap is the rung plus the ten minutes the investigation took to be read back.
    const gaps = spawnedAt.slice(1).map((minute, index) => minute - (spawnedAt[index] ?? 0));
    should(gaps).deepEqual([40, 130, 490, 1_450]);
  });

  it('should leave a stuck command a LEAVE cleared alone until the subject changes', async () => {
    // Act
    const { spawnedAt, subject } = await sweepFor(23, 'LEAVE');

    // Assert
    should(spawnedAt).deepEqual([0]);
    should(subject.state().backoff?.['s1|sus_subprocess']).match({ subject: 'cmd:pid:40', cleared: true });
  });

  it('should look at once when a different command is the stuck one', async () => {
    // Arrange — the first command is cleared; an hour later another one is stuck.
    const { spawnedAt } = await sweepFor(3, 'LEAVE', nowMs =>
      stuck(nowMs, nowMs - NOW >= 60 * MINUTE ? 'pid:41' : 'pid:40'),
    );

    // Assert
    should(spawnedAt).deepEqual([0, 60]);
  });

  it('should keep a cleared command cleared across turns while that same process runs', async () => {
    // Act — a new turn every hour, the same long-lived command (one pid) the whole time.
    const { spawnedAt } = await sweepFor(6, 'LEAVE', nowMs =>
      stuck(nowMs, 'pid:40', 4 + Math.floor((nowMs - NOW) / (60 * MINUTE))),
    );

    // Assert
    should(spawnedAt).deepEqual([0]);
  });

  it('should spend nothing on a ferret that is waiting on its owner', async () => {
    // Act
    const { spawnedAt, subject } = await sweepFor(6, 'NUDGE', nowMs =>
      session({
        id: 's1',
        status: 'running',
        state: { ...stuck(nowMs).state, turnState: 'needs-input' },
      }),
    );

    // Assert
    should(spawnedAt).deepEqual([]);
    should(subject.state().lastAnomalies ?? []).deepEqual([]);
  });
});

describe('leftover browsers', () => {
  const finished = (overrides: { readonly since?: number } = {}) =>
    ({
      ...session({ id: 's1', status: 'running', state: { turnState: 'your-turn' } }),
      leftoverBrowserSince: iso(NOW - (overrides.since ?? 30) * MINUTE),
    }) as const;

  it('should close a finished ferret’s leftover browser by rule, and list it', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [finished()] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).deepEqual([{ action: 'close_leftover', sessionId: 's1', detail: '' }]);
    should(subject.spawns).have.length(0);
    should(subject.state().actions?.[0]).match({ action: 'close_leftover', outcome: 'done', by: 'warden' });
    should(subject.journal.map(entry => entry.type)).containEql('fleet.warden_leftover_closed');
  });

  it('should only recommend it, once, when the owner has not let the Warden close leftovers alone', async () => {
    // Arrange
    const config = enabled({ mayActAlone: { ...enabled().mayActAlone, closeLeftovers: false } });
    const subject = harness({ config, fleet: [finished()] });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.remedies).deepEqual([]);
    should(subject.state().actions?.filter(action => action.action === 'close_leftover')).have.length(1);
    should(subject.state().actions?.[0]).match({ outcome: 'held' });
  });

  it('should say once that a close did not take', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [finished()], remedyFails: 'close_leftover' });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().actions?.filter(action => action.action === 'close_leftover')).have.length(1);
    should(subject.state().actions?.[0]?.detail).equal(
      'Closing its leftover browser did not take: close_leftover refused.',
    );
  });

  it('should do nothing while the Warden is off, or before the browser outlived its grace', async () => {
    // Arrange
    const off = harness({ config: { ...enabled(), enabled: false }, fleet: [finished()] });
    const young = harness({ config: enabled(), fleet: [finished({ since: 2 })] });

    // Act
    await off.service.run({ force: false });
    await young.service.run({ force: false });

    // Assert
    should(off.remedies).deepEqual([]);
    should(young.remedies).deepEqual([]);
  });
});
