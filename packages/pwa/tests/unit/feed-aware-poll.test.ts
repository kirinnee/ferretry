import { afterEach, describe, it } from 'bun:test';
import type { FyEvent } from '@ferretry/protocol';
import should from 'should';
import {
  browserFeedAwarePollEnvironment,
  type FeedAwarePollEnvironment,
  startFeedAwarePoll,
  startVisiblePoll,
  whileVisible,
} from '../../src/lib/feed-aware-poll.ts';
import { createSurfaceEventHub } from '../../src/lib/surface-control.ts';

/** Timers and visibility the test moves by hand: `advance` fires every timer due, in order. */
const handEnvironment = () => {
  let time = 0;
  let hidden = false;
  const timers: { id: number; at: number; callback: () => void }[] = [];
  const visible = new Set<() => void>();
  let next = 0;
  const environment: FeedAwarePollEnvironment = {
    setTimeout: (callback, milliseconds) => {
      next += 1;
      timers.push({ id: next, at: time + milliseconds, callback });
      return next;
    },
    clearTimeout: handle => {
      const index = timers.findIndex(timer => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    hidden: () => hidden,
    onVisible: listener => {
      visible.add(listener);
      return () => visible.delete(listener);
    },
  };
  return {
    environment,
    pending: () => timers.length,
    advance: (milliseconds: number) => {
      const until = time + milliseconds;
      for (;;) {
        const due = timers.filter(timer => timer.at <= until).sort((left, right) => left.at - right.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        time = due.at;
        due.callback();
      }
      time = until;
    },
    hide: () => {
      hidden = true;
    },
    show: () => {
      hidden = false;
      for (const listener of [...visible]) listener();
    },
  };
};

const event = (type: string): FyEvent => ({
  sequence: 1,
  time: '2026-10-21T00:00:00.000Z',
  sessionId: 'fy_s_1',
  type,
  source: 'daemon',
  data: {},
});

describe('startFeedAwarePoll', () => {
  it('should read at once and on its old cadence while there is no live feed', () => {
    // Arrange
    const hand = handEnvironment();
    let reads = 0;

    // Act
    const stop = startFeedAwarePoll({
      read: () => (reads += 1),
      everyMs: 10_000,
      liveEveryMs: 120_000,
      environment: hand.environment,
    });
    hand.advance(60_000);
    stop();
    hand.advance(60_000);

    // Assert — one at once, six in the minute, none after stopping.
    should(reads).equal(7);
    should(hand.pending()).equal(0);
  });

  it('should stand back to the safety net while the feed is live, and pick its pace up when it is not', () => {
    // Arrange
    const hand = handEnvironment();
    const hub = createSurfaceEventHub();
    let reads = 0;
    const stop = startFeedAwarePoll({
      read: () => (reads += 1),
      everyMs: 10_000,
      liveEveryMs: 120_000,
      feed: hub,
      environment: hand.environment,
    });

    // Act — live for four minutes, then the feed drops for a minute.
    hub.setLive(true);
    hand.advance(240_000);
    const whileLive = reads;
    hub.setLive(false);
    hand.advance(60_000);
    stop();

    // Assert — the first read, then one every two minutes; then six in the dropped minute.
    should(whileLive).equal(3);
    should(reads - whileLive).equal(6);
  });

  it('should read once after a burst of relevant events, and ignore the rest', () => {
    // Arrange
    const hand = handEnvironment();
    const hub = createSurfaceEventHub();
    hub.setLive(true);
    let reads = 0;
    const stop = startFeedAwarePoll({
      read: () => (reads += 1),
      everyMs: 10_000,
      liveEveryMs: 120_000,
      relevant: candidate => candidate.type.startsWith('surface.'),
      feed: hub,
      environment: hand.environment,
      settleMs: 100,
    });

    // Act
    hub.publish(event('turn.state'));
    hand.advance(1_000);
    const afterIrrelevant = reads;
    hub.publish(event('surface.opened'));
    hub.publish(event('surface.driving'));
    hand.advance(1_000);
    stop();
    hub.publish(event('surface.opened'));
    hand.advance(1_000);

    // Assert
    should(afterIrrelevant).equal(1);
    should(reads).equal(2);
  });

  it('should read nothing while hidden, and once when shown again', () => {
    // Arrange
    const hand = handEnvironment();
    const hub = createSurfaceEventHub();
    let reads = 0;
    hand.hide();
    const stop = startFeedAwarePoll({
      read: () => (reads += 1),
      everyMs: 10_000,
      liveEveryMs: 120_000,
      relevant: () => true,
      feed: hub,
      environment: hand.environment,
      settleMs: 100,
    });

    // Act — hidden from the start, an event arrives, a liveness change, then shown twice.
    hand.advance(60_000);
    hub.publish(event('surface.opened'));
    hub.setLive(true);
    hand.advance(60_000);
    const whileHidden = reads;
    hand.show();
    const afterShown = reads;
    hand.show();
    hand.advance(10_000);
    stop();
    hand.show();

    // Assert — nothing while hidden; one owed read on showing; a second show owes nothing.
    should(whileHidden).equal(0);
    should(afterShown).equal(1);
    should(reads).equal(1);
  });

  it('should skip a tick that falls while hidden, and make it up on showing', () => {
    // Arrange
    const hand = handEnvironment();
    let reads = 0;
    const stop = startVisiblePoll(() => (reads += 1), 10_000, hand.environment);

    // Act
    hand.hide();
    hand.advance(30_000);
    const whileHidden = reads;
    hand.show();
    stop();

    // Assert
    should(whileHidden).equal(1);
    should(reads).equal(2);
  });

  it('should poll on the browser timers when no environment is given', async () => {
    // Arrange
    let reads = 0;

    // Act
    const stop = startVisiblePoll(() => (reads += 1), 5);
    await new Promise(resolve => setTimeout(resolve, 40));
    stop();

    // Assert
    should(reads).be.above(1);
  });
});

describe('browserFeedAwarePollEnvironment', () => {
  const realDocument = globalThis.document;
  afterEach(() => {
    globalThis.document = realDocument;
  });

  it('should read the document visibility and tell a listener only when it is shown', () => {
    // Arrange — a stand-in document that can be hidden and shown.
    let state: DocumentVisibilityState = 'visible';
    const listeners = new Set<() => void>();
    globalThis.document = {
      get visibilityState() {
        return state;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    } as unknown as Document;
    let shown = 0;
    const flip = (next: DocumentVisibilityState): void => {
      state = next;
      for (const listener of [...listeners]) listener();
    };

    // Act
    const stop = browserFeedAwarePollEnvironment.onVisible(() => (shown += 1));
    const hiddenAtFirst = browserFeedAwarePollEnvironment.hidden();
    flip('hidden');
    const hiddenThen = browserFeedAwarePollEnvironment.hidden();
    flip('visible');
    stop();
    flip('hidden');
    flip('visible');

    // Assert
    should(hiddenAtFirst).be.false();
    should(hiddenThen).be.true();
    should(shown).equal(1);
    should(listeners.size).equal(0);
  });

  it('should treat a page with no document as shown', () => {
    // Arrange
    globalThis.document = undefined as unknown as Document;

    // Act
    const hidden = browserFeedAwarePollEnvironment.hidden();
    const stop = browserFeedAwarePollEnvironment.onVisible(() => undefined);
    stop();

    // Assert
    should(hidden).be.false();
  });
});

describe('whileVisible', () => {
  it('should read only while the tab is shown', () => {
    // Arrange
    let hidden = false;
    let reads = 0;
    const tick = whileVisible(() => (reads += 1), { hidden: () => hidden });

    // Act
    tick();
    hidden = true;
    tick();

    // Assert
    should(reads).equal(1);
  });
});
