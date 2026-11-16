import { describe, it } from 'bun:test';
import should from 'should';
import type { JobExit } from '../../../../contract/index.ts';
import { memoryService } from '../../../support/daemon/job-fakes.ts';

const person = { by: 'person' } as const;
const ENDED = { code: 0, endedAt: '2026-11-15T23:59:00.000Z' } as const;

/** A job that already ended, with its log: the wrapper's part is played here. */
async function endedJob(over = memoryService(), exit: { code: number; endedAt: string } = ENDED) {
  const job = await over.service.start('ferret-a', { command: 'make build', name: 'build' }, person);
  over.files.exits.set(`ferret-a/${job.id}`, exit as JobExit);
  over.runtime.sessions.length = 0;
  return { ...over, job };
}

describe('what the moves read from the job keeper', () => {
  it('should name the job each live attachment holds, and nothing for a pid that is no longer that process', async () => {
    // Arrange
    const { service, starts } = memoryService();
    const job = await service.start('ferret-a', { command: 'sleep 99', name: 'watch' }, person);
    starts.set(501, 'start-501');
    starts.set(502, 'start-502');
    await service.registerAttachment('ferret-a', { jobId: job.id, pid: 501 });
    await service.registerAttachment('ferret-a', { jobId: job.id, pid: 502 });
    starts.set(502, 'start-reused');

    // Act
    const found = await service.keptAttachments('ferret-a');

    // Assert
    should(found).deepEqual([{ pid: 501, jobId: job.id, jobName: 'watch' }]);
  });

  it('should list running jobs and unreported ended ones, newest first', async () => {
    // Arrange
    const { service, files, job, clock } = await endedJob();
    clock.now += 60_000;
    const running = await service.start('ferret-a', { command: 'sleep 99', name: 'watch' }, person);

    // Act
    const jobs = await service.keptJobs('ferret-a');

    // Assert
    should(jobs.map(one => [one.name, one.state, one.unreported])).deepEqual([
      ['watch', 'running', false],
      ['build', 'exited', true],
    ]);
    should(jobs[1]?.exitCode).equal(0);
    should(running.id).not.equal(job.id);
    should(files.reported.size).equal(0);
  });

  it('should treat an ended job as told once an attachment was served the end of its log', async () => {
    // Arrange
    const { service, starts, job } = await endedJob();
    starts.set(601, 'start-601');
    const attachment = await service.registerAttachment('ferret-a', { jobId: job.id, pid: 601 });

    // Act
    const read = await service.output('ferret-a', job.id, { from: 0, attachment: attachment.id });
    const jobs = await service.keptJobs('ferret-a');

    // Assert
    should(read.ended).be.true();
    should(jobs[0]?.unreported).be.false();
  });

  it('should not mark a job told when the attachment that read its end was already asked to detach', async () => {
    // Arrange
    const { service, starts, job } = await endedJob();
    starts.set(602, 'start-602');
    const attachment = await service.registerAttachment('ferret-a', { jobId: job.id, pid: 602 });
    await service.detachAll('ferret-a');

    // Act
    await service.output('ferret-a', job.id, { from: 0, attachment: attachment.id });

    // Assert
    should((await service.keptJobs('ferret-a'))[0]?.unreported).be.true();
  });

  it('should record jobs as told, so neither a hand-over nor the backstop repeats them', async () => {
    // Arrange
    const { service, job } = await endedJob();

    // Act
    await service.markJobsReported('ferret-a', [job.id]);

    // Assert
    should((await service.keptJobs('ferret-a'))[0]?.unreported).be.false();
    should(await service.endedUnattached(0)).deepEqual([]);
  });

  describe('the completion backstop reads endedUnattached', () => {
    it('should answer an unreported ended job with no live attachment once the grace has passed', async () => {
      // Arrange
      const { service, job } = await endedJob();

      // Act
      const found = await service.endedUnattached(10_000);

      // Assert
      should(found.map(one => [one.ferret, one.job.id])).deepEqual([['ferret-a', job.id]]);
    });

    it('should leave a job that ended moments ago to its attachment', async () => {
      // Arrange
      const { service, clock } = await endedJob(memoryService(), { code: 0, endedAt: '2026-11-16T00:00:00.000Z' });
      clock.now = Date.parse('2026-11-16T00:00:03.000Z');

      // Act
      const found = await service.endedUnattached(10_000);

      // Assert
      should(found).deepEqual([]);
    });

    it('should never answer a job while an attachment is live on it', async () => {
      // Arrange
      const { service, starts, job } = await endedJob();
      starts.set(701, 'start-701');
      await service.registerAttachment('ferret-a', { jobId: job.id, pid: 701 });

      // Act
      const found = await service.endedUnattached(10_000);

      // Assert
      should(found).deepEqual([]);
    });

    it('should not answer a job that is still running', async () => {
      const { service } = memoryService();
      await service.start('ferret-a', { command: 'sleep 99' }, person);
      should(await service.endedUnattached(0)).deepEqual([]);
    });
  });

  describe('orphaned attachments', () => {
    it('should ask an attachment to detach once the harness it registered under is gone', async () => {
      // Arrange
      const { service, starts, harnesses } = memoryService();
      const job = await service.start('ferret-a', { command: 'sleep 99' }, person);
      starts.set(801, 'start-801');
      starts.set(900, 'harness-start');
      harnesses.set(801, { pid: 900, start: 'harness-start' });
      const attachment = await service.registerAttachment('ferret-a', { jobId: job.id, pid: 801 });
      should(await service.sweepOrphans()).equal(0);

      // Act — the harness is SIGKILLed: its pid is gone, the attachment (reparented) lives on.
      starts.delete(900);
      const marked = await service.sweepOrphans();
      const read = await service.output('ferret-a', job.id, { from: 0, attachment: attachment.id });

      // Assert
      should(marked).equal(1);
      should(read.detach).be.true();
      should(await service.sweepOrphans()).equal(0);
    });

    it('should leave an attachment that sits under no harness alone', async () => {
      const { service, starts } = memoryService();
      const job = await service.start('ferret-a', { command: 'sleep 99' }, person);
      starts.set(802, 'start-802');
      await service.registerAttachment('ferret-a', { jobId: job.id, pid: 802 });
      should(await service.sweepOrphans()).equal(0);
    });
  });
});

describe('registering an attachment is for `fy job attach|run` processes only', () => {
  it('should refuse a running pid that is some other program, so a forged entry never reaches the move gate', async () => {
    // Arrange
    const { service, starts, argvs } = memoryService();
    const job = await service.start('ferret-a', { command: 'sleep 99', name: 'watch' }, person);
    starts.set(1001, 'start-1001');
    argvs.set(1001, 'sleep 299');

    // Act
    const forged = service.registerAttachment('ferret-a', { jobId: job.id, pid: 1001 });

    // Assert
    await should(forged).be.rejectedWith(/not a `fy job attach` process/u);
    should(await service.keptAttachments('ferret-a')).deepEqual([]);
  });

  it('should refuse a pid whose command line cannot be read (fail closed)', async () => {
    const { service, starts, argvs } = memoryService();
    const job = await service.start('ferret-a', { command: 'sleep 99' }, person);
    starts.set(1002, 'start-1002');
    argvs.set(1002, 'unknown');
    await should(service.registerAttachment('ferret-a', { jobId: job.id, pid: 1002 })).be.rejectedWith(
      /not a `fy job attach` process/u,
    );
  });

  it('should accept `fy job attach`, `fy job run` and a runtime-wrapped script', async () => {
    const { service, starts, argvs } = memoryService();
    const job = await service.start('ferret-a', { command: 'sleep 99' }, person);
    for (const [pid, argv] of [
      [1003, '/nix/store/x/bin/fy job attach abc'],
      [1004, 'fy job run -- make'],
      [1005, 'bun /w/fy.ts job attach abc'],
    ] as const) {
      starts.set(pid, `start-${pid}`);
      argvs.set(pid, argv);
      await service.registerAttachment('ferret-a', { jobId: job.id, pid });
    }
    should((await service.keptAttachments('ferret-a')).map(entry => entry.pid)).deepEqual([1003, 1004, 1005]);
  });
});
