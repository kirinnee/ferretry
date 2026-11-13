/**
 * THE HOSTED RELAY LOOKUP RETRIES AFTER A FAILED BOOT-TIME READ.
 *
 * The defect: the advertisement was read once per boot, so a network that was not up yet right after a
 * restart left the daemon direct-only until the NEXT restart — and a browser that could only reach it
 * over the relay could not connect. Every case below is one half of the rule that replaces it: a
 * TRANSIENT failure is asked again, in the background, on a capped and jittered clock; a DEFINITIVE
 * answer is final; and there is only ever one loop, which stopping the daemon ends.
 *
 * No network and no real time: the directory is a script, the timers fire when the test says so.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  isTransientAdvertisement,
  newlyDiscoveredRelays,
  type RelayAdvertisement,
  type RelayCarrierSource,
  RELAY_LOOKUP_RETRY_BACKOFF,
  RelayLookupRetry,
  type RelayLookupSettled,
} from '../../../src/lib/relay/index.ts';
import { ManualScheduler } from '../tunnel/support.ts';

const TRANSIENT: RelayAdvertisement = {
  kind: 'undetermined',
  reason: 'this daemon could not reach the relay directory',
  transient: true,
};
const AVAILABLE: RelayAdvertisement = { kind: 'available', relayUrl: 'https://relay.example' };

/** Lets the read the timer started finish, however many microtasks that takes. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

function scripted(...answers: readonly RelayAdvertisement[]) {
  const asked: number[] = [];
  const remaining = [...answers];
  return {
    asked,
    port: {
      read: async (): Promise<RelayAdvertisement> => {
        asked.push(asked.length + 1);
        return remaining.shift() ?? TRANSIENT;
      },
    },
  };
}

function retryOver(directory: ReturnType<typeof scripted>, scheduler: ManualScheduler) {
  const settled: RelayLookupSettled[] = [];
  const retry = new RelayLookupRetry({
    directory: directory.port,
    scheduler,
    random: () => 0.5,
    onSettled: result => {
      settled.push(result);
    },
  });
  return { retry, settled };
}

describe('the relay lookup retry', () => {
  it('should classify only a failure marked transient as worth asking again', () => {
    should(isTransientAdvertisement(TRANSIENT)).be.true();
    should(isTransientAdvertisement({ kind: 'undetermined', reason: 'a document it cannot read' })).be.false();
    should(isTransientAdvertisement({ kind: 'disabled' })).be.false();
    should(isTransientAdvertisement(AVAILABLE)).be.false();
  });

  it('should ask again after a transient failure and settle with the attempt count when it answers', async () => {
    // Arrange — the first retry still fails, the second succeeds.
    const scheduler = new ManualScheduler();
    const directory = scripted(TRANSIENT, AVAILABLE);
    const { retry, settled } = retryOver(directory, scheduler);

    // Act
    retry.start();
    should(scheduler.armed).have.length(1);
    scheduler.fire();
    await settle();
    should(settled).be.empty();
    scheduler.fire();
    await settle();

    // Assert — three attempts counting the boot's own failed read as the first.
    should(directory.asked).have.length(2);
    should(settled).deepEqual([{ advertisement: AVAILABLE, attempts: 3 }]);
    should(scheduler.armed).be.empty();
  });

  it('should not ask again once the directory has given a definitive answer', async () => {
    for (const definitive of [
      { kind: 'disabled' } as const,
      { kind: 'undetermined', reason: 'the relay directory answered a document this daemon cannot read' } as const,
    ]) {
      // Arrange
      const scheduler = new ManualScheduler();
      const directory = scripted(definitive);
      const { retry, settled } = retryOver(directory, scheduler);

      // Act
      retry.start();
      scheduler.fire();
      await settle();

      // Assert
      should(settled).have.length(1);
      should(settled[0]?.advertisement).deepEqual(definitive);
      should(scheduler.armed).be.empty();
      should(directory.asked).have.length(1);
    }
  });

  it('should cancel a pending retry when it is stopped, and ignore an answer that arrives after', async () => {
    // Arrange
    const scheduler = new ManualScheduler();
    const directory = scripted(AVAILABLE);
    const { retry, settled } = retryOver(directory, scheduler);
    retry.start();

    // Act
    retry.stop();
    scheduler.fire();
    await settle();

    // Assert
    should(scheduler.armed).be.empty();
    should(directory.asked).be.empty();
    should(settled).be.empty();
  });

  it('should drop an answer that arrives while it is being stopped', async () => {
    // Arrange — a read in flight at the moment the daemon stops.
    const scheduler = new ManualScheduler();
    let answer: (value: RelayAdvertisement) => void = () => undefined;
    const settled: RelayLookupSettled[] = [];
    const retry = new RelayLookupRetry({
      directory: {
        read: async () =>
          await new Promise<RelayAdvertisement>(resolve => {
            answer = resolve;
          }),
      },
      scheduler,
      random: () => 0.5,
      onSettled: result => {
        settled.push(result);
      },
    });
    retry.start();
    scheduler.fire();

    // Act
    retry.stop();
    answer(AVAILABLE);
    await settle();

    // Assert — no carrier is started for a daemon that has stopped, and no retry is armed.
    should(settled).be.empty();
    should(scheduler.armed).be.empty();
  });

  it('should back off, jittered and capped, with exactly one timer armed at a time', async () => {
    // Arrange — the directory never comes back.
    const scheduler = new ManualScheduler();
    const directory = scripted();
    const { retry } = retryOver(directory, scheduler);

    // Act
    retry.start();
    const delays: number[] = [];
    for (let round = 0; round < 12; round += 1) {
      should(scheduler.armed).have.length(1);
      delays.push(...scheduler.fire());
      await settle();
    }

    // Assert — the first wait is the base, they only grow, and none passes the cap. With the dice at
    // 0.5 an equal-jitter wait is three quarters of its step.
    should(delays[0]).equal(Math.round(RELAY_LOOKUP_RETRY_BACKOFF.baseMs * 0.75));
    for (let index = 1; index < delays.length; index += 1) {
      should(delays[index] ?? 0).be.aboveOrEqual(delays[index - 1] ?? 0);
    }
    should(Math.max(...delays)).be.belowOrEqual(RELAY_LOOKUP_RETRY_BACKOFF.capMs);
    should(delays.at(-1)).equal(Math.round(RELAY_LOOKUP_RETRY_BACKOFF.capMs * 0.75));
    should(directory.asked).have.length(12);
  });

  it('should be started once: a second start does not arm a second loop', () => {
    // Arrange
    const scheduler = new ManualScheduler();
    const { retry } = retryOver(scripted(), scheduler);

    // Act
    retry.start();
    retry.start();

    // Assert
    should(scheduler.armed).have.length(1);
  });

  it('should end quietly when the settled handler itself throws, without a second loop', async () => {
    // Arrange
    const scheduler = new ManualScheduler();
    const retry = new RelayLookupRetry({
      directory: scripted(AVAILABLE).port,
      scheduler,
      random: () => 0.5,
      onSettled: () => {
        throw new Error('carrier factory failed');
      },
    });

    // Act
    retry.start();
    scheduler.fire();
    await settle();

    // Assert — the owner of the carriers reports its own failure; nothing is asked again.
    should(scheduler.armed).be.empty();
  });

  it('should treat a read that throws as transient rather than ending the loop', async () => {
    // Arrange
    const scheduler = new ManualScheduler();
    const settled: RelayLookupSettled[] = [];
    const retry = new RelayLookupRetry({
      directory: {
        read: async () => {
          throw new Error('boom');
        },
      },
      scheduler,
      random: () => 0.5,
      onSettled: result => {
        settled.push(result);
      },
    });

    // Act
    retry.start();
    scheduler.fire();
    await settle();

    // Assert
    should(settled).be.empty();
    should(scheduler.armed).have.length(1);
  });
});

describe('newlyDiscoveredRelays', () => {
  const direct = (reason: string): RelayCarrierSource => ({ kind: 'direct-only', reason });
  const discovered = (url: string): RelayCarrierSource => ({
    kind: 'discovered',
    config: { url, enabled: true, reconnectSeconds: 5 },
  });
  const configured = (url: string): RelayCarrierSource => ({
    kind: 'configured',
    config: { url, enabled: true, reconnectSeconds: 5 },
  });

  it('should name only the sources that were direct-only and are now a discovered relay', () => {
    // Arrange
    const before = [configured('wss://mine.example'), direct('no relay could be discovered')];
    const after = [configured('wss://mine.example'), discovered('wss://relay.example')];

    // Act / Assert
    should(newlyDiscoveredRelays(before, after)).deepEqual([after[1]]);
  });

  it('should name nothing when the answer is still direct-only', () => {
    should(newlyDiscoveredRelays([direct('a')], [direct('b')])).be.empty();
  });
});
