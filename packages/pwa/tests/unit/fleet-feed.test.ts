import { describe, it } from 'bun:test';
import type { FyEvent } from '@ferretry/protocol';
import should from 'should';
import {
  browserFleetFeedEnvironment,
  FLEET_FEED_MIN_INTERVAL_MS,
  FLEET_FEED_SETTLE_MS,
  type FleetFeedEnvironment,
  type FleetFeedStatus,
  type OpenFleetFeed,
  startFleetFeed,
} from '../../src/lib/fleet-feed.ts';

/** Timers and a clock the test moves by hand; `random` is 0, so every retry waits the shortest it may. */
const handTime = () => {
  let time = 0;
  let next = 0;
  const timers: { id: number; at: number; run: () => void }[] = [];
  const environment: FleetFeedEnvironment = {
    setTimeout: (run, milliseconds) => {
      next += 1;
      timers.push({ id: next, at: time + milliseconds, run });
      return next;
    },
    clearTimeout: handle => {
      const index = timers.findIndex(timer => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => time,
    random: () => 0,
  };
  return {
    environment,
    pending: () => timers.length,
    advance: async (milliseconds: number) => {
      const until = time + milliseconds;
      for (;;) {
        const due = timers.filter(timer => timer.at <= until).sort((left, right) => left.at - right.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        time = due.at;
        due.run();
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      }
      time = until;
    },
  };
};

/** One open feed the test plays the daemon's half of. */
interface Opened {
  readonly event: (type: string) => void;
  readonly idle: (seconds?: number) => void;
  readonly end: () => void;
  readonly fail: (reason: unknown) => void;
  readonly signal: AbortSignal;
}

const daemon = () => {
  const opened: Opened[] = [];
  const open: OpenFleetFeed = (onEvent, onIdle, signal) =>
    new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
      opened.push({
        event: type =>
          onEvent({
            sequence: 1,
            time: '2026-10-22T00:00:00.000Z',
            sessionId: 's',
            type,
            source: 'daemon',
            data: {},
          } as FyEvent),
        idle: (seconds = 30) => onIdle(seconds),
        end: () => resolve(),
        fail: reason => reject(reason),
        signal,
      });
    });
  return { opened, open };
};

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('startFleetFeed', () => {
  it('should go live on the opening proof, and read once after a burst of events settles', async () => {
    // Arrange
    const time = handTime();
    const feed = daemon();
    const statuses: FleetFeedStatus[] = [];
    let reads = 0;
    const control = startFleetFeed({
      open: feed.open,
      onChange: () => (reads += 1),
      onStatus: status => statuses.push(status),
      environment: time.environment,
    });

    // Act — the proof, a burst of three events, then a surface event that moves no list row.
    const initial = control.status();
    feed.opened[0]?.idle();
    feed.opened[0]?.event('turn.state');
    feed.opened[0]?.event('control.send_accepted');
    feed.opened[0]?.event('turn.started');
    await time.advance(FLEET_FEED_SETTLE_MS);
    const afterBurst = reads;
    feed.opened[0]?.event('surface.driving');
    await time.advance(10_000);

    // Assert
    should(initial).equal('connecting');
    should(statuses).eql(['live']);
    should(afterBurst).equal(1);
    should(reads).equal(1);
    control.stop();
  });

  it('should leave at least the minimum gap between two reads, however busy the fleet', async () => {
    // Arrange
    const time = handTime();
    const feed = daemon();
    const at: number[] = [];
    const control = startFleetFeed({
      open: feed.open,
      onChange: () => at.push(time.environment.now()),
      environment: time.environment,
    });

    // Act — an event first (it proves the feed too), then another just after the read it asked for.
    feed.opened[0]?.event('turn.state');
    await time.advance(FLEET_FEED_SETTLE_MS);
    feed.opened[0]?.event('turn.state');
    await time.advance(FLEET_FEED_MIN_INTERVAL_MS);

    // Assert
    should(at).eql([FLEET_FEED_SETTLE_MS, FLEET_FEED_SETTLE_MS + FLEET_FEED_MIN_INTERVAL_MS]);
    control.stop();
  });

  it('should say a daemon too old for the feed is unsupported, and never dial it again', async () => {
    // Arrange
    const time = handTime();
    const feed = daemon();
    const control = startFleetFeed({ open: feed.open, onChange: () => undefined, environment: time.environment });

    // Act
    feed.opened[0]?.fail(Object.assign(new Error('unknown event-stream query parameter "tail"'), { status: 400 }));
    await flush();
    await time.advance(120_000);

    // Assert
    should(control.status()).equal('unsupported');
    should(feed.opened).have.length(1);
    should(time.pending()).equal(0);
    control.stop();
  });

  it('should retry a feed that ended, and read once when it is back, because nothing was replayed', async () => {
    // Arrange
    const time = handTime();
    const feed = daemon();
    let reads = 0;
    const control = startFleetFeed({ open: feed.open, onChange: () => (reads += 1), environment: time.environment });
    feed.opened[0]?.idle();

    // Act — a carrier failure, then the daemon ending the stream cleanly, then a 400 after a live feed.
    feed.opened[0]?.fail(new Error('the carrier dropped'));
    await flush();
    const down = control.status();
    await time.advance(1_000);
    feed.opened[1]?.idle();
    await time.advance(FLEET_FEED_SETTLE_MS);
    const readsAfterReturn = reads;
    feed.opened[1]?.end();
    await flush();
    await time.advance(1_000);
    feed.opened[2]?.idle();
    feed.opened[2]?.fail(Object.assign(new Error('refused'), { status: 400 }));
    await flush();

    // Assert — a 400 after the feed was proved is an outage like any other, not "too old".
    should(down).equal('down');
    should(feed.opened).have.length(3);
    should(readsAfterReturn).equal(1);
    should(control.status()).equal('down');
    control.stop();
  });

  it('should abandon a feed that went silent past its deadline and open a new one', async () => {
    // Arrange
    const time = handTime();
    const feed = daemon();
    const control = startFleetFeed({ open: feed.open, onChange: () => undefined, environment: time.environment });
    feed.opened[0]?.idle(30);

    // Act — three missed windows of silence.
    await time.advance(91_000);
    await flush();
    await time.advance(1_000);

    // Assert
    should(feed.opened[0]?.signal.aborted).be.true();
    should(feed.opened).have.length(2);
    control.stop();
  });

  it('should stop everything it holds, and take nothing from a feed that ends after it stopped', async () => {
    // Arrange
    const time = handTime();
    const feed = daemon();
    const statuses: FleetFeedStatus[] = [];
    let reads = 0;
    const control = startFleetFeed({
      open: feed.open,
      onChange: () => (reads += 1),
      onStatus: status => statuses.push(status),
      environment: time.environment,
    });
    feed.opened[0]?.idle();
    feed.opened[0]?.event('turn.state');

    // Act
    control.stop();
    feed.opened[0]?.event('turn.state');
    feed.opened[0]?.idle();
    feed.opened[0]?.fail(new Error('late'));
    await flush();
    await time.advance(60_000);

    // Assert
    should(feed.opened[0]?.signal.aborted).be.true();
    should(reads).equal(0);
    should(statuses).eql(['live']);
    should(time.pending()).equal(0);
    should(feed.opened).have.length(1);
  });

  it('should run on the browser timers by default', async () => {
    // Arrange
    const feed = daemon();
    let reads = 0;

    // Act
    const control = startFleetFeed({ open: feed.open, onChange: () => (reads += 1) });
    feed.opened[0]?.event('turn.state');
    await new Promise(resolve => setTimeout(resolve, FLEET_FEED_SETTLE_MS + 50));
    control.stop();

    // Assert
    should(reads).equal(1);
    should(browserFleetFeedEnvironment.now()).be.above(0);
    should(browserFleetFeedEnvironment.random()).be.within(0, 1);
  });
});
