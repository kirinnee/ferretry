/**
 * CODEX DISCOVERY AS A HOUSEKEEPING JOB, AND THE WATCH ON THE HOME (docs/design/housekeeping-worker.md §2.1).
 *
 * The walk is a `codex.discover` job; main keeps the listing-change count the pacer reads, and watches the
 * directories each answer names, so the pacer can tell a quiet home from one that moved.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { HousekeepingCodexRollouts } from '../../../src/adapters/housekeeping/codex-rollout-jobs.ts';
import type { FileSubscription } from '../../../src/lib/file-events/hub.ts';
import type { HousekeepingJobs } from '../../../src/lib/housekeeping/ports.ts';
import type { CodexDiscovery, HousekeepingJob } from '../../../src/lib/housekeeping/protocol.ts';

const HOME = '/home/agent/.codex';
const ROOT = `${HOME}/sessions`;

/** Jobs that answer each walk from a script, recording what they were sent. */
const scripted = (answers: CodexDiscovery[]) => {
  const sent: HousekeepingJob[] = [];
  const jobs = {
    run: async (job: HousekeepingJob) => {
      sent.push(job);
      const answer = answers.shift();
      if (answer === undefined) throw new Error('no walk was scripted');
      return answer;
    },
  } as HousekeepingJobs;
  return { sent, jobs };
};

/** A hub stand-in: each directory's watch, its listener, whether it is live, and whether it was closed. */
const hub = () => {
  const watches = new Map<string, { listener: () => void; live: boolean; closed: boolean }>();
  return {
    watches,
    watch: (directory: string, listener: () => void): FileSubscription => {
      const entry = { listener, live: true, closed: false };
      watches.set(directory, entry);
      return {
        live: () => entry.live && !entry.closed,
        close: () => {
          entry.closed = true;
        },
      };
    },
    open: () => [...watches.entries()].filter(([, entry]) => !entry.closed).map(([directory]) => directory),
  };
};

const walk = (frontier: readonly string[], changed = 0): CodexDiscovery => ({
  candidates: [{ id: 'rollout-new', file: `${ROOT}/2026/10/22/new.jsonl`, correlated: false }],
  changed,
  frontier,
});

describe('HousekeepingCodexRollouts', () => {
  it('should send the walk as a job naming the home, the token and the baseline, and answer its candidates', async () => {
    // Arrange
    const { sent, jobs } = scripted([walk([ROOT])]);
    const subject = new HousekeepingCodexRollouts({ jobs: () => jobs, watch: hub().watch });

    // Act
    const candidates = await subject.candidates(HOME, '/state/sessions/session-1', new Set(['old-1', 'old-2']));

    // Assert
    should(sent).eql([
      { kind: 'codex.discover', home: HOME, correlationToken: '/state/sessions/session-1', skip: ['old-1', 'old-2'] },
    ]);
    should(candidates.map(candidate => candidate.id)).eql(['rollout-new']);
  });

  it('should skip nothing when asked with no baseline', async () => {
    // Arrange
    const { sent, jobs } = scripted([walk([ROOT])]);
    const subject = new HousekeepingCodexRollouts({ jobs: () => jobs, watch: hub().watch });

    // Act
    await subject.candidates(HOME, 'token');

    // Assert
    should(sent[0]).have.property('skip').which.eql([]);
  });

  it('should read the jobs at each walk, so the worker can be wired after the index exists', async () => {
    // Arrange
    const first = scripted([walk([ROOT])]);
    const second = scripted([walk([ROOT])]);
    let current = first.jobs;
    const subject = new HousekeepingCodexRollouts({ jobs: () => current, watch: hub().watch });
    await subject.candidates(HOME, 'token');

    // Act
    current = second.jobs;
    await subject.candidates(HOME, 'token');

    // Assert
    should([first.sent.length, second.sent.length]).eql([1, 1]);
  });

  it('should count the listing changes every walk of a home reported', async () => {
    // Arrange
    const { jobs } = scripted([walk([ROOT], 1), walk([ROOT], 0), walk([ROOT], 2)]);
    const subject = new HousekeepingCodexRollouts({ jobs: () => jobs, watch: hub().watch });
    const before = subject.changes(HOME);

    // Act
    for (let walks = 0; walks < 3; walks += 1) await subject.candidates(HOME, 'token');

    // Assert
    should(before).equal(0);
    should(subject.changes(HOME)).equal(3);
    should(subject.changes('/elsewhere')).equal(0);
  });

  it('should know nothing heard of a home before a walk has named what to watch', () => {
    // Arrange
    const subject = new HousekeepingCodexRollouts({ jobs: () => scripted([]).jobs, watch: hub().watch });

    // Act
    const heard = subject.heard(HOME);

    // Assert
    should(heard).be.undefined();
  });

  it('should watch the frontier a walk names, and count each new watch and each event as heard', async () => {
    // Arrange
    const files = hub();
    const frontier = [ROOT, `${ROOT}/2026`, `${ROOT}/2026/10`, `${ROOT}/2026/10/21`, `${ROOT}/2026/10/22`];
    const { jobs } = scripted([walk(frontier), walk(frontier)]);
    const subject = new HousekeepingCodexRollouts({ jobs: () => jobs, watch: files.watch });
    await subject.candidates(HOME, 'token');
    const afterTheFirstWalk = subject.heard(HOME);
    await subject.candidates(HOME, 'token');
    const unchanged = subject.heard(HOME);

    // Act: a rollout is created in today's directory.
    files.watches.get(`${ROOT}/2026/10/22`)?.listener();

    // Assert: the watches opened count once, the same frontier again not at all, the event once.
    should(files.open()).eql(frontier);
    should(afterTheFirstWalk).equal(1);
    should(unchanged).equal(1);
    should(subject.heard(HOME)).equal(2);
  });

  it('should move its watches with the frontier, closing the day that left it', async () => {
    // Arrange: midnight passes, and a new day directory appears.
    const files = hub();
    const { jobs } = scripted([
      walk([ROOT, `${ROOT}/2026`, `${ROOT}/2026/10`, `${ROOT}/2026/10/21`, `${ROOT}/2026/10/22`]),
      walk([ROOT, `${ROOT}/2026`, `${ROOT}/2026/10`, `${ROOT}/2026/10/22`, `${ROOT}/2026/10/23`]),
    ]);
    const subject = new HousekeepingCodexRollouts({ jobs: () => jobs, watch: files.watch });
    await subject.candidates(HOME, 'token');

    // Act
    await subject.candidates(HOME, 'token');

    // Assert: the new day is heard from now on, and the watch it replaced counts as an event.
    should(files.open()).eql([ROOT, `${ROOT}/2026`, `${ROOT}/2026/10`, `${ROOT}/2026/10/22`, `${ROOT}/2026/10/23`]);
    should(files.watches.get(`${ROOT}/2026/10/21`)?.closed).be.true();
    should(subject.heard(HOME)).equal(2);
  });

  it('should vouch for nothing while any watched directory is not live', async () => {
    // Arrange: the hub falls back to polling one of the directories.
    const files = hub();
    const { jobs } = scripted([walk([ROOT, `${ROOT}/2026`])]);
    const subject = new HousekeepingCodexRollouts({ jobs: () => jobs, watch: files.watch });
    await subject.candidates(HOME, 'token');

    // Act
    const entry = files.watches.get(`${ROOT}/2026`);
    if (entry !== undefined) entry.live = false;

    // Assert
    should(subject.heard(HOME)).be.undefined();
  });

  it('should stop every watch when closed, and know nothing heard after', async () => {
    // Arrange
    const files = hub();
    const { jobs } = scripted([walk([ROOT, `${ROOT}/2026`])]);
    const subject = new HousekeepingCodexRollouts({ jobs: () => jobs, watch: files.watch });
    await subject.candidates(HOME, 'token');

    // Act
    subject.close();

    // Assert
    should(files.open()).eql([]);
    should(subject.heard(HOME)).be.undefined();
    should(subject.changes(HOME)).equal(0);
  });

  it('should let a refused walk fail the discovery, and watch nothing for it', async () => {
    // Arrange: the worker could not finish the job.
    const files = hub();
    const subject = new HousekeepingCodexRollouts({
      jobs: () =>
        ({
          run: async () => {
            throw new Error('the housekeeping worker could not finish a job (internal)');
          },
        }) as HousekeepingJobs,
      watch: files.watch,
    });

    // Act
    const refused = await subject.candidates(HOME, 'token').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(refused).be.instanceOf(Error);
    should(files.open()).eql([]);
  });
});
