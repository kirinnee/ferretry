import { describe, it } from 'bun:test';
import should from 'should';
import type { ExchangeSend, WardenExchangeReader, WardenFleetSession } from '../../daemon/lib/index.ts';
import { enabled, harness, journalTypes, NOW, session } from './sweep-harness.ts';

/**
 * A sub-ferret that never answered its lead, end to end through the real sweep: nudged once, then its lead
 * told once, never put to Jev or an investigation. The shape of 2026-10-31, when a review sub-ferret's turn
 * was cut off by a provider safety block and its lead waited five hours for the verdict.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const lead = session({ id: 'lead', state: { turnState: 'working' } });
const reviewer = (over: Partial<WardenFleetSession['state']> = {}): WardenFleetSession => {
  const base = session({
    id: 'reviewer',
    state: { turnState: 'your-turn', turnStateAt: iso(NOW - 30 * MINUTE), ...over },
  });
  return { ...base, config: { ...base.config, parent: 'lead', teammate: 'rebecca' } };
};
const leadWithName: WardenFleetSession = { ...lead, config: { ...lead.config, teammate: 'lizzette' } };

/** The two ledgers: what the reviewer was sent, and what the lead was sent. */
const ledgers = (sends: Readonly<Record<string, readonly ExchangeSend[]>>): WardenExchangeReader => ({
  sends: async sessionId => sends[sessionId] ?? [],
});
const asked: ExchangeSend = { from: 'lead', acceptedAt: iso(NOW - 31 * MINUTE), fate: 'delivered', turn: 4 };
const earlierAnswer: ExchangeSend = { from: 'reviewer', acceptedAt: iso(NOW - 99 * MINUTE), fate: 'delivered' };

describe('a sub-ferret that has not answered its parent', () => {
  it('should be nudged once, then its parent told once after the nudge had its time', async () => {
    // Arrange
    let now = NOW;
    const exchanges = ledgers({ reviewer: [asked], lead: [earlierAnswer] });
    const fleet = [leadWithName, reviewer()];
    const subject = harness({ config: enabled(), fleet, exchanges, now: () => now });

    // Act — the nudge; a sweep while its turn would still be young; the parent told; nothing more.
    const first = await subject.service.run({ force: false });
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });
    now = NOW + 25 * MINUTE;
    await subject.service.run({ force: false });
    now = NOW + 50 * MINUTE;
    await subject.service.run({ force: false });

    // Assert
    should(first.anomalies.map(anomaly => [anomaly.kind, anomaly.sessionId])).eql([['report_overdue', 'reviewer']]);
    should(subject.remedies.map(remedy => [remedy.action, remedy.sessionId])).eql([
      ['nudge', 'reviewer'],
      ['nudge', 'lead'],
    ]);
    should(subject.remedies[0]?.detail).containEql('without answering :lizzette');
    should(subject.remedies[1]?.detail).containEql(':rebecca has not answered your last message');
    should(subject.state().overdue).eql({
      reviewer: { asked: asked.acceptedAt, nudgedAt: iso(NOW), toldParentAt: iso(NOW + 25 * MINUTE) },
    });
    should(journalTypes(subject).filter(type => type === 'fleet.warden_overdue_told')).have.length(2);
  });

  it('should never be put to Jev or an investigation, nor hold the ferrets’ fingerprint', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ layers: { jev: true, llm: true } }),
      fleet: [leadWithName, reviewer()],
      exchanges: ledgers({ reviewer: [asked] }),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.spawns).be.empty();
    should(subject.guarded).be.empty();
    should(subject.raises).be.empty();
    should(subject.state().lastFingerprint).equal('');
  });

  it('should tell the parent at once about a sub-ferret on a spent login, and nobody about one that answered', async () => {
    // Arrange
    const limited = harness({
      config: enabled(),
      fleet: [leadWithName, reviewer({ status: 'rate_limited' })],
      exchanges: ledgers({ reviewer: [asked] }),
    });
    const answered = harness({
      config: enabled(),
      fleet: [leadWithName, reviewer()],
      exchanges: ledgers({
        reviewer: [asked],
        lead: [{ from: 'reviewer', acceptedAt: iso(NOW - 30 * MINUTE), fate: 'delivered' }],
      }),
    });

    // Act
    await limited.service.run({ force: false });
    const quiet = await answered.service.run({ force: false });

    // Assert
    should(limited.remedies.map(remedy => [remedy.action, remedy.sessionId])).eql([['nudge', 'lead']]);
    should(limited.remedies[0]?.detail).containEql('usage limit');
    should(quiet.anomalies).be.empty();
    should(answered.remedies).be.empty();
  });

  it('should try a refused nudge once and its parent once, then stop, instead of retrying on every sweep', async () => {
    // Arrange: every typed message is refused (Conversation's send refuses on 5.0 until its terminal seam lands)
    let now = NOW;
    const subject = harness({
      config: enabled(),
      fleet: [leadWithName, reviewer()],
      exchanges: ledgers({ reviewer: [asked] }),
      remedyFails: 'nudge',
      now: () => now,
    });

    // Act — the nudge refused; the parent tried at once and refused; then four more sweeps, which try nothing
    for (const minutes of [0, 1, 2, 30, 90]) {
      now = NOW + minutes * MINUTE;
      await subject.service.run({ force: false });
    }

    // Assert
    const failed = subject.journal.filter(entry => entry.type === 'fleet.warden_overdue_failed');
    should(failed.map(entry => entry.data)).eql([
      { sessionId: 'reviewer', via: 'nudge', to: 'reviewer' },
      { sessionId: 'reviewer', via: 'parent', to: 'lead' },
    ]);
    should(subject.state().overdue).eql({
      reviewer: { asked: asked.acceptedAt, nudgeFailedAt: iso(NOW), parentFailedAt: iso(NOW + 1 * MINUTE) },
    });
    should(journalTypes(subject)).not.containEql('fleet.warden_overdue_told');
  });

  it('should try again for the next unanswered message (a new episode)', async () => {
    // Arrange
    let now = NOW;
    let sends: readonly ExchangeSend[] = [asked];
    const subject = harness({
      config: enabled(),
      fleet: [leadWithName, reviewer()],
      exchanges: { sends: async id => (id === 'reviewer' ? sends : []) },
      remedyFails: 'nudge',
      now: () => now,
    });
    for (const minutes of [0, 1, 2]) {
      now = NOW + minutes * MINUTE;
      await subject.service.run({ force: false });
    }

    // Act — the lead asks again and the turn has been over long enough
    now = NOW + 60 * MINUTE;
    sends = [{ ...asked, acceptedAt: iso(NOW + 5 * MINUTE) }];
    await subject.service.run({ force: false });

    // Assert
    should(subject.journal.filter(entry => entry.type === 'fleet.warden_overdue_failed')).have.length(3);
  });

  it('should flag nobody whose ledgers could not be read', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [leadWithName, reviewer()],
      exchanges: { sends: async () => await Promise.reject(new Error('unreadable')) },
    });

    // Act
    const run = await subject.service.run({ force: false });

    // Assert
    should(run.anomalies).be.empty();
    should(subject.remedies).be.empty();
  });

  it('should be flagged but tell nobody while the Warden is off', async () => {
    // Arrange
    const subject = harness({
      config: enabled({ enabled: false }),
      fleet: [leadWithName, reviewer()],
      exchanges: ledgers({ reviewer: [asked] }),
    });

    // Act
    const run = await subject.service.run({ force: false });

    // Assert
    should(run.anomalies.map(anomaly => anomaly.kind)).eql(['report_overdue']);
    should(subject.remedies).be.empty();
  });
});
