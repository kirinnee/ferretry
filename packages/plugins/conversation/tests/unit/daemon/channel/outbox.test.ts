import { describe, it } from 'bun:test';
import should from 'should';
import { CHANNEL_GRACE_MS, ChannelOutbox, type OutboxClock } from '../../../../daemon/channel/lib/outbox.ts';
import { channelSenderName } from '../../../../daemon/channel/lib/identity.ts';

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
const G1 = 'gen-1';
const G2 = 'gen-2';

describe('the Claude channel outbox', () => {
  it('should know when it began holding state, so a send accepted before it has an unknown claim state', () => {
    const clock = new Clock();
    const outbox = new ChannelOutbox(clock);
    clock.advance(5_000);

    should(outbox.bootedAt).equal(1_000);
    should(new ChannelOutbox(clock).bootedAt).equal(6_000);
  });

  it('offers a waiting message to the next poll at once, and it is the server’s to push only once it CLAIMS it', async () => {
    const clock = new Clock();
    const outbox = new ChannelOutbox(clock);
    outbox.push('f1', message('s-1', { from: 'kamila' }));

    should(await outbox.poll('f1', G1, 20_000)).eql([{ sendId: 's-1', text: 'text of s-1', from: 'kamila' }]);
    should(outbox.claimedAt('f1', 's-1')).be.undefined();
    should(outbox.claim('f1', G1, 's-1')).be.true();
    should(outbox.claimedAt('f1', 's-1')).equal(clock.ms);
    // a claim is granted once; an unknown id, another ferret and an unknown ferret get nothing
    should(outbox.claim('f1', G1, 's-1')).be.false();
    should(outbox.claim('f1', G1, 'nope')).be.false();
    should(outbox.claim('f2', G1, 's-1')).be.false();
  });

  it('wakes a poll that is waiting when a message arrives, and stops that poll’s timer', async () => {
    const clock = new Clock();
    const outbox = new ChannelOutbox(clock);
    const polling = outbox.poll('f1', G1, 20_000);
    should(outbox.connected('f1')).be.true();

    outbox.push('f1', message('s-1'));

    should(await polling).have.length(1);
    should(clock.timers.every(timer => !timer.live)).be.true();
  });

  it('answers a poll empty when its wait ends, and a zero wait at once', async () => {
    const clock = new Clock();
    const outbox = new ChannelOutbox(clock);
    const polling = outbox.poll('f1', G1, 5_000);

    clock.advance(5_000);

    should(await polling).eql([]);
    should(await outbox.poll('f1', G1, 0)).eql([]);
  });

  it('lets a second poll end the first, so a restarted server never leaves an old poll holding messages', async () => {
    const outbox = new ChannelOutbox(new Clock());
    const first = outbox.poll('f1', G1, 20_000);
    const second = outbox.poll('f1', G1, 20_000);

    should(await first).eql([]);
    outbox.push('f1', message('s-1'));
    should(await second).have.length(1);
  });

  it('is connected while a poll is open and for the grace after one ended, and not before the first poll', async () => {
    const clock = new Clock();
    const outbox = new ChannelOutbox(clock);
    should(outbox.connected('f1')).be.false();

    await outbox.poll('f1', G1, 0);
    should(outbox.connected('f1')).be.true();
    clock.advance(CHANNEL_GRACE_MS);
    should(outbox.connected('f1')).be.true();
    clock.advance(1);
    should(outbox.connected('f1')).be.false();
  });

  it('keeps a send id once: queued, offered or claimed, a second push of it is ignored', async () => {
    const outbox = new ChannelOutbox(new Clock());
    outbox.push('f1', message('s-1'));
    outbox.push('f1', message('s-1'));
    should(await outbox.poll('f1', G1, 0)).have.length(1);
    outbox.push('f1', message('s-1'));
    should(await outbox.poll('f1', G1, 0)).eql([]);
    outbox.claim('f1', G1, 's-1');
    outbox.push('f1', message('s-1'));
    should(await outbox.poll('f1', G1, 0)).eql([]);
  });

  describe('withdraw against a delayed poll response (regression: a late push after the fallback typed it)', () => {
    it('refuses the CLAIM of a message withdrawn after the poll offered it, so exactly one transport carries it', async () => {
      const outbox = new ChannelOutbox(new Clock());
      outbox.push('f1', message('s-1'));
      // The poll answer has left the daemon (and is delayed in transit): the message is offered, not claimed.
      should(await outbox.poll('f1', G1, 0)).have.length(1);

      // The fallback takes it back and types it instead.
      should(outbox.withdraw('f1', 's-1')).equal('withdrawn');
      // The delayed answer finally arrives and the server asks to push: refused, nothing is written.
      should(outbox.claim('f1', G1, 's-1')).be.false();
    });

    it('never withdraws a CLAIMED message: it may be on its way to Claude and is resolved only by receipt or by the window', async () => {
      const outbox = new ChannelOutbox(new Clock());
      outbox.push('f1', message('s-1'));
      await outbox.poll('f1', G1, 0);
      outbox.claim('f1', G1, 's-1');

      should(outbox.withdraw('f1', 's-1')).equal('claimed');
      should(outbox.claimedAt('f1', 's-1')).not.be.undefined();
    });

    it('takes back one still waiting, and treats an unknown send or ferret as withdrawn (its later claim is refused)', async () => {
      const outbox = new ChannelOutbox(new Clock());
      outbox.push('f1', message('waiting'));

      should(outbox.withdraw('f1', 'waiting')).equal('withdrawn');
      should(outbox.withdraw('f1', 'never-here')).equal('withdrawn');
      should(outbox.withdraw('nobody', 'x')).equal('withdrawn');
      should(await outbox.poll('f1', G1, 0)).eql([]);
    });
  });

  describe('subscriber generations', () => {
    it('refuses an older generation’s claim once a new subscriber polled, and offers its unclaimed messages again', async () => {
      const outbox = new ChannelOutbox(new Clock());
      outbox.push('f1', message('s-1'));
      await outbox.poll('f1', G1, 0);

      // A new server process (the old one is gone or restarted) polls.
      const offered = await outbox.poll('f1', G2, 0);

      should(offered).eql([message('s-1')]);
      should(outbox.claim('f1', G1, 's-1')).be.false();
      should(outbox.claim('f1', G2, 's-1')).be.true();
    });

    it('keeps a claimed message claimed across a new subscriber: it may already be in Claude’s hands', async () => {
      const outbox = new ChannelOutbox(new Clock());
      outbox.push('f1', message('s-1'));
      await outbox.poll('f1', G1, 0);
      outbox.claim('f1', G1, 's-1');

      await outbox.poll('f1', G2, 0);

      should(outbox.withdraw('f1', 's-1')).equal('claimed');
    });

    it('forgets everything on a daemon restart, so a claim for a message it never offered is refused', () => {
      const restarted = new ChannelOutbox(new Clock());

      should(restarted.claim('f1', G1, 's-1')).be.false();
    });
  });

  describe('receipt and a broken channel', () => {
    it('is proven after the first receipt, and a receipt ends the claim', async () => {
      const outbox = new ChannelOutbox(new Clock());
      outbox.push('f1', message('s-1'));
      await outbox.poll('f1', G1, 0);
      outbox.claim('f1', G1, 's-1');
      should(outbox.proven('f1')).be.false();

      outbox.received('f1', 's-1');

      should(outbox.proven('f1')).be.true();
      should(outbox.claimedAt('f1', 's-1')).be.undefined();
      outbox.received('nobody', 'x');
      should(outbox.proven('nobody')).be.false();
    });

    it('stops routing once marked broken, drops what was waiting, refuses claims, and still holds the poll open', async () => {
      const clock = new Clock();
      const outbox = new ChannelOutbox(clock);
      outbox.push('f1', message('claimed'));
      outbox.push('f1', message('offered'));
      await outbox.poll('f1', G1, 0);
      outbox.claim('f1', G1, 'claimed');
      const waiting = outbox.poll('f1', G1, 5_000);

      outbox.markBroken('f1');

      should(await waiting).eql([]);
      should(outbox.broken('f1')).be.true();
      should(outbox.connected('f1')).be.false();
      should(outbox.claim('f1', G1, 'offered')).be.false();
      should(outbox.claimedAt('f1', 'claimed')).be.undefined();
      // A server still polling a broken channel is held (it must not spin) and is offered nothing, even when pushed to.
      const held = outbox.poll('f1', G1, 5_000);
      outbox.push('f1', message('after'));
      clock.advance(5_000);
      should(await held).eql([]);
      should(await outbox.poll('f1', G1, 0)).eql([]);
    });

    it('drops a message still waiting (never offered) when the channel is marked broken', async () => {
      const outbox = new ChannelOutbox(new Clock());
      outbox.push('f1', message('pending'));

      outbox.markBroken('f1');

      should(await outbox.poll('f1', G1, 0)).eql([]);
    });

    it('gives a broken channel another chance when a NEW subscriber (a relaunched server) polls', async () => {
      const outbox = new ChannelOutbox(new Clock());
      await outbox.poll('f1', G1, 0);
      outbox.markBroken('f1');

      await outbox.poll('f1', G2, 0);

      should(outbox.broken('f1')).be.false();
      should(outbox.connected('f1')).be.true();
    });

    it('marks a channel broken even for a ferret it had never heard from', () => {
      const outbox = new ChannelOutbox(new Clock());

      outbox.markBroken('fresh');

      should(outbox.broken('fresh')).be.true();
      should(outbox.broken('unknown')).be.false();
    });
  });

  it('forgets a ferret that stopped (ending its poll) and ends every poll when the daemon stops', async () => {
    const outbox = new ChannelOutbox(new Clock());
    const one = outbox.poll('f1', G1, 20_000);
    outbox.forget('f1');
    should(await one).eql([]);
    should(outbox.connected('f1')).be.false();
    outbox.forget('never-seen');

    const two = outbox.poll('f2', G1, 20_000);
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
});
