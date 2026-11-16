import { describe, it } from 'bun:test';
import should from 'should';
import type { JobKeeperSource, KeptJob } from '../../../../contract/job-keeping.ts';
import { bounded } from '../../../../daemon/lib/moves/bounded.ts';
import { assembleInflightReport } from '../../../../daemon/lib/moves/inflight-report.ts';
import { handOffJobs, handoverMessage, markJobsTold } from '../../../../daemon/lib/moves/jobs-move.ts';

const report = assembleInflightReport({
  status: 'running',
  turn: 1,
  openTools: [],
  processes: { kind: 'observed', processes: [] },
  codexBackgroundTerminals: 0,
});
const running: KeptJob = {
  id: 'abc',
  name: 'build',
  state: 'running',
  startedAt: '2026-11-16T00:00:00.000Z',
  unreported: false,
};
const finished: KeptJob = {
  id: 'fin',
  name: 'lint',
  state: 'exited',
  exitCode: 1,
  startedAt: running.startedAt,
  unreported: true,
};
const hang = async (): Promise<never> => await new Promise<never>(() => undefined);

const ports = (keeper: Partial<JobKeeperSource> | undefined, warnings: string[] = []) => ({
  keeper: () => keeper as JobKeeperSource | undefined,
  sleep: async (ms: number) => await new Promise<void>(done => setTimeout(done, ms)),
  nowMs: () => Date.parse('2026-11-16T01:00:00.000Z'),
  keeperTimeoutMs: 20,
  log: { warn: (message: string) => void warnings.push(message) },
});

describe('the jobs half of a pane-killing move', () => {
  it('should detach, then hand over the section and say which finished jobs it told', async () => {
    const calls: string[] = [];
    const keeper = {
      attachments: async () => (calls.includes('detach') ? [] : [{ pid: 1, jobId: 'abc', jobName: 'build' }]),
      detach: async () => (calls.push('detach'), 1),
      jobs: async () => [running, finished],
    };

    const handOff = await handOffJobs(ports(keeper), 'ferret-a', report);

    should(calls).deepEqual(['detach']);
    should(handOff.section).containEql('re-attach: run `fy job attach abc` as a background Bash');
    should(handOff.told).deepEqual(['fin']);
  });

  it('should say and do nothing when no keeper is installed', async () => {
    should(await handOffJobs(ports(undefined), 'ferret-a', report)).deepEqual({ section: undefined, told: [] });
    await markJobsTold(ports(undefined), 'ferret-a', ['fin']);
  });

  it('should go ahead, logging, when the keeper hangs: no hand-over, nothing detached, the move is not held', async () => {
    const warnings: string[] = [];
    const keeper = { attachments: hang, detach: hang, jobs: hang, markReported: hang };

    const handOff = await handOffJobs(ports(keeper, warnings), 'ferret-a', report);
    await markJobsTold(ports(keeper, warnings), 'ferret-a', ['fin']);

    should(handOff).deepEqual({ section: undefined, told: [] });
    should(warnings.length).equal(3);
  });

  it('should only record as told what it was given, and never when there is nothing', async () => {
    const marked: string[][] = [];
    const keeper = { markReported: async (_f: string, ids: readonly string[]) => void marked.push([...ids]) };
    await markJobsTold(ports(keeper), 'ferret-a', []);
    await markJobsTold(ports(keeper), 'ferret-a', ['fin']);
    should(marked).deepEqual([['fin']]);
  });

  it('should join the note, the restart notice and the jobs section, whichever exist', () => {
    should(handoverMessage('note', 'notice', 'jobs')).equal('note\n\nnotice\n\njobs');
    should(handoverMessage(undefined, undefined, 'jobs')).equal('jobs');
    should(handoverMessage('note', undefined, undefined)).equal('note');
    should(handoverMessage(undefined, undefined, undefined)).be.undefined();
  });
});

describe('a question to the keeper on the move path', () => {
  it('should answer what the keeper answers when it is quick, and refuse with a sentence when it is not', async () => {
    const wait = async (ms: number) => await new Promise<void>(done => setTimeout(done, ms));
    should(await bounded(Promise.resolve(7), 50, 'the keeper', wait)).equal(7);
    await should(bounded(hang(), 10, 'the keeper', wait)).be.rejectedWith(/the keeper did not answer within 10 ms/u);
  });
});
