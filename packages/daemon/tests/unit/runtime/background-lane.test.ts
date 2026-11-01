import { describe, it } from 'bun:test';
import should from 'should';
import {
  BACKGROUND_DELAY_VARIABLE,
  BackgroundLane,
  DEFAULT_BACKGROUND_DELAY_MS,
  parseBackgroundDelay,
} from '../../../src/lib/runtime/background-lane.ts';
import { ActivityLedger } from '../../../src/lib/runtime/liveness.ts';

const clock = { now: () => 0 };

/** A job a test settles by hand, recording when it started. */
function manualJob(log: string[], name: string) {
  let settle: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const work = () =>
    new Promise<void>((resolve, reject) => {
      log.push(`start ${name}`);
      settle = () => {
        log.push(`end ${name}`);
        resolve();
      };
      fail = reject;
    });
  return { work, settle: () => settle(), fail: (error: Error) => fail(error) };
}

/** Lets every pending promise and yield run. */
const flush = async () => {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
};

describe('BackgroundLane', () => {
  it('should hold every job until it is opened', async () => {
    // Arrange
    const log: string[] = [];
    const lane = new BackgroundLane(new ActivityLedger(clock), async () => undefined);
    const job = manualJob(log, 'analytics ingest');

    // Act
    lane.submit('analytics ingest', job.work);
    await flush();
    const before = [...log];
    lane.open();
    await flush();

    // Assert
    should(before).deepEqual([]);
    should(log).deepEqual(['start analytics ingest']);
    should(lane.isOpen).be.true();
  });

  it('should run one job at a time, in the order they were submitted, yielding between them', async () => {
    // Arrange
    const log: string[] = [];
    const lane = new BackgroundLane(new ActivityLedger(clock), async () => {
      log.push('yield');
    });
    const fleet = manualJob(log, 'fleet refresh');
    const reaper = manualJob(log, 'terminal reaper');
    lane.open();

    // Act
    lane.submit('fleet refresh', fleet.work);
    lane.submit('terminal reaper', reaper.work);
    await flush();
    const whileFirstRuns = [...log];
    fleet.settle();
    await flush();
    reaper.settle();
    await flush();

    // Assert
    should(whileFirstRuns).deepEqual(['start fleet refresh']);
    should(log).deepEqual([
      'start fleet refresh',
      'end fleet refresh',
      'yield',
      'start terminal reaper',
      'end terminal reaper',
      'yield',
    ]);
  });

  it('should not queue a second copy of a job that is still waiting', async () => {
    // Arrange
    const log: string[] = [];
    const lane = new BackgroundLane(new ActivityLedger(clock), async () => undefined);

    // Act
    lane.submit('terminal reaper', manualJob(log, 'first').work);
    lane.submit('terminal reaper', manualJob(log, 'second').work);
    lane.submit('analytics ingest', manualJob(log, 'third').work);

    // Assert
    should(lane.waiting()).deepEqual(['terminal reaper', 'analytics ingest']);
  });

  it('should carry on past a job that fails, and name each job as an activity while it runs', async () => {
    // Arrange
    const log: string[] = [];
    const ledger = new ActivityLedger(clock);
    const lane = new BackgroundLane(ledger, async () => undefined);
    const failing = manualJob(log, 'fleet sweep');
    const next = manualJob(log, 'fleet refresh');
    lane.open();
    lane.submit('fleet sweep', failing.work);
    lane.submit('fleet refresh', next.work);
    await flush();
    const running = ledger.inFlight();

    // Act
    failing.fail(new Error('no feed'));
    await flush();

    // Assert
    should(running).deepEqual(['fleet sweep']);
    should(log).deepEqual(['start fleet sweep', 'start fleet refresh']);
  });

  it('should drop waiting jobs and accept no more once closed', async () => {
    // Arrange
    const log: string[] = [];
    const lane = new BackgroundLane(new ActivityLedger(clock), async () => undefined);
    lane.submit('analytics ingest', manualJob(log, 'waiting').work);

    // Act
    lane.close();
    lane.submit('fleet refresh', manualJob(log, 'late').work);
    lane.open();
    await flush();

    // Assert
    should(lane.waiting()).deepEqual([]);
    should(lane.isOpen).be.false();
    should(log).deepEqual([]);
  });
});

describe('parseBackgroundDelay', () => {
  it('should default to two minutes, take whole seconds, and refuse anything else by name', () => {
    // Act / Assert
    should(parseBackgroundDelay(undefined)).equal(DEFAULT_BACKGROUND_DELAY_MS);
    should(parseBackgroundDelay(' ')).equal(120_000);
    should(parseBackgroundDelay('0')).equal(0);
    should(parseBackgroundDelay('30')).equal(30_000);
    should(() => parseBackgroundDelay('2m')).throw(
      `${BACKGROUND_DELAY_VARIABLE} must be a whole number of seconds: 2m`,
    );
  });
});
