import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateJobFiles } from '../../../../daemon/adapters/jobs/job-files.ts';
import { TmuxJobRuntime } from '../../../../daemon/adapters/jobs/tmux-job-runtime.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../../daemon/lib/tmux/contracts.ts';
import { folderState, tree } from '../support/job-keeper.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const files = async () => {
  const home = await mkdtemp(join(tmpdir(), 'fy-jobfiles-'));
  homes.push(home);
  return { home, files: new StateJobFiles(folderState(home) as never, tree) };
};
const ID = 'abcdef012345';
const meta = {
  id: ID,
  name: 'build',
  command: 'bun test',
  cwd: '/work',
  startedAt: '2026-11-16T00:00:00.000Z' as never,
  startedBy: { by: 'person' as const },
};

describe('the job folder', () => {
  it("should keep a job's metadata and exit, read them back, and ignore a folder with neither", async () => {
    const { files: sut, home } = await files();
    await sut.create('f1', ID);
    await sut.writeMeta('f1', ID, meta);
    await sut.writeExit('f1', ID, { code: 2, endedAt: '2026-11-16T00:00:01.000Z' as never });
    await mkdir(join(home, 'jobs', 'f1', 'not-a-job-id'));

    should(await sut.readMeta('f1', ID)).deepEqual(meta);
    should((await sut.readExit('f1', ID))?.code).equal(2);
    should(await sut.list()).deepEqual([{ owner: 'f1', id: ID }]);
    should(await sut.readMeta('f1', 'ffffffffffff')).be.undefined();
  });

  it('should read a damaged document as absent, never throw', async () => {
    const { files: sut, home } = await files();
    await sut.create('f1', ID);
    await writeFile(join(home, 'jobs', 'f1', ID, 'job.json'), '{not json');
    await writeFile(join(home, 'jobs', 'f1', ID, 'exit.json'), '{"code":"x"}');
    should(await sut.readMeta('f1', ID)).be.undefined();
    should(await sut.readExit('f1', ID)).be.undefined();
  });

  it('should read the log in windows, report its size, and answer nothing for a log that is not there or a window of nothing', async () => {
    const { files: sut, home } = await files();
    await sut.create('f1', ID);
    should(await sut.outputSize('f1', ID)).equal(0);
    should(await sut.readOutput('f1', ID, 0, 10)).have.length(0);
    await writeFile(join(home, 'jobs', 'f1', ID, 'output.log'), 'hello world\n');
    should(await sut.outputSize('f1', ID)).equal(12);
    should(new TextDecoder().decode(await sut.readOutput('f1', ID, 6, 100))).equal('world\n');
    should(await sut.readOutput('f1', ID, 0, 0)).have.length(0);
  });

  it("should write the stop request and delete a job's folder and then its ferret's when empty", async () => {
    const { files: sut, home } = await files();
    await sut.create('f1', ID);
    await sut.writeMeta('f1', ID, meta);
    await sut.requestStop('f1', ID);
    should(await Bun.file(join(home, 'jobs', 'f1', ID, 'stop')).exists()).be.true();

    await sut.remove('f1', ID);

    should(await sut.list()).deepEqual([]);
    should(await Bun.file(join(home, 'jobs', 'f1', ID, 'job.json')).exists()).be.false();
  });
});

const ok = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): TmuxCommandResult => ({ code: 1, stdout: '', stderr });
class ScriptedTmux implements TmuxCommandPort {
  readonly received: string[][] = [];
  constructor(private readonly results: TmuxCommandResult[]) {}
  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    this.received.push([...arguments_]);
    return this.results.shift() ?? ok();
  }
}
const plainShell = { shell: async () => '/bin/zsh' };
const input = { owner: 'f1', id: ID, dir: '/state/j', cwd: '/work', command: 'echo hi', limited: false };

describe('the tmux job runtime', () => {
  it("should start the wrapper (not a shell) in the folder, mark the session, and place an agent's job in the limits scope", async () => {
    const tmux = new ScriptedTmux([ok(), ok()]);
    const seen: string[] = [];
    const sut = new TmuxJobRuntime(
      tmux,
      plainShell,
      {
        command: async (session, command, kind) => {
          seen.push(`${session}:${String(kind.terminal)}`);
          return ['systemd-run', '--scope', '--', ...command];
        },
      },
      () => ({ FY_X: '1' }),
    );

    const plain = await sut.start(input);
    await sut.start({ ...input, limited: true });

    should(plain.tmuxSession).equal(`fy-job-f1-${ID}`);
    should(tmux.received[0]).containDeepOrdered([
      'new-session',
      '-d',
      '-s',
      `fy-job-f1-${ID}`,
      '-c',
      '/',
      '-e',
      'FY_X=1',
      '/bin/sh',
      '-c',
    ]);
    should(tmux.received[0]).containEql('@fy_job_owner');
    should(tmux.received[1]).containDeepOrdered(['systemd-run', '--scope', '--', '/bin/sh']);
    should(seen).deepEqual(['f1:true']);
  });

  it('should clean up and say so when tmux refuses to start the job', async () => {
    const tmux = new ScriptedTmux([fail('no space'), ok()]);
    const sut = new TmuxJobRuntime(tmux, plainShell);
    await should(sut.start(input)).be.rejectedWith(/could not start the job: no space/u);
    should(tmux.received[1]).deepEqual(['kill-session', '-t', `=fy-job-f1-${ID}`]);
    const empty = new TmuxJobRuntime(new ScriptedTmux([fail('')]), plainShell);
    await should(empty.start(input)).be.rejectedWith(/tmux command failed/u);
  });

  it('should list only job sessions, an absent server as none, and a real failure as an error', async () => {
    const line = (name: string, owner: string, id: string) => `${name}\t${owner}\t${id}`;
    const tmux = new ScriptedTmux([
      ok(
        [
          line(`fy-job-f1-${ID}`, 'f1', ID),
          line('fy-webterm-x', 'f1', ID),
          line(`fy-job-f2-x`, 'f2', 'short'),
          line(`fy-job-f3-${ID}`, '', ID),
        ].join('\n'),
      ),
      fail('no server running on /tmp/x'),
      fail('no sessions'),
      fail('permission denied'),
      fail(''),
    ]);
    const sut = new TmuxJobRuntime(tmux, plainShell);
    should(await sut.list()).deepEqual([{ owner: 'f1', id: ID, tmuxSession: `fy-job-f1-${ID}` }]);
    should(await sut.list()).deepEqual([]);
    should(await sut.list()).deepEqual([]);
    await should(sut.list()).be.rejectedWith(/could not list jobs: permission denied/u);
    await should(sut.list()).be.rejectedWith(/tmux command failed/u);
  });

  it('should ask again when the server exits as the last job ends, and give up after a few tries', async () => {
    const gone = fail('server exited unexpectedly');
    const sut = new TmuxJobRuntime(
      new ScriptedTmux([gone, gone, ok('')]),
      plainShell,
      undefined,
      () => ({}),
      async () => undefined,
    );
    should(await sut.list()).deepEqual([]);
    const stuck = new TmuxJobRuntime(
      new ScriptedTmux(Array.from({ length: 6 }, () => gone)),
      plainShell,
      undefined,
      () => ({}),
      async () => undefined,
    );
    await should(stuck.list()).be.rejectedWith(/server exited unexpectedly/u);
  });

  it('should close a session, treat one already gone as closed, and report any other failure', async () => {
    const job = { owner: 'f1', id: ID, tmuxSession: `fy-job-f1-${ID}` };
    const sut = new TmuxJobRuntime(
      new ScriptedTmux([ok(), fail("can't find session: x"), fail('no server running on /tmp/x'), fail('boom')]),
      plainShell,
    );
    await sut.kill(job);
    await sut.kill(job);
    await sut.kill(job);
    await should(sut.kill(job)).be.rejectedWith(/could not close the job: boom/u);
  });
});
