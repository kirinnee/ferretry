import { afterEach, describe, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import { JobVerbs } from '../../../../cli/lib/jobs/controller.ts';
import type { IJobSignals } from '../../../../cli/lib/jobs/ports.ts';
import { type Keeper, keeper } from '../../daemon/support/job-keeper.ts';
import { waitFor } from '../../daemon/support/wait-for.ts';
import { capturedIo, invocation } from '../../../support/cli/doubles.ts';

const kept: Keeper[] = [];
afterEach(async () => {
  for (const one of kept.splice(0)) await one.dispose();
});

/** The CLI's gateway answered by the real job service: what the daemon's routes do, minus HTTP. */
function gatewayOver(service: ReturnType<Keeper['service']>): PluginClient {
  return {
    call: async (route: string, init?: Parameters<PluginClient['call']>[1]) => {
      const ferret = init?.params?.ferretId ?? '';
      const key = init?.params?.jobId ?? '';
      const query = init?.query ?? {};
      const body = (init?.body ?? {}) as Record<string, string | number | undefined>;
      switch (route) {
        case 'POST /v1/ferrets/:ferretId/jobs':
          return await service.start(ferret, body as never, { by: 'agent', sessionId: ferret });
        case 'GET /v1/ferrets/:ferretId/jobs/:jobId':
          return await service.get(ferret, key);
        case 'GET /v1/ferrets/:ferretId/jobs':
          return await service.list(ferret);
        case 'GET /v1/ferrets/:ferretId/jobs/:jobId/output':
          return await service.output(ferret, key, {
            ...(query.from === undefined ? {} : { from: Number(query.from) }),
            ...(query.tail === undefined ? {} : { tail: Number(query.tail) }),
            ...(query.attachment === undefined ? {} : { attachment: query.attachment }),
          });
        case 'POST /v1/ferrets/:ferretId/jobs/:jobId/stop':
          return await service.stop(ferret, key);
        case 'POST /v1/ferrets/:ferretId/job-attachments':
          return await service.registerAttachment(ferret, body as never);
        case 'DELETE /v1/ferrets/:ferretId/job-attachments/:attachmentId':
          await service.unregisterAttachment(ferret, init?.params?.attachmentId ?? '');
          return { ok: true };
        default:
          throw new Error(`unexpected route ${route}`);
      }
    },
    subscribe: () => () => undefined,
  } as PluginClient;
}

class Signals implements IJobSignals {
  handler: ((name: string) => void) | undefined;
  listen(onSignal: (name: string) => void) {
    this.handler = onSignal;
    return () => {
      this.handler = undefined;
    };
  }
}

function verbs(one: Keeper, signals = new Signals(), pid = process.pid) {
  const io = capturedIo();
  one.proof.starts.set(pid, `p-${pid}`);
  return {
    io,
    signals,
    sut: new JobVerbs(gatewayOver(one.service()), io, {
      self: { pid, cwd: () => one.home, stdoutFile: () => undefined, exit: () => undefined },
      signals,
      timers: {
        deadline: ms => AbortSignal.timeout(ms),
        nowMs: () => Date.now(),
        sleep: async (ms, signal) =>
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
          }),
      },
      sessionId: 'ferret-a',
    }),
  };
}

describe('fy job, end to end over the real keeper', () => {
  it('should survive a broken attachment, let a new one see the whole log, and carry the exit code through', async () => {
    // Arrange — a job that talks, waits for the test, then ends with 4.
    const one = await keeper();
    kept.push(one);
    const flag = `${one.home}/go`;
    const first = verbs(one);
    const running = first.sut.run(
      invocation([`echo first; while [ ! -e ${flag} ]; do sleep 0.1; done; echo second; exit 4`], {
        name: 'talker',
      }),
    );
    await waitFor(() => first.io.printed.join('').includes('first'), 'the first line to stream');

    // Act 1 — the attachment is broken by a signal: it detaches, the job keeps running.
    first.signals.handler?.('SIGTERM');
    const detachedCode = await running;
    const stillRunning = await one.service().get('ferret-a', 'talker');

    // Act 2 — the job moves on while nobody is attached, then a fresh attachment reads it all and gets the exit code.
    await Bun.write(flag, '');
    await waitFor(async () => (await one.service().get('ferret-a', 'talker')).state === 'exited', 'the job to end');
    const second = verbs(one);
    const code = await second.sut.attach(invocation(['talker'], { 'from-start': true }));

    // Assert
    should(detachedCode).equal(75);
    should(first.io.errors.join('')).containEql('it is still running — re-attach with: fy job attach');
    should(stillRunning.state).equal('running');
    should(code).equal(4);
    should(second.io.printed.join('')).equal('first\nsecond\n');
  });

  it('should let the daemon detach a live attachment before a move: it exits 75, the job runs on, and nobody is told twice', async () => {
    // Arrange — a long job with a live attachment, as a ferret's tool shell would hold.
    const one = await keeper();
    kept.push(one);
    const flag = `${one.home}/go`;
    const attached = verbs(one);
    const running = attached.sut.run(
      invocation([`echo up; while [ ! -e ${flag} ]; do sleep 0.1; done; exit 0`], { name: 'watch' }),
    );
    await waitFor(() => attached.io.printed.join('').includes('up'), 'the job to be up');
    const service = one.service();
    const before = await service.keptAttachments('ferret-a');

    // Act — the move asks the keeper to detach every attachment of the ferret.
    const asked = await service.detachAll('ferret-a');
    const code = await running;
    await waitFor(async () => (await service.keptAttachments('ferret-a')).length === 0, 'the attachment to unregister');

    // Assert — it let go (75), said where to re-attach, and the job was not touched.
    should(before.map(one => one.jobName)).deepEqual(['watch']);
    should(asked).equal(1);
    should(code).equal(75);
    should(attached.io.errors.join('')).containEql('re-attach with: fy job attach');
    should((await service.get('ferret-a', 'watch')).state).equal('running');

    // Act 2 — the job ends while nobody is attached: it is unreported, and the backstop's source lists it exactly once.
    await Bun.write(flag, '');
    await waitFor(async () => (await service.get('ferret-a', 'watch')).state === 'exited', 'the job to end');
    one.clock.now = Date.now() + 1_000;
    const unattended = await service.endedUnattached(0);
    await service.markJobsReported(
      'ferret-a',
      unattended.map(entry => entry.job.id),
    );
    const after = await service.endedUnattached(0);

    // Assert
    should(unattended.map(entry => [entry.ferret, entry.job.name, entry.job.exitCode])).deepEqual([
      ['ferret-a', 'watch', 0],
    ]);
    should(after).deepEqual([]);
  });

  it('should count a job as told when a live attachment streamed its end, so the backstop stays quiet', async () => {
    // Arrange
    const one = await keeper();
    kept.push(one);
    const { sut } = verbs(one);

    // Act — run attaches from the start and returns when the job ends: that attachment reported the exit itself.
    const code = await sut.run(invocation(['echo done'], { name: 'quick' }));
    const service = one.service();

    // Assert
    should(code).equal(0);
    should(await service.endedUnattached(0)).deepEqual([]);
    should((await service.keptJobs('ferret-a'))[0]?.unreported).be.false();
  });

  it('should list the job with its exit code and wait for it', async () => {
    // Arrange
    const one = await keeper();
    kept.push(one);
    const { sut, io } = verbs(one);
    await sut.run(invocation(['sleep 0.3; exit 2'], { name: 'short' }));

    // Act
    const waited = await sut.wait(invocation(['short']));
    const listed = await sut.ls(invocation([]));

    // Assert
    should(waited).equal(2);
    should(listed).equal(0);
    should(io.printed.join('')).containEql('exit 2');
  });

  it('should stop a running job from the CLI and report the signal', async () => {
    // Arrange
    const one = await keeper();
    kept.push(one);
    const starter = verbs(one);
    const started = starter.sut.run(invocation(['echo up; sleep 60'], { name: 'long' }));
    await waitFor(() => starter.io.printed.join('').includes('up'), 'the job to be up');

    // Act
    const { sut, io } = verbs(one);
    const code = await sut.stopJob(invocation(['long']));
    const attached = await started;

    // Assert
    should(code).equal(0);
    should(io.printed.join('')).containEql('exit code 143 (SIGTERM)');
    should(attached).equal(143);
  });
});
