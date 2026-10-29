import { describe, it } from 'bun:test';
import should from 'should';
import {
  STALLED_MONITOR_FLEET_KEY,
  collapseUnwatchedFleet,
  UNSUPERVISED_FLEET_KEY,
} from '../../../src/lib/warden/index.ts';
import { enabled, harness, JEV_INVESTIGATE, journalTypes, session, triageable } from './sweep-harness.ts';

/**
 * A replay of the flag shapes that burnt both Warden caps on 2026-10-29 (EC2): fifteen `dead_monitor`
 * flags in one sweep while the host was starved, asked of Jev one by one and twice; brand-new ferrets
 * flagged before the monitor had looked at them; and a burst of Jev calls that spent the day by 11:00.
 */

/** The fleet at 06:01:37 that day: fifteen working ferrets, none of them looked at recently. */
const starvedFleet = Array.from({ length: 15 }, (_, index) =>
  session({ id: `mvt${index.toString().padStart(2, '0')}`, status: 'running', hasLiveMonitor: false }),
);

const jevAndLlm = (llm: boolean) => enabled({ layers: { jev: true, llm } });

describe('the Warden on 2026-10-29, replayed', () => {
  it('should report a stalled monitor as ONE daemon fault and ask Jev nothing', async () => {
    // Arrange
    const subject = harness({
      config: jevAndLlm(false),
      fleet: starvedFleet,
      guard: [JEV_INVESTIGATE],
      monitorStalled: () => true,
    });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(status.anomalies).have.length(1);
    should(status.anomalies[0]).match({ kind: 'dead_monitor', fleetKey: STALLED_MONITOR_FLEET_KEY });
    should(status.anomalies[0]?.affectedSessionIds).have.length(15);
    should(subject.guarded).be.empty();
    should(status.savings.flags).equal(1);
  });

  it('should hand a ferret’s own dead_monitor on unasked, and say so once rather than every sweep', async () => {
    // Arrange — a monitor that is fine, and two ferrets it really cannot see.
    const subject = harness({
      config: jevAndLlm(false),
      fleet: starvedFleet.slice(0, 2),
      guard: [JEV_INVESTIGATE],
      monitorStalled: () => false,
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(status.anomalies.map(anomaly => anomaly.kind)).deepEqual(['dead_monitor', 'dead_monitor']);
    should(subject.guarded).be.empty();
    should(journalTypes(subject).filter(type => type === 'fleet.warden_jev_handed_on')).have.length(2);
    should(subject.journal.find(entry => entry.type === 'fleet.warden_jev_handed_on')?.data).match({
      why: 'not_judgeable',
    });
    should(status.savings.jevDecisions).equal(0);
    should(status.spend.jevUsd).equal(0);
  });

  it('should spend at most a quarter of Jev’s day in one hour, and hand the rest on unasked', async () => {
    // Arrange — thirty flags Jev would each be unsure about, at $0.005 a call against a $0.50 day.
    const fleet = Array.from({ length: 30 }, (_, index) => triageable(`q${index}`));
    const subject = harness({
      config: { ...jevAndLlm(false), caps: { ...jevAndLlm(false).caps, jevUsdPerDay: 0.5 } },
      fleet,
      guard: [{ ...JEV_INVESTIGATE, costUsd: 0.005 }],
    });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert — $0.125 this hour: 25 calls, and Jev is off until 13:00 UTC rather than midnight.
    should(subject.guarded).have.length(25);
    should(status.spend.jevUsd).be.approximately(0.125, 1e-9);
    should(status.spend.capsPaced).deepEqual(['jev']);
    should(status.spend.pacedUntil).equal('2026-07-31T13:00:00.000Z');
    should(status.triage.jev).match({ active: false, reason: 'jev_cap' });
  });
});

describe('collapsing an unwatched fleet', () => {
  const dead = (sessionId: string) => ({
    kind: 'dead_monitor' as const,
    sessionId,
    status: 'running' as const,
    detail: 'no live monitor',
  });

  it('should leave per-ferret flags alone while the monitor is fine', () => {
    // Act / Assert
    should(collapseUnwatchedFleet([dead('a'), dead('b')], undefined)).have.length(2);
  });

  it('should name the stalled monitor, not a missing subsystem, when it has stopped seeing', () => {
    // Act
    const [stalled] = collapseUnwatchedFleet([dead('b'), dead('a')], 'stalled');
    const [unsupervised] = collapseUnwatchedFleet([dead('a')], 'unsupervised');

    // Assert
    should(stalled).match({ fleetKey: STALLED_MONITOR_FLEET_KEY, sessionId: 'a', affectedSessionIds: ['a', 'b'] });
    should(stalled?.detail).containEql('liveness monitor has seen no ferret');
    should(unsupervised?.fleetKey).equal(UNSUPERVISED_FLEET_KEY);
  });
});
