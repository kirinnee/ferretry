import { describe, it } from 'bun:test';
import should from 'should';
import {
  JOB_MAX_RUNNING_GLOBAL,
  JOB_MAX_RUNNING_PER_FERRET,
  JOB_RETENTION_DAYS,
  JOB_RETENTION_FINISHED_PER_FERRET,
} from '../../../../contract/index.ts';
import {
  attachExitCode,
  jobCapacityRefusal,
  defaultJobName,
  findJob,
  JOB_LOG_CAP_BYTES,
  JOB_WRAPPER_SCRIPT,
  jobPaneArgv,
  jobsToDelete,
  jobState,
  jobTmuxSessionName,
} from '../../../../daemon/lib/jobs/policy.ts';

const DAY = 86_400_000;
const exit = (code: number) => ({ code, endedAt: '2026-11-16T00:00:00.000Z' }) as never;

describe('job names', () => {
  it('should name an unnamed job after its first word, without folders or extension', () => {
    should(defaultJobName('./scripts/slot-watch.sh --loop', new Set())).equal('slot-watch');
    should(defaultJobName('bun test', new Set())).equal('bun');
  });

  it("should make a clean name from anything and a unique one among the ferret's jobs", () => {
    should(defaultJobName('9lives', new Set())).equal('job-9lives');
    should(defaultJobName('  ', new Set())).equal('job');
    should(defaultJobName('make', new Set(['make', 'make-2']))).equal('make-3');
  });

  it('should never produce a name that looks like a job id', () => {
    should(defaultJobName('abcdef012345', new Set())).not.equal('abcdef012345');
  });

  it('should find a job by exact id before name', () => {
    const jobs = [
      { id: 'aaaaaaaaaaaa', name: 'x' },
      { id: 'bbbbbbbbbbbb', name: 'aaaaaaaaaaaa' },
    ];
    should(findJob(jobs, 'aaaaaaaaaaaa')?.name).equal('x');
    should(findJob(jobs, 'x')?.id).equal('aaaaaaaaaaaa');
    should(findJob(jobs, 'nope')).be.undefined();
  });

  it('should name the tmux session with the job prefix, the owner and the id', () => {
    should(jobTmuxSessionName('mwiql4qp-1fd6a928', '0123456789ab')).equal('fy-job-mwiql4qp-1fd6a928-0123456789ab');
    should(jobTmuxSessionName('a/b c', '0123456789ab')).startWith('fy-job-a-b-c-');
  });
});

describe('job caps', () => {
  it('should allow a job under both caps', () => {
    should(jobCapacityRefusal({ ferret: JOB_MAX_RUNNING_PER_FERRET - 1, global: 3 })).be.undefined();
  });

  it('should refuse past the per-ferret cap, saying which and what to do', () => {
    should(jobCapacityRefusal({ ferret: JOB_MAX_RUNNING_PER_FERRET, global: 3 })).match(/fy job stop/u);
  });

  it('should refuse past the machine cap', () => {
    should(jobCapacityRefusal({ ferret: 0, global: JOB_MAX_RUNNING_GLOBAL })).match(/the machine already has/u);
  });
});

describe('job retention', () => {
  const now = 100 * DAY;

  it('should keep everything recent and within the count', () => {
    should(jobsToDelete([{ id: 'a', endedAtMs: now - DAY }], now)).deepEqual([]);
  });

  it('should delete what ended before the window', () => {
    should(
      jobsToDelete(
        [
          { id: 'old', endedAtMs: now - (JOB_RETENTION_DAYS + 1) * DAY },
          { id: 'new', endedAtMs: now },
        ],
        now,
      ),
    ).deepEqual(['old']);
  });

  it('should keep only the newest N finished jobs even inside the window', () => {
    const finished = Array.from({ length: JOB_RETENTION_FINISHED_PER_FERRET + 2 }, (_, index) => ({
      id: `j${index}`,
      endedAtMs: now - index * 1_000,
    }));
    should(jobsToDelete(finished, now)).deepEqual([
      `j${JOB_RETENTION_FINISHED_PER_FERRET}`,
      `j${JOB_RETENTION_FINISHED_PER_FERRET + 1}`,
    ]);
  });
});

describe('job state and exit codes', () => {
  it('should read an exit record over everything, a living session as running, neither as lost', () => {
    should(jobState(exit(0), false)).equal('exited');
    should(jobState(exit(0), true)).equal('exited');
    should(jobState(undefined, true)).equal('running');
    should(jobState(undefined, false)).equal('lost');
  });

  it("should attach-exit with the job's code, capped to a byte, and the lost code when none was recorded", () => {
    should(attachExitCode('exited', exit(3), 70)).equal(3);
    should(attachExitCode('exited', exit(143), 70)).equal(143);
    should(attachExitCode('exited', exit(1000), 70)).equal(255);
    should(attachExitCode('lost', undefined, 70)).equal(70);
  });
});

describe('the pane wrapper', () => {
  it('should not end in a semicolon, which tmux would read as a command separator', () => {
    should(JOB_WRAPPER_SCRIPT.trimEnd().endsWith(';')).be.false();
  });

  it("should pass the folder, the login shell, the command, the cwd and the cap as the shell's own positional words", () => {
    should(
      jobPaneArgv({ dir: '/state/j', shell: '/bin/zsh', command: 'echo "$HOME"; ls', cwd: '/work/#(x)' }),
    ).deepEqual([
      '/bin/sh',
      '-c',
      JOB_WRAPPER_SCRIPT,
      'fy-job',
      '/state/j',
      '/bin/zsh',
      'echo "$HOME"; ls',
      '/work/#(x)',
      '67108864',
    ]);
  });

  it('should hold a log cap of 64 MiB, state it in the marker, and re-walk the tree before the KILL', () => {
    should(JOB_LOG_CAP_BYTES).equal(64 * 1024 * 1024);
    should(jobPaneArgv({ dir: 'd', shell: 's', command: 'c', cwd: '/', logCapBytes: 5 }).at(-1)).equal('5');
    should(JOB_WRAPPER_SCRIPT).containEql('further output is dropped');
    should(JOB_WRAPPER_SCRIPT).containEql('now=$(tree "$pid")');
  });

  it('should record the exit atomically, from the pane, and never forward a signal as the attachment would', () => {
    should(JOB_WRAPPER_SCRIPT).containEql('mv "$dir/exit.json.tmp" "$dir/exit.json"');
    should(JOB_WRAPPER_SCRIPT).containEql('trap term INT TERM HUP');
  });
});
