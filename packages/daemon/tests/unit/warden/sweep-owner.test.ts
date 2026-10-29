import { describe, it } from 'bun:test';
import should from 'should';
import { jevHandoffKey } from '../../../src/lib/warden/index.ts';
import {
  at,
  enabled,
  escalated,
  harness,
  JEV_INVESTIGATE,
  JEV_SKIP,
  journalTypes,
  session,
  triageable,
} from './sweep-harness.ts';

/**
 * The Warden needing the owner, end to end through a sweep: the notification it sends, the one it clears,
 * and the old escalation items it retires.
 */

const jevOnly = (overrides: Parameters<typeof enabled>[0] = {}) =>
  enabled({ layers: { jev: true, llm: false }, ...overrides });

describe('a sweep raises the owner’s card', () => {
  it('should raise ONE card for a flag Jev handed on with no investigation to follow, and remember why', async () => {
    // Arrange
    const subject = harness({
      config: jevOnly(),
      fleet: [triageable('s1')],
      guard: [{ ...JEV_INVESTIGATE, confidence: 0.42, reason: 'its reset passed but it never resumed' }],
      settings: { machineName: () => 'kirin-box' },
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().jevHandoffs?.[jevHandoffKey('s1', 'quota_reset_passed')]).match({
      at: at(0),
      status: 'rate_limited',
      why: 'unsure',
      confidence: 0.42,
      reason: 'its reset passed but it never resumed',
    });
    should(subject.board('s1')).deepEqual([escalated('quota_reset_passed')]);
    should(subject.raises[0]?.request).match({
      reason: 'jev',
      notice: true,
      ping: true,
      title: 's1 can resume now',
      why: 'Jev looked and was not sure what to do (42% sure).',
    });
    should(subject.state().notified).deepEqual({ 's1|warden:ask:quota_reset_passed': at(0) });
    should(subject.raises[0]?.request.premise).containEql('on kirin-box');
    should(journalTypes(subject).filter(type => type === 'fleet.warden_escalated')).have.length(1);
    should(subject.journal.find(entry => entry.type === 'fleet.warden_escalated')?.data).match({
      reason: 'jev',
      change: 'created',
    });
  });

  it('should say Jev does not judge a ferret it cannot see, rather than that nothing could look', async () => {
    // Arrange: a working ferret the liveness monitor has not looked at is a `dead_monitor`, which Jev never judges.
    const subject = harness({ config: jevOnly(), fleet: [session({ id: 's1', hasLiveMonitor: false })] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.guarded).be.empty();
    should(subject.state().jevHandoffs?.[jevHandoffKey('s1', 'dead_monitor')]).match({
      why: 'not_judgeable',
      confidence: 0,
    });
    should(subject.raises[0]?.request).match({ reason: 'jev', why: 'Jev does not judge this kind of flag.' });
  });

  it('should raise nothing while investigations can follow', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ layers: { jev: true, llm: true } }),
      fleet: [triageable('s1')],
      guard: [JEV_INVESTIGATE],
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.raises).be.empty();
  });

  it('should raise nothing while the Warden is off, and clear what it raised before', async () => {
    // Arrange
    const subject = harness({ config: enabled({ enabled: false }), fleet: [triageable('s1')] });
    subject.seedBoard('s1', [escalated('quota_reset_passed')]);

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.raises).be.empty();
    should(subject.resolved).match([{ sessionId: 's1', sourceRef: 'warden:ask:quota_reset_passed' }]);
  });

  it('should clear the card once Jev, asked afresh, is sure the ferret is fine', async () => {
    // Arrange
    const subject = harness({ config: jevOnly(), fleet: [triageable('s1')], guard: [JEV_INVESTIGATE, JEV_SKIP] });
    await subject.service.run({ force: false });
    subject.setState({ ...subject.state(), passedOn: [] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.board('s1')).deepEqual([]);
    should(subject.resolved[0]?.note).match(/no longer waits on you/u);
  });

  it('should raise ONE card for a daemon that watches no ferret, however many it has', async () => {
    // Arrange
    const fleet = Array.from({ length: 15 }, (_, index) => session({ id: `s${index + 1}`, hasLiveMonitor: false }));
    const subject = harness({
      config: enabled({ layers: { jev: false, llm: false } }),
      fleet,
      settings: { supervisesMonitors: false },
    });

    // Act
    await subject.service.run({ force: false });
    await subject.service.run({ force: false });

    // Assert
    const refs = subject.raises.map(entry => `${entry.sessionId}|${entry.request.sourceRef}`);
    should(new Set(refs)).deepEqual(new Set(['s1|warden:ask:fleet:dead_monitor:daemon:no-monitor-subsystem']));
    should(subject.raises[0]?.request).match({ notice: true, title: '15 ferrets are not being watched' });
  });

  it('should write a card even when the machine has no name', async () => {
    // Arrange
    const subject = harness({
      config: jevOnly(),
      fleet: [triageable('s1')],
      guard: [JEV_INVESTIGATE],
      settings: { machineName: () => '' },
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.raises[0]?.request.premise).not.containEql(' on ');
  });
});

describe('the items escalations wrote before notifications', () => {
  it('should resolve an old Warden item with a note on the first sweep, and notify instead', async () => {
    // Arrange
    const subject = harness({ config: jevOnly(), fleet: [triageable('s1')], guard: [JEV_INVESTIGATE] });
    subject.seedBoard('s1', [{ source: 'agent-raised', sourceRef: 'warden:quota_reset_passed', raisedBy: 'daemon' }]);

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.resolved).match([
      { sessionId: 's1', sourceRef: 'warden:quota_reset_passed', note: /notification from "Warden"/u },
    ]);
    should(subject.board('s1')).deepEqual([escalated('quota_reset_passed')]);
  });
});
