import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { jobPaneArgv } from '../../../../daemon/lib/jobs/policy.ts';
import { type Keeper, keeper } from '../support/job-keeper.ts';
import { waitForValue } from '../support/wait-for.ts';

const kept: Keeper[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const one of kept.splice(0)) await one.dispose();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const person = { by: 'person' } as const;
const exists = async (path: string) =>
  await stat(path).then(
    () => true,
    () => false,
  );

/** Runs the real wrapper under plain sh (no tmux) in a fresh job folder. */
async function wrapped(command: string, cap: number, cwd?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'fy-wrap-'));
  homes.push(dir);
  const [bin, ...args] = jobPaneArgv({ dir, shell: '/bin/sh', command, cwd: cwd ?? dir, logCapBytes: cap });
  const child = Bun.spawn([bin ?? '', ...args], { stdout: 'ignore', stderr: 'ignore' });
  return { dir, child, log: join(dir, 'output.log') };
}

describe('the job log cap', () => {
  it('should stop a flood at the cap, write ONE marker line, and let the job finish with its own exit code', async () => {
    // Arrange + Act
    const run = await wrapped("head -c 5000000 /dev/zero | tr '\\0' x; echo; exit 7", 10_000);
    await run.child.exited;
    const text = await readFile(run.log, 'utf8');

    // Assert
    // The writer reads at most 64 KiB at a time, so the log can pass the cap by one read, never by more.
    should(Buffer.byteLength(text)).be.below(10_000 + 65_536 + 200);
    should(Buffer.byteLength(text)).be.above(9_999);
    should(text.match(/further output is dropped/gu)).have.length(1);
    should(JSON.parse(await readFile(join(run.dir, 'exit.json'), 'utf8')).code).equal(7);
  });

  it('should keep a never-ending writer (yes) at the cap and still stop it on request', async () => {
    // Arrange
    const run = await wrapped('yes', 20_000);
    await waitForValue(
      async () => ((await readFile(run.log, 'utf8').catch(() => '')).includes('dropped') ? true : undefined),
      'the cap',
    );

    // Act
    await Bun.sleep(300);
    const size = (await stat(run.log)).size;
    await writeFile(join(run.dir, 'stop'), '');
    await run.child.exited;

    // Assert
    should(size).be.below(20_000 + 65_536 + 200);
    should((await stat(run.log)).size).equal(size);
    should(JSON.parse(await readFile(join(run.dir, 'exit.json'), 'utf8')).signal).equal('TERM');
  }, 20_000);

  it('should write no marker for a log that stays under the cap', async () => {
    const run = await wrapped('echo small', 10_000);
    await run.child.exited;
    should(await readFile(run.log, 'utf8')).equal('small\n');
  });

  it('should run the job in the cwd given as a plain argument, whatever the folder is called', async () => {
    const odd = await mkdtemp(join(tmpdir(), 'fy-odd-'));
    homes.push(odd);
    const folder = join(odd, '#(touch pwned);$HOME `x`');
    await mkdir(folder);
    const run = await wrapped('pwd', 1_000, folder);
    await run.child.exited;
    should((await readFile(run.log, 'utf8')).trim()).equal(folder);
  });

  it('should record a failed cd as an exit rather than running the job elsewhere', async () => {
    const run = await wrapped('echo ran', 1_000, '/no/such/folder');
    await run.child.exited;
    should(await readFile(run.log, 'utf8')).not.containEql('ran');
    should(JSON.parse(await readFile(join(run.dir, 'exit.json'), 'utf8')).code).not.equal(0);
  });
});

describe('tmux format expansion (a private tmux server)', () => {
  it('should not run a #(command) hidden in the cwd, the command, or the owner name', async () => {
    // Arrange
    const one = await keeper();
    kept.push(one);
    const jobs = one.service();
    // A name cannot hold a slash, so the payload is relative: tmux runs it in the server's own folder.
    const marker = join(process.cwd(), 'r3-pwned');
    await rm(marker, { force: true });
    const folder = join(one.home, '#(touch r3-pwned)');
    await mkdir(folder);

    // Act
    const inCwd = await jobs.start('ferret-a', { command: 'pwd', cwd: folder }, person);
    const inCommand = await jobs.start('ferret-a', { command: "echo '#(touch r3-pwned)'" }, person);
    const inOwner = await jobs.start('ferret#(touch r3-pwned)', { command: 'echo owner' }, person);
    for (const [ferret, job] of [
      ['ferret-a', inCwd],
      ['ferret-a', inCommand],
      ['ferret#(touch r3-pwned)', inOwner],
    ] as const)
      await waitForValue(
        async () => ((await jobs.get(ferret, job.id)).state === 'running' ? undefined : true),
        'it to end',
      );
    await Bun.sleep(300);

    // Assert
    should(await exists(marker)).be.false();
    should((await jobs.output('ferret-a', inCwd.id, { from: 0 })).text.trim()).equal(folder);
    should((await jobs.output('ferret-a', inCommand.id, { from: 0 })).text.trim()).equal('#(touch r3-pwned)');
  }, 30_000);

  it('should close only the exact session when stopping, never one whose name merely starts the same', async () => {
    // Arrange
    const one = await keeper();
    kept.push(one);
    const jobs = one.service();
    const keep = await jobs.start('ferret-a', { command: 'sleep 30' }, person);

    // Act — a stop of an unknown id must not touch the running job.
    await should(jobs.stop('ferret-a', 'ffffffffffff')).be.rejected();

    // Assert
    should((await jobs.get('ferret-a', keep.id)).state).equal('running');
    await jobs.stop('ferret-a', keep.id);
  }, 30_000);
});
