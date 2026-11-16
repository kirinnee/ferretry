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
      self: { pid, cwd: () => one.home, stdoutFile: () => undefined },
      signals,
      timers: {
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
