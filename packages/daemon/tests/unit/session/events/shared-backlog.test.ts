import { describe, it } from 'bun:test';
import should from 'should';
import { KeyedSerialExecutor } from '../../../../src/adapters/system/keyed-serial-executor.ts';
import {
  type FleetBacklogPasses,
  type FleetEventBacklog,
  SharedFleetBacklog,
} from '../../../../src/lib/session/events/index.ts';

/**
 * Live feeds opening together, seen from the domain.
 *
 * WHY THIS EXISTS. On 2026-10-30 every phone and browser reconnect queued its own full survey of the
 * fleet behind the storage's exclusive lock, faster than the passes drained, and every session write —
 * launch, resume, `fy signal` — waited 6 to 11 minutes behind them. These cases pin the three properties
 * that stop that: feeds that open while a pass is queued SHARE it, a feed that has left is neither waited
 * for nor surveyed for, and a session write waits for at most the pass that is already running.
 */

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

function backlogFor(limit: number): FleetEventBacklog {
  return { sessionIds: [`limit-${limit}`], events: [] };
}

/** A pass that reaches the lock only when its turn's gate is opened, recording what it was asked. */
class GatedPasses implements FleetBacklogPasses {
  readonly gates: Gate[] = [];
  readonly asked: number[] = [];
  readonly surveyed: number[] = [];
  readonly skipped: number[] = [];
  failure: Error | undefined;

  async fleetBacklog(limit: number, claim: () => boolean): Promise<FleetEventBacklog | undefined> {
    const turn = gate();
    this.gates.push(turn);
    this.asked.push(limit);
    await turn.promise;
    if (this.failure !== undefined) throw this.failure;
    if (!claim()) {
      this.skipped.push(limit);
      return undefined;
    }
    this.surveyed.push(limit);
    return backlogFor(limit);
  }
}

/** Let queued promise work run until `done` holds, within a bound that names what never happened. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 100 && !done(); turn += 1) await Promise.resolve();
  if (!done()) throw new Error(`never happened: ${what}`);
}

async function settledError(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('SharedFleetBacklog', () => {
  it('shares one queued pass between every feed that opens before it starts', async () => {
    // Arrange
    const passes = new GatedPasses();
    const subject = new SharedFleetBacklog(passes);

    // Act — twenty feeds open while the first pass is still queued.
    const readers = Array.from({ length: 20 }, () => subject.backlog(5_000, new AbortController().signal));
    passes.gates[0]?.open();
    const answers = await Promise.all(readers);

    // Assert
    should(passes.asked).deepEqual([5_000]);
    should(passes.surveyed).deepEqual([5_000]);
    should(answers.every(answer => answer === answers[0])).be.true();
    should(answers[0]).deepEqual(backlogFor(5_000));
  });

  it('queues a fresh pass for a feed that opens after the shared one started', async () => {
    // Arrange — the running pass may have read its tail before this feed subscribed, so joining it
    // could lose the events in between.
    const passes = new GatedPasses();
    const subject = new SharedFleetBacklog(passes);
    const first = subject.backlog(5_000, new AbortController().signal);
    passes.gates[0]?.open();
    await first;

    // Act
    const second = subject.backlog(5_000, new AbortController().signal);
    passes.gates[1]?.open();

    // Assert
    should(await second).deepEqual(backlogFor(5_000));
    should(passes.asked).deepEqual([5_000, 5_000]);
  });

  it('never shares a pass between different tail bounds', async () => {
    // Arrange
    const passes = new GatedPasses();
    const subject = new SharedFleetBacklog(passes);

    // Act
    const full = subject.backlog(5_000, new AbortController().signal);
    const none = subject.backlog(0, new AbortController().signal);
    for (const turn of passes.gates) turn.open();

    // Assert
    should(await full).deepEqual(backlogFor(5_000));
    should(await none).deepEqual(backlogFor(0));
    should(passes.asked).deepEqual([5_000, 0]);
  });

  it('skips a queued pass whose every feed has already closed', async () => {
    // Arrange
    const passes = new GatedPasses();
    const subject = new SharedFleetBacklog(passes);
    const feeds = [new AbortController(), new AbortController()];
    const readers = feeds.map(feed => subject.backlog(5_000, feed.signal));

    // Act — both sockets close before the pass reaches the lock.
    for (const feed of feeds) feed.abort(new Error('event stream closed'));
    const errors = await Promise.all(readers.map(settledError));
    passes.gates[0]?.open();
    await until(() => passes.skipped.length === 1, 'the abandoned pass reached the lock');

    // Assert — each closed feed stopped waiting at once, and the pass surveyed nothing for nobody.
    should(errors.map(error => String(error))).deepEqual(['Error: event stream closed', 'Error: event stream closed']);
    should(passes.surveyed).deepEqual([]);
    should(passes.skipped).deepEqual([5_000]);
  });

  it('still runs a shared pass for the feeds that stayed', async () => {
    // Arrange
    const passes = new GatedPasses();
    const subject = new SharedFleetBacklog(passes);
    const gone = new AbortController();
    const leaving = subject.backlog(5_000, gone.signal);
    const staying = subject.backlog(5_000, new AbortController().signal);

    // Act
    gone.abort(new Error('event stream closed'));
    passes.gates[0]?.open();

    // Assert
    should(String(await settledError(leaving))).equal('Error: event stream closed');
    should(await staying).deepEqual(backlogFor(5_000));
    should(passes.surveyed).deepEqual([5_000]);
  });

  it('refuses a feed that closed before it asked, without queueing anything', async () => {
    // Arrange
    const passes = new GatedPasses();
    const subject = new SharedFleetBacklog(passes);
    const feed = new AbortController();
    feed.abort(new Error('event stream closed'));

    // Act
    const error = await settledError(subject.backlog(5_000, feed.signal));

    // Assert
    should(String(error)).equal('Error: event stream closed');
    should(passes.asked).deepEqual([]);
  });

  it('fails every feed sharing a pass that failed, and lets the next feed start afresh', async () => {
    // Arrange
    const passes = new GatedPasses();
    const subject = new SharedFleetBacklog(passes);
    passes.failure = new Error('event index for alpha does not completely represent its durable journal');
    const readers = [1, 2].map(() => subject.backlog(5_000, new AbortController().signal));

    // Act
    passes.gates[0]?.open();
    const errors = await Promise.all(readers.map(settledError));
    passes.failure = undefined;
    const retry = subject.backlog(5_000, new AbortController().signal);
    passes.gates[1]?.open();

    // Assert — a refused proof is never served as a smaller, healthy-looking fleet.
    should(errors.map(error => String(error))).deepEqual([
      'Error: event index for alpha does not completely represent its durable journal',
      'Error: event index for alpha does not completely represent its durable journal',
    ]);
    should(await retry).deepEqual(backlogFor(5_000));
  });

  it('lets a session write through after at most the pass already running, however many feeds open', async () => {
    // Arrange — the storage's own executor: backlog passes yield while they wait, writes run per session.
    const serial = new KeyedSerialExecutor();
    const order: string[] = [];
    const surveys: Gate[] = [];
    const passes: FleetBacklogPasses = {
      fleetBacklog: async (limit, claim) =>
        await serial.runExclusiveYielding(async () => {
          if (!claim()) return undefined;
          const survey = gate();
          surveys.push(survey);
          order.push(`survey ${surveys.length} started`);
          await survey.promise;
          order.push(`survey ${surveys.length} finished`);
          return backlogFor(limit);
        }),
    };
    const subject = new SharedFleetBacklog(passes);
    const firstFeed = subject.backlog(5_000, new AbortController().signal);
    await until(() => surveys.length === 1, 'the first survey started');

    // Act — twenty feeds reopen while the first survey runs, then a resume records its session.
    const reopened = Array.from({ length: 20 }, () => subject.backlog(5_000, new AbortController().signal));
    const write = serial.run('session-1', async () => {
      order.push('write');
    });
    surveys[0]?.open();
    await write;
    await until(() => surveys.length === 2, 'the shared survey started');
    surveys[1]?.open();
    const answers = await Promise.all([firstFeed, ...reopened]);

    // Assert — the write waited for the one survey that was running, not for twenty more queued behind
    // it; the twenty reopened feeds shared one survey; nothing ran twice.
    should(order).deepEqual([
      'survey 1 started',
      'survey 1 finished',
      'write',
      'survey 2 started',
      'survey 2 finished',
    ]);
    should(answers).have.length(21);
    should(surveys).have.length(2);
  });
});
