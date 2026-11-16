import { describe, it } from 'bun:test';
import { JobRunner } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import { milliseconds } from '@ferretry/std';
import should from 'should';
import {
  FerretHistoryFiles,
  HealthEventSchema,
  HealthEventsFile,
  SelfRestartFile,
} from '../../../../../contract/index.ts';
import { buildHealth, buildHealthJob, HEALTH_JOB } from '../../../../../daemon/modules/health.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import {
  memoryStorage,
  RecordingLog,
  SESSION_STORE_FILES,
  sessionState,
  T0,
} from '../../../../support/daemon/storage.ts';

/**
 * The self-check as the kernel's REAL job runner drives it (J-0032, J-0118). The runner COALESCES: a fire while a run is
 * still going sets a flag and never calls `run`, and re-fires the moment the slow run ends. So a job whose `run` awaits
 * the whole check never lets the service see an interval that passes while a check is running: it could neither skip
 * (J-0118: "skips — never overlaps") nor measure a check that never finishes, and a check slower than the wedge gap
 * was followed by a back-to-back re-fire that read the whole slow run as a gap and called it a wedge.
 */

const INTERVAL_MS = 60_000;
const WEDGE_GAP_MS = 180_000;
const STOP_WAIT_MS = 5_000;
const START_MS = Date.parse(T0);

/** Lets the memory storage, the state port and the job runner's own promise hops all run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 25; turn += 1) await Bun.sleep(0);
}

async function world() {
  const clock = fixedClock(T0);
  const opened = await memoryStorage();
  const port = opened.folder.port([HealthEventsFile, SelfRestartFile]);
  // The survey is the check's one slow read: held, it is a check that has not finished.
  let gate: Promise<void> | undefined;
  let release = (): void => {};
  const hold = (): void => {
    gate = new Promise<void>(resolve => {
      release = resolve;
    });
  };
  const storage = {
    listSessions: () => opened.storage.listSessions(),
    reconcile: opened.storage.reconcile.bind(opened.storage),
    sessionIdsOnDisk: opened.storage.sessionIdsOnDisk.bind(opened.storage),
    readState: opened.storage.readState.bind(opened.storage),
    lastEventAt: opened.storage.lastEventAt.bind(opened.storage),
    surveySessionDirectories: async () => {
      await gate;
      return await opened.storage.surveySessionDirectories();
    },
  };
  const warnings: string[] = [];
  const health = buildHealth({
    state: port,
    storage: storage as never,
    clock: { now: () => clock.now(), nowMs: () => clock.nowMs() },
    monotonic: { elapsedMs: () => clock.nowMs() - START_MS },
    loop: { blockedMs: () => 0 },
    version: '5.0.0',
    bootstrap: { finished: () => true, errors: () => [] },
    log: { warn: message => void warnings.push(message) },
  });
  const job = buildHealthJob({
    health,
    storeLoaded: Promise.resolve(),
    after: (delayMs, fire) => clock.after(milliseconds(delayMs), fire),
    stopWaitMs: STOP_WAIT_MS,
  });
  const jobs = new JobRunner(clock, new RecordingLog());
  jobs.portFor('ferrets').add({
    id: HEALTH_JOB,
    schedule: { every: milliseconds(INTERVAL_MS) },
    run: job.run,
  });
  const events = async () => (await port.records(HealthEventsFile)).records.map(line => HealthEventSchema.parse(line));
  const wedges = async () => (await events()).filter(line => line.type === 'fleet.daemon_wedge');
  /** One interval: the clock moves, the timer fires, and whatever that sets going runs. */
  const interval = async (): Promise<void> => {
    await clock.advance(INTERVAL_MS);
    await settle();
  };
  return { clock, opened, health, job, jobs, events, wedges, interval, hold, release: () => release(), warnings };
}

describe('the self-check job under the kernel job runner', () => {
  it('should write exactly one daemon_wedge, and record the skips, for a check held open across five intervals', async () => {
    // Arrange
    const w = await world();
    w.hold();
    w.jobs.start();
    await settle();

    // Act — the first check starts and never finishes; five more timer fires pass over it.
    for (let n = 0; n < 5; n += 1) await w.interval();

    // Assert — the service saw every interval: only a skip can measure a check that never finishes, and it did, once.
    // One check ran (a skip is not a check), and it is the one still held.
    const wedges = await w.wedges();
    should(wedges.length).equal(1);
    should(wedges[0]?.data).match({ gapSeconds: WEDGE_GAP_MS / 1000 });
    const report = await w.health.service.report();
    should(report.selfChecks).equal(1);
    should(report.wedgeCount).equal(1);

    w.release();
    await w.jobs.stop();
    await w.job.stop();
  });

  it('should not read the end of a slow check as a wedge: the next check after it is fresh, and writes no second wedge', async () => {
    // Arrange — a check that outlives the wedge gap, so one wedge is measured while it runs.
    const w = await world();
    w.hold();
    w.jobs.start();
    await settle();
    for (let n = 0; n < 4; n += 1) await w.interval();
    should((await w.wedges()).length).equal(1);

    // Act — it finishes, and the timer fires on time.
    w.release();
    await settle();
    await w.interval();

    // Assert
    should((await w.wedges()).length).equal(1);
    const report = await w.health.service.report();
    should(report.selfCheckFreshness).equal('fresh');
    should(report.wedgeCount).equal(1);

    await w.jobs.stop();
    await w.job.stop();
  });

  it('should not re-fire back to back when a slow check ends: no check starts until the next interval', async () => {
    // Arrange
    const w = await world();
    w.hold();
    w.jobs.start();
    await settle();
    for (let n = 0; n < 2; n += 1) await w.interval();
    const before = (await w.health.service.report()).selfChecks;

    // Act — the slow check ends between two timer fires.
    w.release();
    await settle();

    // Assert — nothing was fired by the end of it.
    should((await w.health.service.report()).selfChecks).equal(before);

    await w.jobs.stop();
    await w.job.stop();
  });
});

describe('stopping the daemon with a self-check in flight', () => {
  it('should wait for the check, so what it was writing is written, and leave no timer', async () => {
    // Arrange — a check that will write a line, held open.
    const w = await world();
    const session = parseSessionId('gone');
    await w.opened.storage.writeState(session, sessionState('gone'));
    await w.opened.storage.append(session, 'first', {});
    await w.opened.folder.port(SESSION_STORE_FILES).remove(FerretHistoryFiles, 'gone');
    w.hold();
    w.jobs.start();
    await settle();
    await w.jobs.stop();

    // Act
    let stopped = false;
    const stopping = w.job.stop().then(() => {
      stopped = true;
    });
    await settle();
    const whileHeld = stopped;
    w.release();
    await stopping;

    // Assert
    should(whileHeld).be.false();
    should((await w.events()).map(line => line.type)).deepEqual(['fleet.index_incoherent']);
    should(w.clock.pending()).equal(0);
  });

  it('should give up on a check that never finishes after the bound, without throwing and without a timer left', async () => {
    // Arrange
    const w = await world();
    w.hold();
    w.jobs.start();
    await settle();
    await w.jobs.stop();

    // Act
    const stopping = w.job.stop();
    await w.clock.advance(STOP_WAIT_MS);
    await settle();

    // Assert
    await should(stopping).be.fulfilled();
    should(w.clock.pending()).equal(0);
    should(w.warnings).deepEqual([]);

    w.release();
    await settle();
  });

  it('should start no check once it has been stopped', async () => {
    // Arrange
    const w = await world();
    await w.job.stop();

    // Act
    await w.job.run(new AbortController().signal);
    await settle();

    // Assert
    should((await w.health.service.report()).selfChecks).equal(0);
  });
});
