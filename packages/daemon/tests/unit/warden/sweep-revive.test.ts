import { describe, it } from 'bun:test';
import should from 'should';
import { type ReviveEvent, WardenReviveService } from '../../../src/lib/warden/index.ts';
import { enabled, harness, NOW, session } from './sweep-harness.ts';

const gone: ReviveEvent = {
  type: 'session.exited',
  time: new Date(NOW - 60_000).toISOString(),
  data: { status: 'failed', pane: 'gone', exitCode: null },
};

const died = () => session({ id: 's1', status: 'failed', state: { finishedAt: new Date(NOW - 60_000).toISOString() } });

const service = (read: () => Promise<readonly ReviveEvent[]>, resumed: string[] = []) =>
  new WardenReviveService({
    events: { read, emit: async () => {} },
    resume: async id => {
      resumed.push(id);
      return { ok: true };
    },
    tmuxReady: async () => true,
    sleep: async () => {},
    notifyOwner: async () => {},
    journal: { record: () => {} },
  });

describe('auto-revive in the sweep', () => {
  it('should revive what died, write it down under Recent actions and remember the cooldown', async () => {
    // Arrange
    const resumed: string[] = [];
    const subject = harness({
      config: enabled(),
      fleet: [died()],
      revive: service(async () => [gone], resumed),
    });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(resumed).deepEqual(['s1']);
    should(subject.state().actions?.[0]).match({ action: 'revive', outcome: 'done', by: 'warden', sessionId: 's1' });
    should(subject.state().revive?.sessions.s1?.attempts).equal(1);
    should(subject.state().lastAnomalies?.map(anomaly => anomaly.sessionId) ?? []).not.containEql('s1');
  });

  it('should count the revive by who decided it, show it in the status totals and watch whether it took', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [died()], revive: service(async () => [gone]) });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(status.actionTotals?.find(entry => entry.action === 'revive' && entry.outcome === 'done')).containEql({
      auto: 1,
      jev: 0,
      llm: 0,
    });
    should(subject.state().reviveWatch?.map(watch => [watch.sessionId, watch.actor])).deepEqual([['s1', 'auto']]);
    should(status.reviveTotals).deepEqual({
      progressed: { auto: 0, jev: 0, llm: 0 },
      stalled: { auto: 0, jev: 0, llm: 0 },
    });
  });

  it('should revive nothing when no revive service is wired', async () => {
    // Arrange
    const subject = harness({ config: enabled(), fleet: [died()] });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(subject.state().revive).be.undefined();
  });

  it('should say a revive that threw failed, and still finish the sweep', async () => {
    // Arrange
    const subject = harness({
      config: enabled(),
      fleet: [died()],
      revive: service(async () => {
        throw new Error('journal unreadable');
      }),
    });

    // Act
    const view = await subject.service.run({ force: false });

    // Assert
    should(view.sweptAt).be.a.String();
    should(subject.journal.find(entry => entry.type === 'fleet.warden_revive_failed')?.data).deepEqual({
      message: 'journal unreadable',
    });
  });
});
