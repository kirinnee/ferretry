import { describe, it } from 'bun:test';
import should from 'should';
import { JOB_MAX_RUNNING_PER_FERRET, JOB_RETENTION_DAYS } from '../../../../contract/index.ts';
import { memoryService } from '../../../support/daemon/job-fakes.ts';

const person = { by: 'person' } as const;
const agent = { by: 'agent', sessionId: 'f1' } as const;

describe('JobService refusals and edges', () => {
  it('should refuse an unknown ferret, an empty command and a folder that does not exist', async () => {
    const { service } = memoryService({ isDirectory: async path => path === '/work' });
    await should(service.list('ghost')).be.rejectedWith(/session not found/u);
    await should(service.start('f1', { command: '   ' }, person)).be.rejectedWith(/needs a command/u);
    await should(service.start('f1', { command: 'ls', cwd: '/nope' }, person)).be.rejectedWith(/no folder \/nope/u);
  });

  it('should refuse the job past the per-ferret cap, naming the cap', async () => {
    const { service, runtime } = memoryService();
    for (let index = 0; index < JOB_MAX_RUNNING_PER_FERRET; index += 1)
      await service.start('f1', { command: `sleep ${index}` }, agent);
    await should(service.start('f1', { command: 'one more' }, agent)).be.rejectedWith(/fy job stop/u);
    should(runtime.sessions).have.length(JOB_MAX_RUNNING_PER_FERRET);
  });

  it('should refuse a name a RUNNING job of the ferret already has, but allow it once that ended', async () => {
    const { service, files } = memoryService();
    const first = await service.start('f1', { command: 'a', name: 'dup' }, person);
    await should(service.start('f1', { command: 'b', name: 'dup' }, person)).be.rejectedWith(
      /already has a running job named dup/u,
    );
    files.exits.set(`f1/${first.id}`, { code: 0, endedAt: '2026-11-16T00:00:01.000Z' as never });
    const runtimeGone = (await service.get('f1', first.id)).state;
    should(runtimeGone).equal('exited');
  });

  it('should leave nothing behind when the keeper refuses to start the job', async () => {
    const { service, files, runtime } = memoryService();
    runtime.failStart = true;
    await should(service.start('f1', { command: 'a' }, person)).be.rejectedWith(/tmux refused/u);
    should((await files.list()).length).equal(0);
    files.failWrite = true;
    runtime.failStart = false;
    await should(service.start('f1', { command: 'a' }, person)).be.rejectedWith(/disk full/u);
    should((await files.list()).length).equal(0);
  });

  it('should stop a job whose wrapper does not answer: take the pane down and record a KILL exit', async () => {
    const { service, files, runtime } = memoryService();
    const job = await service.start('f1', { command: 'sleep 99' }, person);

    const stopped = await service.stop('f1', job.id);

    should(files.stops.has(`f1/${job.id}`)).be.true();
    should(runtime.killed).deepEqual([job.id]);
    should(stopped.exitCode).equal(137);
    should(stopped.signal).equal('KILL');
  });

  it('should answer a stop for a job that already ended as it is', async () => {
    const { service, files, runtime } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    files.exits.set(`f1/${job.id}`, { code: 5, endedAt: '2026-11-16T00:00:01.000Z' as never });
    const stopped = await service.stop('f1', job.id);
    should(stopped.exitCode).equal(5);
    should(runtime.killed).deepEqual([]);
  });

  it('should give the last N lines even when N is more than the log has, or the log is empty', async () => {
    const { service, files } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    should((await service.output('f1', job.id, { tail: 5 })).text).equal('');
    files.logs.set(`f1/${job.id}`, 'one\ntwo\n');
    files.exits.set(`f1/${job.id}`, { code: 0, endedAt: '2026-11-16T00:00:01.000Z' as never });
    should((await service.output('f1', job.id, { tail: 50 })).text).equal('one\ntwo\n');
    files.logs.set(`f1/${job.id}`, 'one\ntwo\nlast-without-newline');
    should((await service.output('f1', job.id, { tail: 1 })).text).equal('last-without-newline');
    should((await service.output('f1', job.id, { tail: 0 })).text).equal('');
  });

  it('should delete finished jobs past retention and keep running ones', async () => {
    const { service, files, clock } = memoryService();
    const old = await service.start('f1', { command: 'old' }, person);
    const running = await service.start('f1', { command: 'running' }, person);
    files.exits.set(`f1/${old.id}`, { code: 0, endedAt: new Date(clock.now).toISOString() as never });
    clock.now += (JOB_RETENTION_DAYS + 1) * 86_400_000;

    const removed = await service.sweep();

    should(removed).equal(1);
    should((await files.list()).map(item => item.id)).deepEqual([running.id]);
  });

  it('should keep a lost job (no session, no exit) until retention, counting from when it started', async () => {
    const { service, runtime, clock } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    runtime.sessions.length = 0;
    should((await service.get('f1', job.id)).state).equal('lost');
    should(await service.sweep()).equal(0);
    clock.now += (JOB_RETENTION_DAYS + 1) * 86_400_000;
    should(await service.sweep()).equal(1);
  });
});

describe('JobService attachments', () => {
  it('should register a live process, refuse a dead pid, list, unregister and prune by pid + start', async () => {
    const { service, starts } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    starts.set(100, 'start-a');
    starts.set(101, 'unknown');

    const proved = await service.registerAttachment('f1', { jobId: job.id, pid: 100, claudeTaskId: 'task1' });
    const unproved = await service.registerAttachment('f1', { jobId: job.id, pid: 101 });
    await should(service.registerAttachment('f1', { jobId: job.id, pid: 999 })).be.rejectedWith(
      /not a running process/u,
    );
    should((await service.listAttachments('f1')).attachments.map(item => item.claudeTaskId)).deepEqual([
      'task1',
      undefined,
    ]);
    should((await service.get('f1', job.id)).attachments).equal(2);

    starts.set(100, 'start-reused');
    should((await service.listAttachments('f1')).attachments.map(item => item.id)).deepEqual([unproved.id]);
    await service.unregisterAttachment('f1', proved.id); // already pruned: nothing happens
    await service.unregisterAttachment('f1', unproved.id);
    should((await service.listAttachments('f1')).attachments).deepEqual([]);
  });

  it('should keep an attachment when the host cannot be read, and treat a throwing proof as unknown', async () => {
    const { service, starts } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    starts.set(100, 'start-a');
    await service.registerAttachment('f1', { jobId: job.id, pid: 100 });
    starts.set(100, 'unknown');
    should((await service.listAttachments('f1')).attachments).have.length(1);
  });

  it("should ask one ferret's attachments (or one job's) to detach, count only those not yet asked, and tell the attachment", async () => {
    const { service, starts } = memoryService();
    const a = await service.start('f1', { command: 'a' }, person);
    const b = await service.start('f1', { command: 'b' }, person);
    starts.set(1, 's1');
    starts.set(2, 's2');
    const first = await service.registerAttachment('f1', { jobId: a.id, pid: 1 });
    const second = await service.registerAttachment('f1', { jobId: b.id, pid: 2 });

    should(await service.detachAll('f1', a.id)).equal(1);
    should((await service.output('f1', a.id, { from: 0, attachment: first.id })).detach).be.true();
    should((await service.output('f1', b.id, { from: 0, attachment: second.id })).detach).be.false();
    should(await service.detachAll('f1')).equal(1);
    should(await service.detachAll('f1')).equal(0);
    should((await service.listAttachments('f1')).attachments.every(item => item.detaching)).be.true();
  });
});

describe('JobService stop when the wrapper does not finish in time', () => {
  it('should SIGKILL the tracked descendants first, spare a reused pid, and only then take the pane down and record the exit', async () => {
    // Arrange: two tracked processes still the same, one whose pid has been reused since.
    const { service, files, runtime, starts, killed } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    files.tracked.set(`f1/${job.id}`, [
      { pid: 301, start: '1000' },
      { pid: 302, start: '1001' },
      { pid: 303, start: '1002' },
    ]);
    starts.set(301, '1000');
    starts.set(302, '1001');
    starts.set(303, '7777'); // reused by an unrelated process: never signalled

    // Act
    const stopped = await service.stop('f1', job.id);

    // Assert
    should(killed).deepEqual([301, 302]);
    should(runtime.killed).deepEqual([job.id]);
    should(stopped.state).equal('exited');
    should(stopped.exitCode).equal(137);
    should(starts.get(303)).equal('7777');
  });

  it('should record no exit and leave the pane up when a tracked process survives SIGKILL, saying which one', async () => {
    // Arrange
    const { service, files, runtime, starts, immortal, killed } = memoryService();
    const job = await service.start('f1', { command: 'a', name: 'stuck' }, person);
    files.tracked.set(`f1/${job.id}`, [{ pid: 401, start: '2000' }]);
    starts.set(401, '2000');
    immortal.add(401);

    // Act + Assert
    await should(service.stop('f1', job.id)).be.rejectedWith(
      /could not stop job stuck: 401 still running after SIGKILL/u,
    );
    should(killed).deepEqual([401]);
    should(files.exits.has(`f1/${job.id}`)).be.false();
    should(runtime.killed).deepEqual([]);
    should((await service.get('f1', job.id)).state).equal('running');
  });

  it('should never signal a start reading it cannot compare, and count that process as still running', async () => {
    // Arrange: a start that is not the Linux tick count (macOS `ps -o lstart=`), or a host that cannot say.
    const { service, files, runtime, starts, killed } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    files.tracked.set(`f1/${job.id}`, [
      { pid: 501, start: 'Mon_Nov_16_00:00:00_2026' },
      { pid: 502, start: '3000' },
    ]);
    starts.set(501, '1763251200');
    starts.set(502, 'unknown');

    // Act + Assert
    await should(service.stop('f1', job.id)).be.rejectedWith(/501, 502 still running after SIGKILL/u);
    should(killed).deepEqual([]);
    should(runtime.killed).deepEqual([]);
    should(files.exits.has(`f1/${job.id}`)).be.false();
  });
});

describe('JobService attachments: what registers and what is swept', () => {
  it('should refuse a pid that is no longer a process, one that is not `fy job attach`, and one it cannot read', async () => {
    const { service, starts, argvs } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    starts.set(300, 'start-300');
    argvs.set(300, undefined);
    starts.set(301, 'start-301');
    argvs.set(301, 'sleep 299');
    starts.set(302, 'start-302');
    argvs.set(302, 'unknown');

    await should(service.registerAttachment('f1', { jobId: job.id, pid: 300 })).be.rejectedWith(
      /not a running process/u,
    );
    await should(service.registerAttachment('f1', { jobId: job.id, pid: 301 })).be.rejectedWith(
      /not a `fy job attach` process/u,
    );
    await should(service.registerAttachment('f1', { jobId: job.id, pid: 302 })).be.rejectedWith(
      /not a `fy job attach` process/u,
    );
  });

  it('should sweep an attachment whose harness is gone, once, and leave a harness-less one alone', async () => {
    const { service, starts, harnesses } = memoryService();
    const job = await service.start('f1', { command: 'a' }, person);
    starts.set(310, 'start-310');
    starts.set(311, 'start-311');
    starts.set(900, 'harness-start');
    harnesses.set(310, { pid: 900, start: 'harness-start' });
    await service.registerAttachment('f1', { jobId: job.id, pid: 310 });
    await service.registerAttachment('f1', { jobId: job.id, pid: 311 });

    should(await service.sweepOrphans()).equal(0);
    starts.delete(900);
    should(await service.sweepOrphans()).equal(1);
    should(await service.sweepOrphans()).equal(0);
  });
});
