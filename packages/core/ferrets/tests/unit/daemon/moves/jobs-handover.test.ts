import { describe, it } from 'bun:test';
import should from 'should';
import type { KeptJob } from '../../../../contract/job-keeping.ts';
import { detachAttachments } from '../../../../daemon/lib/moves/detach-attachments.ts';
import { assembleInflightReport, type ProcessInfo } from '../../../../daemon/lib/moves/inflight-report.ts';
import {
  backstopMessage,
  jobsHandover,
  runJobBackstop,
  toldAbout,
  withJobsSection,
} from '../../../../daemon/lib/moves/jobs-handover.ts';

const NOW = Date.parse('2026-11-16T01:00:00.000Z');
const job = (over: Partial<KeptJob> & Pick<KeptJob, 'id' | 'name' | 'state'>): KeptJob => ({
  startedAt: '2026-11-16T00:00:00.000Z',
  unreported: false,
  ...over,
});
const quiet = assembleInflightReport({
  status: 'running',
  turn: 1,
  openTools: [],
  processes: { kind: 'observed', processes: [] },
  codexBackgroundTerminals: 0,
});
const stopped: ProcessInfo = {
  pid: 9,
  argv: 'bash /tmp/merge-all.sh 765',
  startedSecondsAgo: 60,
  verdict: 'unknown',
  unkeptJob: true,
};

describe('the "Your jobs" section of the hand-over', () => {
  it('should say nothing when the ferret has no running job and none that ended unseen', () => {
    const jobs = [job({ id: 'a1', name: 'old', state: 'exited', exitCode: 0, unreported: false })];
    should(jobsHandover(jobs, quiet, NOW)).be.undefined();
    should(jobsHandover([], quiet, NOW)).be.undefined();
  });

  it('should list a running job with its name, id, age and the exact re-attach line', () => {
    // Act
    const text = jobsHandover([job({ id: 'abc123abc123', name: 'build', state: 'running' })], quiet, NOW);

    // Assert
    should(text).equal(
      [
        'Your jobs',
        '',
        'Ferretry kept these background jobs running through the move:',
        '- `build` (id abc123abc123, running 60m): re-attach: run `fy job attach abc123abc123` as a background Bash',
      ].join('\n'),
    );
  });

  it('should list a job that ended unseen with its exit code and where to read the log, and not one already seen', () => {
    // Arrange
    const jobs = [
      job({ id: 'bbb', name: 'tests', state: 'exited', exitCode: 3, unreported: true }),
      job({ id: 'ccc', name: 'lint', state: 'exited', exitCode: 0, unreported: false }),
      job({ id: 'ddd', name: 'gone', state: 'lost', unreported: true }),
    ];

    // Act
    const text = jobsHandover(jobs, quiet, NOW) ?? '';

    // Assert
    should(text).containEql('These background jobs finished since you last saw them:');
    should(text).not.containEql('kept these background jobs');
    should(text).not.match(/nothing was stopped/iu);
    should(text).containEql('- `tests` (id bbb) ended with exit code 3; `fy job logs bbb`');
    should(text).containEql('- `gone` (id ddd) ended without an exit record');
    should(text).not.containEql('lint');
    should(toldAbout(jobs)).deepEqual(['bbb', 'ddd']);
  });

  it('should list the un-kept jobs the move stopped, each with how to run it again, inside the section', () => {
    // Arrange
    const subject = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: { kind: 'observed', processes: [stopped] },
      codexBackgroundTerminals: 0,
    });

    // Act
    const text = jobsHandover([job({ id: 'abc', name: 'build', state: 'running' })], subject, NOW) ?? '';

    // Assert
    should(text).containEql('The move stopped these background jobs, which Ferretry was not keeping:');
    should(text).not.containEql('nothing was stopped');
    should(text).not.containEql('Nothing was stopped');
    should(text).containEql('- `bash /tmp/merge-all.sh 765`: re-run it with `fy job run …` if you still need it');
  });

  it('should not list a command that may only be a foreground call as a stopped background job', () => {
    const maybe: ProcessInfo = { ...stopped, unkeptJob: undefined, agentCommand: true };
    const subject = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: { kind: 'observed', processes: [maybe] },
      codexBackgroundTerminals: 0,
    });
    const text = jobsHandover([job({ id: 'abc', name: 'build', state: 'running' })], subject, NOW) ?? '';
    should(text).not.containEql('merge-all');
    should(text).not.match(/nothing was stopped/iu);
  });

  it('should make no "nothing was stopped" claim when a foreground command or an unnamed process was stopped', () => {
    // Arrange — a restart stopped a foreground `sleep 299` (an agent command, not a known background job) and a process nobody recognised.
    const foreground: ProcessInfo = { ...stopped, argv: 'sleep 299', unkeptJob: undefined, agentCommand: true };
    const unnamed: ProcessInfo = { ...stopped, argv: 'mystery --serve', unkeptJob: undefined, agentCommand: undefined };
    const subject = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: { kind: 'observed', processes: [foreground, unnamed] },
      codexBackgroundTerminals: 0,
    });

    // Act
    const text = jobsHandover([job({ id: 'abc', name: 'build', state: 'running' })], subject, NOW) ?? '';

    // Assert
    should(text).not.match(/nothing was stopped/iu);
    should(text).not.containEql('The move stopped these background jobs');
    should(text).not.containEql('sleep 299');
  });

  it('should say what each combination of subsections holds, and never contradict itself', () => {
    const running = job({ id: 'r1', name: 'build', state: 'running' });
    const done = job({ id: 'd1', name: 'tests', state: 'exited', exitCode: 0, unreported: true });
    const withStopped = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: { kind: 'observed', processes: [stopped] },
      codexBackgroundTerminals: 0,
    });
    const cases = [
      { jobs: [running], report: quiet, kept: true, finished: false, stopped: false },
      { jobs: [done], report: quiet, kept: false, finished: true, stopped: false },
      { jobs: [running, done], report: quiet, kept: true, finished: true, stopped: false },
      { jobs: [running], report: withStopped, kept: true, finished: false, stopped: true },
      { jobs: [done], report: withStopped, kept: false, finished: true, stopped: true },
      { jobs: [running, done], report: withStopped, kept: true, finished: true, stopped: true },
    ];
    for (const one of cases) {
      const text = jobsHandover(one.jobs, one.report, NOW) ?? '';
      should(text.includes('kept these background jobs running through the move')).equal(one.kept);
      should(text.includes('finished since you last saw them')).equal(one.finished);
      should(text.includes('The move stopped these background jobs')).equal(one.stopped);
      // Nothing here ever claims "nothing was stopped": the restart notice owns the account of what the move stopped.
      should(/nothing was stopped/iu.test(text)).equal(false);
    }
  });

  it('should list the Codex terminals the tree does not show, singular or plural, in the stopped list', () => {
    const codex = (count: number) =>
      assembleInflightReport({
        status: 'running',
        turn: 1,
        openTools: [],
        processes: { kind: 'observed', processes: [] },
        codexBackgroundTerminals: count,
      });
    const running = [job({ id: 'abc', name: 'build', state: 'running' })];
    should(jobsHandover(running, codex(1), NOW)).containEql(
      "- 1 background terminal of Codex's (Ferretry could not see the commands): re-run it",
    );
    should(jobsHandover(running, codex(2), NOW)).containEql('- 2 background terminals of Codex');
  });

  it('should not create a section just to mention an un-kept job', () => {
    const subject = assembleInflightReport({
      status: 'running',
      turn: 1,
      openTools: [],
      processes: { kind: 'observed', processes: [stopped] },
      codexBackgroundTerminals: 0,
    });
    should(jobsHandover([], subject, NOW)).be.undefined();
  });

  it('should ride after the restart notice as one message, or alone', () => {
    should(withJobsSection('Ferretry restarted you.', 'Your jobs')).equal('Ferretry restarted you.\n\nYour jobs');
    should(withJobsSection(undefined, 'Your jobs')).equal('Your jobs');
    should(withJobsSection('Ferretry restarted you.', undefined)).equal('Ferretry restarted you.');
  });
});

describe('detaching the attachments before the pane is killed', () => {
  // The keeper's bound is measured on the same sleep: it is told apart by its (huge) length, and settles a macrotask late.
  const BOUND = 999_999;
  // A clock the sleeps drive: time passes only as the code sleeps (or as a slow keeper "takes" it).
  const io = (slept: number[] = [], clock = { now: 0 }) => ({
    timeoutMs: BOUND,
    nowMs: () => clock.now,
    sleep: async (ms: number) => {
      if (ms !== BOUND) {
        slept.push(ms);
        clock.now += ms;
      }
      await new Promise<void>(done => setTimeout(done, 0));
    },
    log: { warn: () => undefined },
  });

  it('should ask once and return as soon as the attachments are gone', async () => {
    // Arrange
    let live = 2;
    let asked = 0;
    const keeper = {
      attachments: async () => Array.from({ length: live }, (_, pid) => ({ pid, jobId: 'j', jobName: 'n' })),
      detach: async () => {
        asked += 1;
        live = 0;
        return 2;
      },
    };

    // Act
    const gone = await detachAttachments(keeper, 'ferret-a', io());

    // Assert
    should(gone).be.true();
    should(asked).equal(1);
  });

  it('should not ask when there is nothing attached', async () => {
    let asked = 0;
    const keeper = {
      attachments: async () => [],
      detach: async () => {
        asked += 1;
        return 0;
      },
    };
    should(await detachAttachments(keeper, 'ferret-a', io())).be.true();
    should(asked).equal(0);
  });

  it('should give up after its bound and let the move go ahead when an attachment will not leave', async () => {
    // Arrange
    const slept: number[] = [];
    const keeper = { attachments: async () => [{ pid: 1, jobId: 'j', jobName: 'n' }], detach: async () => 1 };

    // Act
    const gone = await detachAttachments(keeper, 'ferret-a', io(slept));

    // Assert
    should(gone).be.false();
    should(slept.reduce((sum, ms) => sum + ms, 0)).equal(4000);
  });

  it('should stay inside its total wait even when every keeper question is slow (not 16 polls of 5 s each)', async () => {
    // Arrange — each keeper answer "takes" 5 s of the clock and the attachment never leaves.
    const clock = { now: 0 };
    const calls: string[] = [];
    const slow = async <T>(value: T, what: string): Promise<T> => {
      calls.push(what);
      clock.now += 5_000;
      return value;
    };
    const keeper = {
      attachments: async () => await slow([{ pid: 1, jobId: 'j', jobName: 'n' }], 'attachments'),
      detach: async () => await slow(1, 'detach'),
    };

    // Act
    const gone = await detachAttachments(keeper, 'ferret-a', io([], clock));

    // Assert — the two questions already spent the 4 s total, so it stops there: no poll loop of 5 s answers (the old ~95 s)
    should(gone).be.false();
    should(calls).deepEqual(['attachments', 'detach']);
    should(clock.now).equal(10_000);
  });

  it('should never throw: a keeper that fails is logged and the move goes ahead', async () => {
    // Arrange
    const warnings: string[] = [];
    const keeper = {
      attachments: async () => {
        throw new Error('keeper down');
      },
      detach: async () => 0,
    };

    // Act
    const gone = await detachAttachments(keeper, 'ferret-a', {
      sleep: async () => undefined,
      nowMs: () => 0,
      log: { warn: message => void warnings.push(message) },
    });

    // Assert
    should(gone).be.false();
    should(warnings).have.length(1);
  });
});

describe('the completion backstop', () => {
  const ended = job({ id: 'abc123abc123', name: 'build', state: 'exited', exitCode: 2, unreported: true });

  it('should word the message as the owner asked, with one dedupe id per job', () => {
    should(backstopMessage(ended)).deepEqual({
      id: 'job-ended-abc123abc123',
      text: 'job build (abc123abc123) ended with 2; `fy job logs abc123abc123`',
    });
  });

  it('should queue ONE message per ended job and record it as told, so the next pass sends nothing', async () => {
    // Arrange
    const told = new Set<string>();
    const sent: { ferret: string; id: string }[] = [];
    const ports = {
      keeper: {
        backstopCutOver: async () => 0,
        endedUnattached: async () => (told.has(ended.id) ? [] : [{ ferret: 'ferret-a', job: ended }]),
        markReported: async (_ferret: string, ids: readonly string[]) => {
          for (const id of ids) told.add(id);
        },
      },
      askAgent: async (ferret: string, message: { id: string }) => {
        sent.push({ ferret, id: message.id });
        return true;
      },
      log: { warn: () => undefined },
    };

    // Act
    const first = await runJobBackstop(ports);
    const second = await runJobBackstop(ports);

    // Assert
    should(first).equal(1);
    should(second).equal(0);
    should(sent).deepEqual([{ ferret: 'ferret-a', id: 'job-ended-abc123abc123' }]);
  });

  it('should mark a job told even when the queue already held its message (a retry after a crash)', async () => {
    const marked: string[] = [];
    const queued = await runJobBackstop({
      keeper: {
        backstopCutOver: async () => 0,
        endedUnattached: async () => [{ ferret: 'ferret-a', job: ended }],
        markReported: async (_f, ids) => void marked.push(...ids),
      },
      askAgent: async () => false,
      log: { warn: () => undefined },
    });
    should(queued).equal(0);
    should(marked).deepEqual([ended.id]);
  });

  it('should stop quietly, marking nothing, while no queue is bound', async () => {
    const marked: string[] = [];
    const queued = await runJobBackstop({
      keeper: {
        backstopCutOver: async () => 0,
        endedUnattached: async () => [{ ferret: 'ferret-a', job: ended }],
        markReported: async (_f, ids) => void marked.push(...ids),
      },
      askAgent: async () => 'unavailable',
      log: { warn: () => undefined },
    });
    should(queued).equal(0);
    should(marked).deepEqual([]);
  });

  it('should skip a ferret that is not held quietly: nothing marked, nothing logged, the others still told', async () => {
    const warnings: string[] = [];
    const marked: string[] = [];
    const other = job({ id: 'zzz', name: 'lint', state: 'exited', exitCode: 0, unreported: true });
    const queued = await runJobBackstop({
      keeper: {
        backstopCutOver: async () => 0,
        endedUnattached: async () => [
          { ferret: 'ferret-a', job: ended },
          { ferret: 'ferret-b', job: other },
        ],
        markReported: async (_f, ids) => void marked.push(...ids),
      },
      askAgent: async ferret => (ferret === 'ferret-a' ? 'not-held' : true),
      log: { warn: message => void warnings.push(message) },
    });
    should(queued).equal(1);
    should(marked).deepEqual(['zzz']);
    should(warnings).deepEqual([]);
  });

  it('should treat jobs that ended before its first run as history: marked told, never messaged', async () => {
    const sent: string[] = [];
    const marked: string[] = [];
    const before = job({
      id: 'old',
      name: 'old',
      state: 'exited',
      exitCode: 0,
      unreported: true,
      endedAt: '2026-11-15T00:00:00.000Z',
    });
    const after = job({
      id: 'new',
      name: 'new',
      state: 'exited',
      exitCode: 0,
      unreported: true,
      endedAt: '2026-11-16T00:30:00.000Z',
    });
    const queued = await runJobBackstop({
      keeper: {
        backstopCutOver: async () => Date.parse('2026-11-16T00:00:00.000Z'),
        endedUnattached: async () => [
          { ferret: 'ferret-a', job: before },
          { ferret: 'ferret-a', job: after },
        ],
        markReported: async (_f, ids) => void marked.push(...ids),
      },
      askAgent: async (_f, message) => {
        sent.push(message.id);
        return true;
      },
      log: { warn: () => undefined },
    });
    should(queued).equal(1);
    should(sent).deepEqual(['job-ended-new']);
    should(marked).deepEqual(['old', 'new']);
  });

  it('should keep the cut-over across a daemon restart: a job that ended while the daemon was down is told, not history', async () => {
    // Arrange — the keeper's persisted cut-over is written by the very first call and returned unchanged afterwards, as a
    // restarted daemon (a fresh backstop with a later boot time) would find it.
    let persisted: number | undefined;
    let clock = Date.parse('2026-11-16T00:00:00.000Z');
    const keeperOf = (jobs: readonly KeptJob[], marked: string[]) => ({
      backstopCutOver: async () => (persisted ??= clock),
      endedUnattached: async () => jobs.map(one => ({ ferret: 'ferret-a', job: one })),
      markReported: async (_f: string, ids: readonly string[]) => void marked.push(...ids),
    });
    const old = job({
      id: 'old',
      name: 'old',
      state: 'exited',
      exitCode: 0,
      unreported: true,
      endedAt: '2026-11-15T23:00:00.000Z',
    });
    const sent: string[] = [];
    const ask = async (_f: string, message: { id: string }) => {
      sent.push(message.id);
      return true as const;
    };
    const log = { warn: () => undefined };

    // Act — the first run ever: the old job is history. The daemon is then down; a job ends; the daemon restarts an hour later.
    const firstMarked: string[] = [];
    await runJobBackstop({ keeper: keeperOf([old], firstMarked), askAgent: ask, log });
    const duringDowntime = job({
      id: 'down',
      name: 'down',
      state: 'exited',
      exitCode: 1,
      unreported: true,
      endedAt: '2026-11-16T00:20:00.000Z',
    });
    clock = Date.parse('2026-11-16T01:00:00.000Z');
    const secondMarked: string[] = [];
    const queued = await runJobBackstop({ keeper: keeperOf([duringDowntime], secondMarked), askAgent: ask, log });

    // Assert — the first run swallowed only the history; the restart still told the job that ended after the one-time cut-over
    should(firstMarked).deepEqual(['old']);
    should(sent).deepEqual(['job-ended-down']);
    should(queued).equal(1);
    should(secondMarked).deepEqual(['down']);
    should(persisted).equal(Date.parse('2026-11-16T00:00:00.000Z'));
  });

  it('should do nothing, and say so, while the keeper cannot give a cut-over (never treat every old job as news)', async () => {
    const warnings: string[] = [];
    const sent: string[] = [];
    const queued = await runJobBackstop({
      keeper: {
        backstopCutOver: async () => undefined,
        endedUnattached: async () => [{ ferret: 'ferret-a', job: ended }],
        markReported: async () => undefined,
      },
      askAgent: async (_f, message) => {
        sent.push(message.id);
        return true;
      },
      log: { warn: message => void warnings.push(message) },
    });
    should(queued).equal(0);
    should(sent).deepEqual([]);
    should(warnings).have.length(1);
  });

  it('should leave a job untold, and log, when its message cannot be queued', async () => {
    const warnings: string[] = [];
    const marked: string[] = [];
    await runJobBackstop({
      keeper: {
        backstopCutOver: async () => 0,
        endedUnattached: async () => [{ ferret: 'ferret-a', job: ended }],
        markReported: async (_f, ids) => void marked.push(...ids),
      },
      askAgent: async () => {
        throw new Error('queue full');
      },
      log: { warn: message => void warnings.push(message) },
    });
    should(marked).deepEqual([]);
    should(warnings).have.length(1);
  });
});
