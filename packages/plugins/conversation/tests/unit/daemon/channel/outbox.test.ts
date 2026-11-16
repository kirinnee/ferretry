import { describe, it } from 'bun:test';
import should from 'should';
import { CHANNEL_GRACE_MS, ChannelOutbox, type OutboxClock } from '../../../../daemon/channel/lib/outbox.ts';
import { channelOrigin, channelSenderName } from '../../../../daemon/channel/lib/identity.ts';

/** A clock whose time and timers the test moves by hand. */
class Clock implements OutboxClock {
  ms = 1_000;
  readonly timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  nowMs(): number {
    return this.ms;
  }
  after(delayMs: number, run: () => void): () => void {
    const timer = { at: this.ms + delayMs, run, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms: number): void {
    this.ms += ms;
    for (const timer of this.timers) if (timer.live && timer.at <= this.ms) (timer.live = false), timer.run();
  }
}

const message = (sendId: string, extra: { from?: string } = {}) => ({ sendId, text: `text of ${sendId}`, ...extra });

describe('the Claude channel outbox', () => {
  it('hands a waiting message to the next poll at once and counts it as delivering until it is acked', async () => {
    const outbox = new ChannelOutbox(new Clock());
    outbox.push('f1', message('s-1', { from: 'kamila' }));

    should(await outbox.poll('f1', 20_000)).eql([{ sendId: 's-1', text: 'text of s-1', from: 'kamila' }]);
    should(outbox.wasAcked('f1', 's-1')).be.false();
    should(outbox.ack('f1', ['s-1', 'nope'])).equal(1);
    should(outbox.wasAcked('f1', 's-1')).be.true();
    // a second ack of the same id still counts it, and an unknown ferret counts nothing
    should(outbox.ack('f1', ['s-1'])).equal(1);
    should(outbox.ack('other', ['s-1'])).equal(0);
    should(outbox.wasAcked('other', 's-1')).be.false();
  });

  it('wakes a poll that is waiting when a message arrives, and stops that poll’s timer', async () => {
    const clock = new Clock();
    const outbox = new ChannelOutbox(clock);
    const polling = outbox.poll('f1', 20_000);
    should(outbox.connected('f1')).be.true();

    outbox.push('f1', message('s-1'));

    should(await polling).have.length(1);
    should(clock.timers.every(timer => !timer.live)).be.true();
  });

  it('answers a poll empty when its wait ends, and a zero wait at once', async () => {
    const clock = new Clock();
    const outbox = new ChannelOutbox(clock);
    const polling = outbox.poll('f1', 5_000);

    clock.advance(5_000);

    should(await polling).eql([]);
    should(await outbox.poll('f1', 0)).eql([]);
  });

  it('lets a second poll end the first, so a restarted server never leaves an old poll holding messages', async () => {
    const outbox = new ChannelOutbox(new Clock());
    const first = outbox.poll('f1', 20_000);
    const second = outbox.poll('f1', 20_000);

    should(await first).eql([]);
    outbox.push('f1', message('s-1'));
    should(await second).have.length(1);
  });

  it('is connected while a poll is open and for the grace after one ended, and not before the first poll', async () => {
    const clock = new Clock();
    const outbox = new ChannelOutbox(clock);
    should(outbox.connected('f1')).be.false();

    await outbox.poll('f1', 0);
    should(outbox.connected('f1')).be.true();
    clock.advance(CHANNEL_GRACE_MS);
    should(outbox.connected('f1')).be.true();
    clock.advance(1);
    should(outbox.connected('f1')).be.false();
  });

  it('keeps a send id once: queued, polled or acked, a second push of it is ignored', async () => {
    const outbox = new ChannelOutbox(new Clock());
    outbox.push('f1', message('s-1'));
    outbox.push('f1', message('s-1'));
    should(await outbox.poll('f1', 0)).have.length(1);
    outbox.push('f1', message('s-1'));
    should(await outbox.poll('f1', 0)).eql([]);
    outbox.ack('f1', ['s-1']);
    outbox.push('f1', message('s-1'));
    should(await outbox.poll('f1', 0)).eql([]);
  });

  it('takes back what nothing forwarded — still waiting or polled and never acked — and never what was acked', async () => {
    const outbox = new ChannelOutbox(new Clock());
    outbox.push('f1', message('waiting'));
    outbox.push('f1', message('polled'));
    outbox.push('f1', message('acked'));
    await outbox.poll('f1', 0);
    outbox.push('f1', message('later'));
    outbox.ack('f1', ['acked']);

    should(outbox.withdraw('f1', 'later')).be.true();
    should(outbox.withdraw('f1', 'polled')).be.true();
    should(outbox.withdraw('f1', 'acked')).be.false();
    should(outbox.withdraw('f1', 'never-here')).be.false();
    should(outbox.withdraw('nobody', 'x')).be.false();
    should(await outbox.poll('f1', 0)).eql([]);
  });

  it('forgets a ferret that stopped (ending its poll) and ends every poll when the daemon stops', async () => {
    const outbox = new ChannelOutbox(new Clock());
    const one = outbox.poll('f1', 20_000);
    outbox.forget('f1');
    should(await one).eql([]);
    should(outbox.connected('f1')).be.false();
    outbox.forget('never-seen');

    const two = outbox.poll('f2', 20_000);
    outbox.stop();
    should(await two).eql([]);
    should(outbox.connected('f2')).be.false();
  });
});

describe('who a channel message is from', () => {
  it('names the sending ferret, falling back to its id, and Ferretry for the daemon’s own words', () => {
    should(channelSenderName({ senderSessionId: 'lead' }, 'kamila')).equal('kamila');
    should(channelSenderName({ senderSessionId: 'lead' }, undefined)).equal('lead');
    should(channelSenderName({ notice: true }, undefined)).equal('Ferretry');
    should(channelSenderName({ agenda: true }, undefined)).equal('Ferretry');
    should(channelSenderName({}, undefined)).be.undefined();
  });

  it('reads the speaker back off a ledger row: the sending ferret, Agenda, or the delivery notice', () => {
    should(channelOrigin({ from: 'lead' })).eql({ senderSessionId: 'lead' });
    should(channelOrigin({ by: { kind: 'ferretry', feature: 'Agenda' } })).eql({ agenda: true });
    should(channelOrigin({ by: { kind: 'ferretry', feature: 'Delivery' } })).eql({ notice: true });
  });
});
