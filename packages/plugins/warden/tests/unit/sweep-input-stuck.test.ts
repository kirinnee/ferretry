import { describe, it } from 'bun:test';
import should from 'should';
import type { StuckInputNotice } from '../../daemon/lib/input-stuck-list.ts';
import type {
  StuckInputPress,
  StuckInputSend,
  WardenFleetSession,
  WardenStuckInputPort,
} from '../../daemon/lib/index.ts';
import { enabled, harness, journalTypes, NOW, session } from './sweep-harness.ts';

/**
 * A ferret idle behind its own unsent message, end to end through the real sweep: one Enter, then — when that
 * does not submit it — marked stalled and named on the machine notice once, and taken off it on recovery.
 * Never put to Jev or an investigation.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const idle = (over: Partial<WardenFleetSession['state']> = {}): WardenFleetSession => {
  const base = session({
    id: 'annabeth',
    state: { turnState: 'your-turn', turnStateAt: iso(NOW - 20 * MINUTE), ...over },
  });
  return { ...base, config: { ...base.config, teammate: 'annabeth' } };
};

const pointer: StuckInputSend = {
  sendId: 'send-63',
  path: 'turn-file',
  fate: 'unaccounted',
  unaccountedReason: 'landing_unconfirmed',
  typedNotSent: true,
  acceptedAt: iso(NOW - 10 * MINUTE),
  attemptAt: iso(NOW - 10 * MINUTE),
  fateAt: iso(NOW - 10 * MINUTE + 25_000),
};

class FakeStuckInput implements WardenStuckInputPort {
  readonly pressed: string[] = [];
  readonly stalled: string[] = [];
  readonly cleared: string[] = [];
  readonly notices = new Map<string, StuckInputNotice>();
  sendsBy: Record<string, readonly StuckInputSend[]> = { annabeth: [pointer] };
  press: StuckInputPress = 'holding';
  readonly boxRead: string[] = [];
  takenBack: Record<string, string> = {};
  noticeFails = false;
  removeFails = false;

  async sends(sessionId: string): Promise<readonly StuckInputSend[]> {
    return this.sendsBy[sessionId] ?? [];
  }

  async resubmit(sessionId: string, sendId: string): Promise<StuckInputPress> {
    this.pressed.push(`${sessionId}:${sendId}`);
    return this.press;
  }

  async retracted(sessionId: string): Promise<string | undefined> {
    this.boxRead.push(sessionId);
    return this.takenBack[sessionId];
  }

  async markStalled(sessionId: string): Promise<void> {
    this.stalled.push(sessionId);
  }

  async clearStalled(sessionId: string): Promise<void> {
    this.cleared.push(sessionId);
  }

  async add(notice: StuckInputNotice): Promise<void> {
    if (this.noticeFails) throw new Error('agenda refused');
    this.notices.set(notice.sessionId, notice);
  }

  async remove(sessionId: string): Promise<void> {
    if (this.removeFails) throw new Error('agenda refused');
    this.notices.delete(sessionId);
  }
}

describe('a ferret stuck behind its own unsent message (B144)', () => {
  it('should press Enter once, then mark it stalled and name it on the notice once, and never ask Jev', async () => {
    let now = NOW;
    const stuckInput = new FakeStuckInput();
    const subject = harness({
      config: enabled({ layers: { jev: true, llm: true } }),
      fleet: [idle()],
      stuckInput,
      now: () => now,
    });

    const first = await subject.service.run({ force: false });
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });

    // In its own field, never in `anomalies`, which an older app parses against a closed list of kinds.
    should(first.anomalies).be.empty();
    should(first.stuckInput?.map(anomaly => [anomaly.kind, anomaly.sessionId])).eql([['input_stuck', 'annabeth']]);
    should(first.stuckInput?.[0]).not.have.property('sendId');
    const status = await subject.service.status();
    should(status.anomalies).be.empty();
    should(status.stuckInput?.map(anomaly => anomaly.sessionId)).eql(['annabeth']);
    should(stuckInput.pressed).eql(['annabeth:send-63']);
    should(stuckInput.stalled).eql(['annabeth']);
    should(stuckInput.notices.get('annabeth')?.line).match(/send send-63 .* Enter was pressed and did not take/);
    should(subject.state().stuckInput).eql({
      annabeth: { sendId: 'send-63', pressedAt: iso(NOW), press: 'holding', noticedAt: iso(NOW) },
    });
    should(subject.spawns).be.empty();
    should(subject.guarded).be.empty();
    should(subject.state().lastFingerprint).equal('');
    should(journalTypes(subject)).containEql('fleet.warden_input_resubmitted');
    should(journalTypes(subject).filter(type => type === 'fleet.warden_input_noticed')).have.length(1);
  });

  it('should notice nothing when the Enter took, and clear the ferret once it has moved on', async () => {
    let now = NOW;
    const stuckInput = new FakeStuckInput();
    stuckInput.press = 'submitted';
    let fleet = [idle()];
    const subject = harness({ config: enabled(), fleet, stuckInput, now: () => now });

    await subject.service.run({ force: false });
    fleet = [idle({ turnState: 'working', turnStateAt: iso(NOW + MINUTE) })];
    const recovered = harness({ config: enabled(), fleet, stuckInput, now: () => now, state: subject.state() });
    now = NOW + 5 * MINUTE;
    await recovered.service.run({ force: false });

    should(stuckInput.pressed).eql(['annabeth:send-63']);
    should(stuckInput.stalled).be.empty();
    should(stuckInput.notices.size).equal(0);
    should(stuckInput.cleared).be.empty();
    should(recovered.state().stuckInput).be.undefined();
  });

  it('should take a recovered ferret off the notice and its stalled mark off it', async () => {
    const stuckInput = new FakeStuckInput();
    const subject = harness({ config: enabled(), fleet: [idle()], stuckInput });
    await subject.service.run({ force: false });

    const moved = harness({
      config: enabled(),
      fleet: [idle({ turnState: 'working' })],
      stuckInput,
      state: subject.state(),
    });
    await moved.service.run({ force: false });

    should(stuckInput.notices.size).equal(0);
    should(stuckInput.cleared).eql(['annabeth']);
    should(journalTypes(moved)).containEql('fleet.warden_input_recovered');
  });

  it('should remember no notice the agenda refused, so the next sweep writes it again', async () => {
    const stuckInput = new FakeStuckInput();
    stuckInput.noticeFails = true;
    const subject = harness({ config: enabled(), fleet: [idle()], stuckInput });

    await subject.service.run({ force: false });

    should(subject.state().stuckInput).eql({ annabeth: { sendId: 'send-63', pressedAt: iso(NOW), press: 'holding' } });
    should(journalTypes(subject)).containEql('fleet.warden_input_notice_failed');
  });

  it('should write the notice on the next sweep after the agenda refused it, without pressing again', async () => {
    const stuckInput = new FakeStuckInput();
    stuckInput.noticeFails = true;
    const subject = harness({ config: enabled(), fleet: [idle()], stuckInput });
    await subject.service.run({ force: false });

    stuckInput.noticeFails = false;
    const again = harness({ config: enabled(), fleet: [idle()], stuckInput, state: subject.state() });
    await again.service.run({ force: false });

    should(stuckInput.pressed).eql(['annabeth:send-63']);
    should(stuckInput.notices.get('annabeth')?.line).match(/Enter was pressed and did not take/);
    should(again.state().stuckInput?.annabeth?.noticedAt).be.a.String();
  });

  it('should keep a recovered ferret in memory when the notice could not be cleared, and try again', async () => {
    const stuckInput = new FakeStuckInput();
    const subject = harness({ config: enabled(), fleet: [idle()], stuckInput });
    await subject.service.run({ force: false });

    stuckInput.removeFails = true;
    const moved = harness({
      config: enabled(),
      fleet: [idle({ turnState: 'working' })],
      stuckInput,
      state: subject.state(),
    });
    await moved.service.run({ force: false });

    should(moved.state().stuckInput?.annabeth?.sendId).equal('send-63');
    should(stuckInput.cleared).be.empty();
  });

  it('should neither mark nor notice a ferret whose box the press found empty — nothing says resend (review finding)', async () => {
    const stuckInput = new FakeStuckInput();
    stuckInput.press = 'absent';
    const subject = harness({ config: enabled(), fleet: [idle()], stuckInput });

    await subject.service.run({ force: false });
    const again = harness({ config: enabled(), fleet: [idle()], stuckInput, state: subject.state() });
    await again.service.run({ force: false });

    should(stuckInput.pressed).eql(['annabeth:send-63']);
    should(stuckInput.stalled).be.empty();
    should(stuckInput.notices.size).equal(0);
  });

  it('should still flag a stuck ferret with the Warden off, pressing and noticing nothing', async () => {
    const stuckInput = new FakeStuckInput();
    const subject = harness({ config: enabled({ enabled: false }), fleet: [idle()], stuckInput });

    const run = await subject.service.run({ force: false });

    should(run.stuckInput?.map(anomaly => anomaly.kind)).eql(['input_stuck']);
    should(stuckInput.pressed).be.empty();
    should(stuckInput.notices.size).equal(0);
  });
});

describe('&B153: a delivered pointer the harness took back into the box', () => {
  const delivered: StuckInputSend = {
    sendId: 'turn-007',
    path: 'turn-file',
    fate: 'delivered',
    acceptedAt: iso(NOW - 180 * MINUTE),
    attemptAt: iso(NOW - 180 * MINUTE),
    fateAt: iso(NOW - 180 * MINUTE + 3_000),
  };

  it('should read the box, press once for the pointer it holds, then notice it if it is taken back again', async () => {
    let now = NOW;
    const stuckInput = new FakeStuckInput();
    stuckInput.sendsBy = { annabeth: [delivered] };
    stuckInput.takenBack = { annabeth: 'turn-007' };
    stuckInput.press = 'submitted';
    const subject = harness({ config: enabled(), fleet: [idle()], stuckInput, now: () => now });

    const first = await subject.service.run({ force: false });
    now = NOW + 5 * MINUTE;
    await subject.service.run({ force: false });

    should(first.stuckInput?.map(anomaly => anomaly.sessionId)).eql(['annabeth']);
    should(stuckInput.boxRead).eql(['annabeth', 'annabeth']);
    // One press per episode; the same pointer back in the box a sweep later is escalated, not pressed again.
    should(stuckInput.pressed).eql(['annabeth:turn-007']);
    should(stuckInput.stalled).eql(['annabeth']);
    should(stuckInput.notices.get('annabeth')?.line).match(/send turn-007 .* Enter was pressed and it is still idle/);
  });

  it('should not read the box when the newest send is not a delivered pointer, nor flag an empty box', async () => {
    const stuckInput = new FakeStuckInput();
    stuckInput.sendsBy = {
      annabeth: [delivered, { ...delivered, sendId: 'later', path: 'direct', acceptedAt: iso(NOW - MINUTE) }],
    };
    const quiet = new FakeStuckInput();
    quiet.sendsBy = { annabeth: [delivered] };

    const first = await harness({ config: enabled(), fleet: [idle()], stuckInput }).service.run({ force: false });
    const second = await harness({ config: enabled(), fleet: [idle()], stuckInput: quiet }).service.run({
      force: false,
    });

    should(stuckInput.boxRead).be.empty();
    should(first.stuckInput ?? []).be.empty();
    should(quiet.boxRead).eql(['annabeth']);
    should(second.stuckInput ?? []).be.empty();
    should(quiet.pressed).be.empty();
  });
});
