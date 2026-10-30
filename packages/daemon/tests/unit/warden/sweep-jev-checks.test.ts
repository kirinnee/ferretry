import { describe, it } from 'bun:test';
import should from 'should';
import { NUDGE_MESSAGES, TRIAGE_CRITERIA, type TriageDecision } from '../../../src/lib/speedups/jev.ts';
import {
  at,
  enabled,
  harness,
  JEV_INVESTIGATE,
  JEV_SKIP,
  journalTypes,
  NOW,
  session,
  unattended,
} from './sweep-harness.ts';

/**
 * Every flag Jev is put to leaves a record and is counted into its day — whatever Jev made of it. On
 * 2026-10-29 Jev answered 102 flags, handed every one on, and the Warden page said it did nothing.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A ferret whose one command has run 20 minutes with nothing moving: Jev may nudge, restart or stop it. */
const stuck = () =>
  session({
    id: 's1',
    status: 'running',
    state: {
      turn: 4,
      turnState: 'working',
      startedAt: iso(NOW - 86_400_000),
      lastSubprocessAt: iso(NOW - 5_000),
      subprocessSince: iso(NOW - 20 * MINUTE),
      subprocessKey: 'pid:40',
    },
  });

const nudge = (confidence: number): TriageDecision => ({
  ...JEV_SKIP,
  verdict: 'nudge',
  confidence,
  reason: TRIAGE_CRITERIA.nudge,
  nudge: { id: 'stuck_command', message: NUDGE_MESSAGES.stuck_command, confidence },
});

const layers = (llm: boolean, caps: Partial<ReturnType<typeof enabled>['caps']> = {}) =>
  enabled({ layers: { jev: true, llm }, caps: { ...enabled().caps, ...caps } });

/** Today's entry in the day rollup. */
const today = (subject: ReturnType<typeof harness>) =>
  subject.state().daily?.find(day => day.day === iso(NOW).slice(0, 10));

describe('Jev’s checks', () => {
  it('should record a flag Jev was not sure of and handed to an investigation, and count it as a check', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(subject.jevChecks).deepEqual([
      {
        at: at(0),
        sessionId: 's1',
        anomalyKind: 'unattended_question',
        verdict: 'handed_on',
        why: 'unsure',
        route: 'investigation',
        confidence: 0.9,
        costUsd: 0.001,
      },
    ]);
    should(today(subject)?.jev).deepEqual({ checks: 1, healthy: 0, acted: 0, handedOn: 1, skippedForCap: 0 });
    should(status.jevChecks).deepEqual(subject.jevChecks);
    should(status.history?.at(-1)?.jev).match({ checks: 1, handedOn: 1 });
  });

  it('should send a hand-on to the owner when investigations are off', async () => {
    // Arrange
    const subject = harness({ config: layers(false), fleet: [unattended('s1')], guard: [JEV_INVESTIGATE] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.jevChecks[0]).match({ verdict: 'handed_on', why: 'unsure', route: 'owner' });
  });

  it('should record a flag Jev was sure is healthy', async () => {
    // Arrange
    const subject = harness({ config: layers(true), fleet: [unattended('s1')] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.jevChecks).match([{ verdict: 'healthy', confidence: 0.96, costUsd: 0.001 }]);
    should(subject.jevChecks[0]).not.have.property('why');
    should(today(subject)?.jev).deepEqual({ checks: 1, healthy: 1, acted: 0, handedOn: 0, skippedForCap: 0 });
  });

  it('should record an act Jev carried out, and one that did not take as handed on', async () => {
    // Arrange
    const acted = harness({ config: layers(true), fleet: [stuck()], guard: [nudge(0.93)] });
    const refused = harness({ config: layers(true), fleet: [stuck()], guard: [nudge(0.93)], remedyFails: 'nudge' });

    // Act
    await acted.service.run({ force: false });
    await refused.service.run({ force: false });

    // Assert
    should(acted.jevChecks).match([{ verdict: 'acted', act: 'nudge', anomalyKind: 'sus_subprocess' }]);
    should(today(acted)?.jev).match({ checks: 1, acted: 1 });
    should(refused.jevChecks).match([
      { verdict: 'handed_on', act: 'nudge', why: 'act_failed', route: 'investigation' },
    ]);
    should(today(refused)?.jev).match({ checks: 1, handedOn: 1 });
  });

  it('should keep the act Jev recommended when the owner keeps that act for themselves', async () => {
    // Arrange
    const subject = harness({
      config: layers(false),
      fleet: [stuck()],
      guard: [{ ...JEV_SKIP, verdict: 'stop', confidence: 0.99, reason: TRIAGE_CRITERIA.stop }],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.jevChecks).match([{ verdict: 'handed_on', act: 'stop', route: 'owner', confidence: 0.99 }]);
  });

  it('should record a call that failed, which cost a check, but nothing when no call was made', async () => {
    // Arrange
    const failed = harness({ config: layers(true), fleet: [unattended('s1')], guard: [new Error('socket hang up')] });
    const backingOff = harness({
      config: layers(true),
      fleet: [unattended('s1')],
      state: { guard: { backoffUntil: at(5) } },
    });

    // Act
    await failed.service.run({ force: false });
    await backingOff.service.run({ force: false });

    // Assert
    should(failed.jevChecks).match([{ verdict: 'handed_on', why: 'failed', confidence: 0, costUsd: 0 }]);
    should(backingOff.jevChecks).deepEqual([]);
  });

  it('should note a flag skipped for the spent cap once while it stands, not every sweep', async () => {
    // Arrange: the first answer spends the day's cap; the second flag is handed on unasked.
    const subject = harness({
      config: layers(true, { jevUsdPerDay: 0.01 }),
      fleet: [unattended('s1'), unattended('s2')],
      guard: [{ ...JEV_INVESTIGATE, costUsd: 0.02 }],
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.jevChecks.map(check => [check.sessionId, check.verdict, check.why])).deepEqual([
      ['s1', 'handed_on', 'unsure'],
      ['s2', 'skipped', 'jev_cap'],
    ]);
    should(subject.jevChecks[1]).match({ route: 'investigation', confidence: 0, costUsd: 0 });
    should(today(subject)?.jev).deepEqual({ checks: 1, healthy: 0, acted: 0, handedOn: 1, skippedForCap: 1 });
  });

  it('should say a skip was for this hour’s share of the cap when the day still has room', async () => {
    // Arrange: a quarter of a $1 day is spent within this hour.
    const subject = harness({
      config: layers(false, { jevUsdPerDay: 1 }),
      fleet: [unattended('s1')],
      state: {
        triageDay: {
          day: iso(NOW).slice(0, 10),
          flags: 0,
          jevDecisions: 0,
          jevSkips: 0,
          jevUsd: 0.3,
          jevHour: iso(NOW).slice(0, 13),
          jevHourUsd: 0.3,
        },
      },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.jevChecks).match([{ verdict: 'skipped', why: 'jev_paced', route: 'owner' }]);
  });

  it('should note the same flag again once it went away and came back', async () => {
    // Arrange
    const subject = harness({
      config: layers(false, { jevUsdPerDay: 0.01 }),
      fleet: [unattended('s1')],
      state: {
        triageDay: { day: iso(NOW).slice(0, 10), flags: 0, jevDecisions: 0, jevSkips: 0, jevUsd: 0.02 },
      },
    });
    await subject.service.run({ force: false });

    // Act
    subject.setFleet([]);
    await subject.service.run({ force: false });
    subject.setFleet([unattended('s1')]);
    await subject.service.run({ force: false });

    // Assert
    should(subject.jevChecks.map(check => check.why)).deepEqual(['jev_cap', 'jev_cap']);
    should(subject.state().jevCapSkips).have.length(1);
  });

  it('should keep the sweep going and say so in the journal when a check cannot be written', async () => {
    // Arrange
    const subject = harness({
      config: layers(true),
      fleet: [unattended('s1')],
      guard: [JEV_INVESTIGATE],
      jevChecksFail: 'append',
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).have.length(1);
    should(journalTypes(subject)).containEql('fleet.warden_jev_check_unwritten');
    should(subject.journal.find(entry => entry.type === 'fleet.warden_jev_check_unwritten')?.data).deepEqual({
      sessionId: 's1',
      kind: 'unattended_question',
      error: 'disk full',
    });
    should(today(subject)?.jev).match({ checks: 1, handedOn: 1 });
  });

  it('should leave the checks out of the status, unknown rather than none, when the record cannot be read', async () => {
    // Arrange
    const subject = harness({ config: layers(true), jevChecksFail: 'recent' });

    // Act
    const status = await subject.service.status();

    // Assert
    should(status).not.have.property('jevChecks');
  });
});
