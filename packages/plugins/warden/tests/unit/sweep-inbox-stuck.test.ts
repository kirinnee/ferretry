import { describe, it } from 'bun:test';
import type { QueuedMessage } from '../../daemon/lib/protocol.ts';
import should from 'should';
import type { StuckInboxNotice } from '../../daemon/lib/inbox-stuck-list.ts';
import type { InboxSend, WardenFleetSession, WardenStuckInboxPort } from '../../daemon/lib/index.ts';
import { enabled, harness, journalTypes, NOW, session } from './sweep-harness.ts';

/**
 * A ferret whose messages wait in Ferretry's queue far past due, end to end through the real sweep: the safe
 * re-check once, then — when that did not move it — named on the machine notice and handed to an investigation
 * whose verdict can only re-check again; taken off on recovery. Never put to Jev, never in the fingerprint.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const ryu = (over: Partial<WardenFleetSession['state']> = {}): WardenFleetSession => {
  const base = session({
    id: 'ryu',
    state: { turnState: 'your-turn', turnStateAt: iso(NOW - MINUTE), ...over },
  });
  return { ...base, config: { ...base.config, teammate: 'ryu' } };
};

const message = (id: string, agoMin: number, over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id,
  sender: 'agent',
  from: 'mvyuf0a3-d78ece66',
  fromName: 'maryjane',
  text: `message ${id}`,
  attachmentIds: [],
  enqueuedAt: iso(NOW - agoMin * MINUTE),
  state: 'queued',
  stateAt: iso(NOW - agoMin * MINUTE),
  revision: 1,
  ...over,
});

/** ryu at 11-02 08:12, half an hour on: one message handed over and never typed, two behind it. */
const hung = (): readonly QueuedMessage[] => [
  message('8e8d7aaf', 30, { state: 'typing' }),
  message('622a6e69', 28),
  message('9d86f78a', 25, { fromName: 'sarina' }),
];

class FakeStuckInbox implements WardenStuckInboxPort {
  readonly acts: string[] = [];
  readonly notices = new Map<string, StuckInboxNotice>();
  queues: Record<string, readonly QueuedMessage[]> = { ryu: hung() };
  ledgers: Record<string, readonly InboxSend[]> = {
    ryu: [{ sendId: '8e8d7aaf', path: 'turn-file', fate: 'accepted' }],
  };
  draft: 'clear' | 'foreign' | 'stuck' = 'foreign';
  trackerFails = false;
  noticeFails = false;
  removeFails = false;
  /** When each queue was last written; NOW a minute ago unless a test says otherwise. */
  written: Record<string, number | undefined> = {};
  /** Which read throws this sweep, if any. */
  fails: 'written' | 'queue' | 'sends' | undefined;
  readCalls = 0;

  async queueWrittenAt(sessionId: string): Promise<number | undefined> {
    if (this.fails === 'written') throw new Error('EACCES');
    return sessionId in this.written ? this.written[sessionId] : NOW - MINUTE;
  }

  async queue(sessionId: string): Promise<readonly QueuedMessage[]> {
    this.readCalls += 1;
    if (this.fails === 'queue') throw new Error('EIO');
    return this.queues[sessionId] ?? [];
  }

  async sends(sessionId: string): Promise<readonly InboxSend[]> {
    if (this.fails === 'sends') throw new Error('EMFILE');
    return this.ledgers[sessionId] ?? [];
  }

  async trackerLook(sessionId: string): Promise<void> {
    this.acts.push(`tracker:${sessionId}`);
    if (this.trackerFails) throw new Error('ledger unreadable');
  }

  async finishOwnDraft(sessionId: string): Promise<'clear' | 'foreign' | 'stuck'> {
    this.acts.push(`draft:${sessionId}`);
    return this.draft;
  }

  async deliveryLook(sessionId: string): Promise<void> {
    this.acts.push(`delivery:${sessionId}`);
  }

  async add(notice: StuckInboxNotice): Promise<void> {
    if (this.noticeFails) throw new Error('agenda refused');
    this.notices.set(notice.sessionId, notice);
  }

  async remove(sessionId: string): Promise<void> {
    if (this.removeFails) throw new Error('agenda refused');
    this.notices.delete(sessionId);
  }
}

describe('a ferret whose inbox is stuck (B148)', () => {
  it('should re-check once, then name it on the notice and hand it to an investigation, and never ask Jev', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    const subject = harness({
      config: enabled({ layers: { jev: true, llm: true } }),
      fleet: [ryu()],
      stuckInbox,
      now: () => now,
    });

    const first = await subject.service.run({ force: false });

    // In its own field, never in `anomalies`, which an older app parses against a closed list of kinds.
    should(first.anomalies).be.empty();
    should(first.stuckInbox?.map(flag => [flag.kind, flag.sessionId])).eql([['inbox_stuck', 'ryu']]);
    should(first.stuckInbox?.[0]).not.have.properties(['messageId', 'cause', 'waiting']);
    should(stuckInbox.acts).eql(['tracker:ryu', 'delivery:ryu']);
    should(stuckInbox.notices.size).equal(0);
    should(subject.spawns).be.empty();
    should(subject.state().stuckInbox).eql({
      ryu: { messageId: '8e8d7aaf', cause: 'hung_handover', unstuckAt: iso(NOW) },
    });
    should(subject.journal.find(entry => entry.type === 'fleet.warden_inbox_rechecked')?.data).eql({
      sessionId: 'ryu',
      messageId: '8e8d7aaf',
      cause: 'hung_handover',
      by: 'sweep',
      outcomes: { tracker_look: 'done', delivery_look: 'done' },
    });

    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });

    should(stuckInbox.acts).eql(['tracker:ryu', 'delivery:ryu']);
    should(stuckInbox.notices.get('ryu')?.line).match(
      /^ryu \(ryu\): 3 messages waiting, oldest 35m past due .* \(send 8e8d7aaf\)/,
    );
    should(subject.state().stuckInbox?.ryu?.noticedAt).equal(iso(now));
    should(subject.spawns).have.length(1);
    should(subject.spawns[0]?.prompt).match(/Its inbox was flagged stuck by the fleet sweep/);
    should(subject.spawns[0]?.prompt).match(/Verdict: LEAVE\|NUDGE\|NEEDS_HUMAN/);
    should(subject.spawns[0]?.prompt).match(/Do NOT send, retry, cancel, resend or delete any message/);
    should(subject.spawns[0]?.prompt).not.match(/fy resume|fy stop/);
    should(subject.guarded).be.empty();
    should(subject.state().lastFingerprint).equal('');
    should(journalTypes(subject).filter(type => type === 'fleet.warden_inbox_noticed')).have.length(1);

    now = NOW + 10 * MINUTE;
    await subject.service.run({ force: false });
    should(journalTypes(subject).filter(type => type === 'fleet.warden_inbox_noticed')).have.length(1);
    should(stuckInbox.acts).have.length(2);
  });

  it('should take a ferret off the notice once its queue moves, and forget it', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    const subject = harness({ config: enabled(), fleet: [ryu()], stuckInbox, now: () => now });
    await subject.service.run({ force: false });
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });
    should(stuckInbox.notices.has('ryu')).be.true();

    stuckInbox.queues = { ryu: hung().map(each => ({ ...each, state: 'read' as const })) };
    now = NOW + 10 * MINUTE;
    const drained = await subject.service.run({ force: false });

    should(drained).not.have.property('stuckInbox');
    should(stuckInbox.notices.size).equal(0);
    should(subject.state().stuckInbox).be.undefined();
    should(journalTypes(subject)).containEql('fleet.warden_inbox_recovered');
  });

  it('should keep a drained ferret remembered while the notice will not let it go, and let it go once it does', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    const subject = harness({ config: enabled(), fleet: [ryu()], stuckInbox, now: () => now });
    await subject.service.run({ force: false });
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });

    stuckInbox.queues = { ryu: [] };
    stuckInbox.removeFails = true;
    now = NOW + 10 * MINUTE;
    await subject.service.run({ force: false });
    should(stuckInbox.notices.has('ryu')).be.true();
    should(subject.state().stuckInbox?.ryu?.noticedAt).equal(iso(NOW + 5 * MINUTE));
    should(journalTypes(subject)).not.containEql('fleet.warden_inbox_recovered');

    stuckInbox.removeFails = false;
    now = NOW + 15 * MINUTE;
    await subject.service.run({ force: false });
    should(stuckInbox.notices.size).equal(0);
    should(subject.state().stuckInbox).be.undefined();
  });

  it('should re-check an unattributed draft with the verified finish too, and carry on past an act that throws', async () => {
    const stuckInbox = new FakeStuckInbox();
    stuckInbox.trackerFails = true;
    stuckInbox.queues = {
      ryu: [message('m0', 300, { waitReason: 'draft' }), message('m1', 290, { waitReason: 'draft' })],
    };
    const subject = harness({ config: enabled(), fleet: [ryu({ status: 'running' })], stuckInbox });

    await subject.service.run({ force: false });

    should(stuckInbox.acts).eql(['tracker:ryu', 'draft:ryu', 'delivery:ryu']);
    should(subject.journal.find(entry => entry.type === 'fleet.warden_inbox_rechecked')?.data.outcomes).eql({
      tracker_look: 'failed',
      finish_own_draft: 'foreign',
      delivery_look: 'done',
    });
  });

  it('should show the flag and do nothing while the Warden is off', async () => {
    const stuckInbox = new FakeStuckInbox();
    const subject = harness({ config: enabled({ enabled: false }), fleet: [ryu()], stuckInbox });

    const run = await subject.service.run({ force: false });

    should(run.stuckInbox?.map(flag => flag.sessionId)).eql(['ryu']);
    should(stuckInbox.acts).be.empty();
    should(stuckInbox.notices.size).equal(0);
    should(subject.state().stuckInbox).be.undefined();
  });

  it('should not remember a notice the machine agenda refused, so the next sweep tries again', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    stuckInbox.noticeFails = true;
    const subject = harness({ config: enabled(), fleet: [ryu()], stuckInbox, now: () => now });
    await subject.service.run({ force: false });
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });

    should(subject.state().stuckInbox?.ryu?.noticedAt).be.undefined();
    should(journalTypes(subject)).containEql('fleet.warden_inbox_notice_failed');
    stuckInbox.noticeFails = false;
    now = NOW + 10 * MINUTE;
    await subject.service.run({ force: false });
    should(stuckInbox.notices.has('ryu')).be.true();
  });

  it('should let an investigation’s verdict do nothing but re-check again — never nudge, and never leave it alone', async () => {
    for (const [verdict, recommended, rechecks] of [
      ['NUDGE', 'NUDGE', 1],
      ['KILL', 'STOP', 1],
      ['LEAVE', 'LEAVE', 0],
    ] as const) {
      let now = NOW;
      const stuckInbox = new FakeStuckInbox();
      const spawnAt = iso(NOW + 5 * MINUTE).replaceAll(/[:.]/gu, '-');
      const subject = harness({
        config: enabled({ layers: { jev: false, llm: true } }),
        fleet: [ryu()],
        stuckInbox,
        now: () => now,
        reports: {
          [`/state/warden/reports/${spawnAt}-ryu.md`]: [
            `Verdict: ${verdict}`,
            '',
            '# Warden report — ryu',
            '',
            '- **Anomaly kind:** inbox_stuck',
            '',
            '## Summary',
            `- **Recommended action:** ${recommended} — the head send is accepted and nothing watches it`,
            '- **Outcome:** the queue is still held',
          ].join('\n'),
        },
      });
      await subject.service.run({ force: false });
      now = NOW + 5 * MINUTE;
      await subject.service.run({ force: false });
      should(subject.spawns).have.length(1);

      // The investigator has finished: it is no longer in the fleet.
      now = NOW + 10 * MINUTE;
      await subject.service.run({ force: false });

      const rechecked = subject.journal.filter(
        entry => entry.type === 'fleet.warden_inbox_rechecked' && entry.data.by === 'investigation',
      );
      should(rechecked).have.length(rechecks);
      should(stuckInbox.acts).have.length(2 + 2 * rechecks);
      should(subject.remedies).be.empty();
      should(subject.state().blessings ?? {}).not.have.property('ryu');
    }
  });

  it('should never displace the ferret’s own investigation: a frozen ferret with a stuck inbox is investigated as frozen', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    const subject = harness({ config: enabled(), fleet: [ryu()], stuckInbox, now: () => now });
    await subject.service.run({ force: false });
    subject.setFleet([{ ...ryu(), frozenAt: iso(NOW - 10 * MINUTE) }]);
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });

    should(stuckInbox.notices.has('ryu')).be.true();
    should(subject.spawns).have.length(1);
    should(subject.spawns[0]?.prompt).match(/"kind": "agent_frozen"/);
    should(subject.spawns[0]?.prompt).not.match(/Its inbox was flagged stuck/);
    should(subject.state().assignments?.ryu?.kinds).eql(['agent_frozen']);
    should(subject.state().stuckInbox?.ryu).not.have.property('investigatedAt');
  });

  it('should still investigate the inbox when the ferret’s own anomaly is left alone and will not be investigated', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    const subject = harness({ config: enabled(), fleet: [ryu()], stuckInbox, now: () => now });
    await subject.service.run({ force: false });
    subject.setFleet([{ ...ryu(), frozenAt: iso(NOW - 10 * MINUTE) }]);
    subject.setState({
      ...subject.state(),
      blessings: {
        ryu: {
          sessionId: 'ryu',
          kinds: ['agent_frozen'],
          status: 'running',
          blessedAt: iso(NOW),
          expiresAt: iso(NOW + 24 * 60 * MINUTE),
        },
      },
    });
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });

    should(subject.spawns).have.length(1);
    should(subject.state().assignments?.ryu?.kinds).eql(['inbox_stuck']);
    should(subject.state().stuckInbox?.ryu?.investigatedAt).equal(iso(now));
  });

  it('should investigate an episode once, however long it stays stuck', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    const subject = harness({
      config: enabled({ assignedCooldownMinutes: 0 }),
      fleet: [ryu()],
      stuckInbox,
      now: () => now,
    });
    for (let sweep = 0; sweep < 6; sweep += 1) {
      await subject.service.run({ force: false });
      now += 30 * MINUTE;
    }

    should(subject.spawns).have.length(1);
    should(subject.state().stuckInbox?.ryu?.investigatedAt).equal(iso(NOW + 30 * MINUTE));
  });

  it('should leave a ferret on the notice, remembered, when its queue or ledger cannot be read this sweep', async () => {
    for (const fails of ['written', 'queue', 'sends'] as const) {
      let now = NOW;
      const stuckInbox = new FakeStuckInbox();
      const subject = harness({ config: enabled(), fleet: [ryu()], stuckInbox, now: () => now });
      await subject.service.run({ force: false });
      now = NOW + 5 * MINUTE;
      await subject.service.run({ force: false });
      const remembered = subject.state().stuckInbox;

      stuckInbox.fails = fails;
      now = NOW + 10 * MINUTE;
      await subject.service.run({ force: false });

      should(stuckInbox.notices.has('ryu')).be.true();
      should(subject.state().stuckInbox).eql(remembered);
      should(journalTypes(subject)).not.containEql('fleet.warden_inbox_recovered');
      should(stuckInbox.acts).have.length(2);
    }
  });

  it('should not read a queue untouched for longer than the horizon, and should say an old inbox expired, not drained', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    stuckInbox.written = { ryu: NOW - 5 * 24 * 60 * MINUTE };
    const stale = harness({ config: enabled(), fleet: [ryu()], stuckInbox, now: () => now });
    await stale.service.run({ force: false });
    should(stuckInbox.readCalls).equal(0);

    const aging = new FakeStuckInbox();
    const subject = harness({ config: enabled(), fleet: [ryu()], stuckInbox: aging, now: () => now });
    await subject.service.run({ force: false });
    now = NOW + 3 * 24 * 60 * MINUTE;
    await subject.service.run({ force: false });

    should(journalTypes(subject)).containEql('fleet.warden_inbox_expired');
    should(journalTypes(subject)).not.containEql('fleet.warden_inbox_recovered');
    should(subject.state().stuckInbox).be.undefined();
  });

  it('should re-check on a forced run even with the Warden off', async () => {
    const stuckInbox = new FakeStuckInbox();
    const subject = harness({ config: enabled({ enabled: false }), fleet: [ryu()], stuckInbox });

    await subject.service.run({ force: true });

    should(stuckInbox.acts).eql(['tracker:ryu', 'delivery:ryu']);
  });

  it('should re-check nothing on a NEEDS_HUMAN verdict', async () => {
    let now = NOW;
    const stuckInbox = new FakeStuckInbox();
    const spawnAt = iso(NOW + 5 * MINUTE).replaceAll(/[:.]/gu, '-');
    const subject = harness({
      config: enabled(),
      fleet: [ryu()],
      stuckInbox,
      now: () => now,
      reports: {
        [`/state/warden/reports/${spawnAt}-ryu.md`]: [
          'Verdict: NEEDS_HUMAN',
          '',
          '- **Anomaly kind:** inbox_stuck',
          '- **Recommended action:** LEAVE — a person’s draft is in the box; send or clear it',
        ].join('\n'),
      },
    });
    await subject.service.run({ force: false });
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });
    now = NOW + 10 * MINUTE;
    await subject.service.run({ force: false });

    should(subject.journal.filter(entry => entry.data.by === 'investigation')).be.empty();
    should(stuckInbox.acts).have.length(2);
    should(subject.remedies).be.empty();
  });
});
