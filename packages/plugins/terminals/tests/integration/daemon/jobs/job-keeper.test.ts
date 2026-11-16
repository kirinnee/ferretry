import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { type Keeper, keeper } from '../support/job-keeper.ts';
import { waitForValue } from '../support/wait-for.ts';

const kept: Keeper[] = [];
afterEach(async () => {
  for (const one of kept.splice(0)) await one.dispose();
});
const start = async () => {
  const one = await keeper();
  kept.push(one);
  return one;
};
const person = { by: 'person' } as const;

const ended = async (service: ReturnType<Keeper['service']>, ferret: string, key: string) =>
  await waitForValue(async () => {
    const job = await service.get(ferret, key);
    return job.state === 'running' ? undefined : job;
  }, `job ${key} to end`);

describe('the job keeper against the real tmux', () => {
  it('should run the command in the login shell and the given folder, keep stdout and stderr in one log, and record the exit', async () => {
    // Arrange
    const { service, home } = await start();
    const jobs = service();

    // Act
    const job = await jobs.start('ferret-a', { command: 'pwd; echo out; echo err 1>&2; echo $((1+2)) | tr 3 x; exit 3' }, person);
    const done = await ended(jobs, 'ferret-a', job.id);
    const output = await jobs.output('ferret-a', job.id, { from: 0 });

    // Assert
    should(done.state).equal('exited');
    should(done.exitCode).equal(3);
    should(output.text).equal(`${home}\nout\nerr\nx\n`);
    should(output.ended).be.true();
  });

  it('should record a signal death as 128 + the signal, named', async () => {
    // Arrange
    const { service } = await start();
    const jobs = service();
    const job = await jobs.start('ferret-a', { command: 'kill -TERM $$' }, person);

    // Act
    const done = await ended(jobs, 'ferret-a', job.id);

    // Assert
    should(done.exitCode).equal(143);
    should(done.signal).equal('TERM');
  });

  it('should keep running when every attachment is gone, and a fresh service (a daemon restart) reads the same job', async () => {
    // Arrange
    const { service, proof, home } = await start();
    const first = service();
    const job = await first.start('ferret-a', { command: 'echo before; sleep 1; echo after' }, person);
    proof.starts.set(4242, 'start-a');
    const attachment = await first.registerAttachment('ferret-a', { jobId: job.id, pid: 4242 });

    // Act — the attachment dies (its pid is no longer that process), and the daemon restarts.
    proof.starts.delete(4242);
    const restarted = service();
    const listed = await restarted.listAttachments('ferret-a');
    const stillRunning = await restarted.get('ferret-a', job.id);
    const done = await ended(restarted, 'ferret-a', job.id);
    const output = await restarted.output('ferret-a', job.id, { from: 0 });

    // Assert
    should(attachment.jobId).equal(job.id);
    should(listed.attachments).deepEqual([]);
    should(stillRunning.state).equal('running');
    should(done.exitCode).equal(0);
    should(output.text).equal('before\nafter\n');
    should(home).be.a.String();
  });

  it('should stop a job: TERM on its tree, and the exit recorded as a signal death', async () => {
    // Arrange
    const { service } = await start();
    const jobs = service();
    const job = await jobs.start('ferret-a', { command: 'sleep 6173 & sleep 6173' }, person);
    await waitForValue(async () => (Bun.spawnSync(['pgrep', '-f', '^sleep 6173$']).exitCode === 0 ? true : undefined), 'both sleeps to run');

    // Act
    const stopped = await jobs.stop('ferret-a', job.id);

    // Assert
    should(stopped.state).equal('exited');
    should(stopped.signal).equal('TERM');
    should(stopped.exitCode).equal(143);
    // The whole tree went, not just the shell: no `sleep 6173` is left behind.
    should(Bun.spawnSync(['pgrep', '-f', '^sleep 6173$']).exitCode).equal(1);
  });

  it('should escalate to SIGKILL after the grace when the job ignores SIGTERM', async () => {
    // Arrange
    const { service } = await start();
    const jobs = service();
    const job = await jobs.start('ferret-a', { command: "trap '' TERM; echo ready; while true; do sleep 1; done" }, person);
    await waitForValue(async () => ((await jobs.output('ferret-a', job.id, { from: 0 })).text.includes('ready') ? true : undefined), 'it to ignore TERM');

    // Act
    const stopped = await jobs.stop('ferret-a', job.id);

    // Assert
    should(stopped.state).equal('exited');
    should(stopped.exitCode).equal(137);
    should(stopped.signal).equal('KILL');
  }, 30_000);

  it('should show only the whole lines of a running job and its last N lines on a tail', async () => {
    // Arrange
    const { service } = await start();
    const jobs = service();
    const job = await jobs.start('ferret-a', { command: 'printf "l1\\nl2\\nl3\\npartial"; sleep 2; echo' }, person);
    await waitForValue(async () => ((await jobs.output('ferret-a', job.id, { from: 0 })).text.includes('l3') ? true : undefined), 'the lines');

    // Act
    const whole = await jobs.output('ferret-a', job.id, { from: 0 });
    const tail = await jobs.output('ferret-a', job.id, { tail: 2 });

    // Assert
    should(whole.text).equal('l1\nl2\nl3\n');
    should(whole.ended).be.false();
    should(tail.text).equal('l2\nl3\n');
  });

  it("should keep a ferret's jobs apart from another ferret's", async () => {
    // Arrange
    const { service } = await start();
    const jobs = service();
    const mine = await jobs.start('ferret-a', { command: 'echo a', name: 'same' }, person);
    await ended(jobs, 'ferret-a', mine.id);

    // Act + Assert
    should((await jobs.list('ferret-b')).jobs).deepEqual([]);
    await should(jobs.get('ferret-b', mine.id)).be.rejectedWith(/no job/u);
  });
});
