import { describe, it } from 'bun:test';
import should from 'should';
import { JobVerbs } from '../../../../cli/lib/jobs/controller.ts';
import type { IJobProcess, IJobSignals, IJobTimers } from '../../../../cli/lib/jobs/ports.ts';
import type { JobOutputView, JobView } from '../../../../contract/index.ts';
import { capturedIo, invocation, recordingClient, type RecordedCall } from '../../../support/cli/doubles.ts';

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 'aaaaaaaaaaa1',
  sessionId: 's1',
  name: 'build',
  command: 'bun test',
  cwd: '/work',
  state: 'running',
  startedAt: '2026-11-16T00:00:00.000Z' as never,
  startedBy: { by: 'agent', sessionId: 's1' },
  outputBytes: 0,
  attachments: 0,
  ...over,
});
const chunk = (text: string, next: number, over: Partial<JobOutputView> = {}): JobOutputView => ({
  text,
  next,
  size: next,
  job: job(),
  ended: false,
  detach: false,
  ...over,
});

class FakeSignals implements IJobSignals {
  handler: ((name: string) => void) | undefined;
  listen(onSignal: (name: string) => void) {
    this.handler = onSignal;
    return () => {
      this.handler = undefined;
    };
  }
}

function harness(answer: (call: RecordedCall) => unknown, stdout: string | undefined = undefined) {
  const { calls, client } = recordingClient(answer);
  const io = capturedIo();
  const signals = new FakeSignals();
  const exits: number[] = [];
  const process: IJobProcess = {
    pid: 4321,
    cwd: () => '/work',
    stdoutFile: () => stdout,
    exit: code => void exits.push(code),
  };
  let now = Date.parse('2026-11-16T00:10:00.000Z');
  const timers: IJobTimers = {
    nowMs: () => now,
    sleep: async ms => {
      now += ms;
    },
    deadline: ms => AbortSignal.timeout(ms),
  };
  return {
    calls,
    io,
    signals,
    exits,
    sut: new JobVerbs(client, io, { self: process, signals, timers, sessionId: 's1' }),
  };
}

const register = {
  id: 'att1',
  sessionId: 's1',
  jobId: 'aaaaaaaaaaa1',
  pid: 4321,
  registeredAt: '2026-11-16T00:00:00.000Z',
  detaching: false,
};

describe('fy job attach', () => {
  it("should stream the log until the job ends, then exit with the job's exit code", async () => {
    // Arrange
    const outputs = [chunk('one\n', 4), chunk('two\n', 8, { ended: true, job: job({ state: 'exited', exitCode: 3 }) })];
    const { sut, io, calls } = harness(call => {
      if (call.route.startsWith('GET') && call.route.endsWith('/output')) return outputs.shift();
      if (call.route.endsWith('/jobs/:jobId')) return job();
      if (call.route.startsWith('POST') && call.route.endsWith('job-attachments')) return register;
      return { ok: true };
    });

    // Act
    const code = await sut.attach(invocation(['build']));

    // Assert
    should(code).equal(3);
    should(io.printed.join('')).equal('one\ntwo\n');
    should(calls.filter(call => call.route.endsWith('/output')).map(call => call.query)).deepEqual([
      { tail: '100', attachment: 'att1' },
      { from: '4', attachment: 'att1' },
    ]);
    should(calls.at(-1)?.route).equal('DELETE /v1/ferrets/:ferretId/job-attachments/:attachmentId');
  });

  it('should register itself with its pid and, when its stdout is a Claude task file, the task id', async () => {
    // Arrange
    const { sut, calls } = harness(call => {
      if (call.route.endsWith('/output'))
        return chunk('', 0, { ended: true, job: job({ state: 'exited', exitCode: 0 }) });
      if (call.route.endsWith('/jobs/:jobId')) return job();
      if (call.route.startsWith('POST')) return register;
      return { ok: true };
    }, '/tmp/claude-1000/proj/uuid/tasks/btask123.output');

    // Act
    await sut.attach(invocation(['build'], { 'from-start': true }));

    // Assert
    should(calls.find(call => call.route === 'POST /v1/ferrets/:ferretId/job-attachments')?.body).deepEqual({
      jobId: 'aaaaaaaaaaa1',
      pid: 4321,
      claudeTaskId: 'btask123',
    });
    should(calls.find(call => call.route.endsWith('/output'))?.query).deepEqual({ from: '0', attachment: 'att1' });
  });

  it('should only DETACH on a signal: say so on stderr, exit 75, and never stop the job', async () => {
    // Arrange
    const h = harness(call => {
      if (call.route.endsWith('/output')) return chunk('x\n', 2);
      if (call.route.endsWith('/jobs/:jobId')) return job();
      if (call.route.startsWith('POST')) return register;
      return { ok: true };
    });
    const origin = h.io.out;
    h.io.out = text => {
      origin(text);
      h.signals.handler?.('SIGTERM'); // the signal arrives while it is streaming
    };

    // Act
    const code = await h.sut.attach(invocation(['build']));

    // Assert
    should(code).equal(75);
    should(h.io.errors.join('')).equal(
      'detached from job aaaaaaaaaaa1 (build); it is still running — re-attach with: fy job attach aaaaaaaaaaa1\n',
    );
    should(h.calls.some(call => call.route.endsWith('/stop'))).be.false();
  });

  it('should detach when the daemon asks it to (a move)', async () => {
    // Arrange
    const { sut, io } = harness(call => {
      if (call.route.endsWith('/output')) return chunk('', 0, { detach: true });
      if (call.route.endsWith('/jobs/:jobId')) return job();
      if (call.route.startsWith('POST')) return register;
      return { ok: true };
    });

    // Act + Assert
    should(await sut.attach(invocation(['build']))).equal(75);
    should(io.errors.join('')).containEql('it is still running');
  });

  it('should detach, not hang, when the daemon stays out of reach', async () => {
    // Arrange
    const { sut, io } = harness(call => {
      if (call.route.endsWith('/jobs/:jobId')) return job();
      if (call.route.endsWith('/output')) throw new Error('connection refused');
      if (call.route.startsWith('POST')) return register;
      return { ok: true };
    });

    // Act + Assert
    should(await sut.attach(invocation(['build']))).equal(75);
    should(io.errors.join('')).containEql('lost contact with the daemon');
  });

  it('should exit 70 and say so for a job that ended without an exit record', async () => {
    // Arrange
    const { sut, io } = harness(call => {
      if (call.route.endsWith('/output')) return chunk('', 0, { ended: true, job: job({ state: 'lost' }) });
      if (call.route.endsWith('/jobs/:jobId')) return job();
      if (call.route.startsWith('POST')) return register;
      return { ok: true };
    });

    // Act + Assert
    should(await sut.attach(invocation(['build']))).equal(70);
    should(io.errors.join('')).containEql('without recording an exit');
  });

  it('should refuse outside a ferret without --session', async () => {
    // Arrange
    const { calls, client } = recordingClient(() => ({}));
    const io = capturedIo();
    const sut = new JobVerbs(client, io, {
      self: { pid: 1, cwd: () => '/', stdoutFile: () => undefined, exit: () => undefined },
      signals: new FakeSignals(),
      timers: { nowMs: () => 0, sleep: async () => undefined, deadline: () => AbortSignal.abort() },
      sessionId: undefined,
    });

    // Act + Assert
    should(await sut.attach(invocation(['build']))).equal(2);
    should(calls).deepEqual([]);
  });
});

describe('fy job run', () => {
  it("should start the job in the caller's folder, name it, then follow it from the start", async () => {
    // Arrange
    const { sut, calls, io } = harness(call => {
      if (call.route === 'POST /v1/ferrets/:ferretId/jobs') return job();
      if (call.route.endsWith('/output'))
        return chunk('hi\n', 3, { ended: true, job: job({ state: 'exited', exitCode: 0 }) });
      if (call.route.startsWith('POST')) return register;
      return { ok: true };
    });

    // Act
    const code = await sut.run(invocation(['bun', 'test', 'a b'], { name: 'build' }));

    // Assert
    should(code).equal(0);
    should(calls[0]?.body).deepEqual({ command: "bun test 'a b'", cwd: '/work', name: 'build' });
    should(io.errors.join('')).equal('started job aaaaaaaaaaa1 (build)\n');
    should(calls.find(call => call.route.endsWith('/output'))?.query).deepEqual({ from: '0', attachment: 'att1' });
  });

  it('should ask for a command', async () => {
    const { sut, io } = harness(() => ({}));
    should(await sut.run(invocation([]))).equal(2);
    should(io.errors.join('')).containEql('give a command');
  });
});

describe('fy job wait, stop, logs and ls', () => {
  it('should wait for the end and exit with the code', async () => {
    const answers = [job(), job({ state: 'exited', exitCode: 7 })];
    const { sut, io } = harness(() => answers.shift());
    should(await sut.wait(invocation(['build']))).equal(7);
    should(io.printed.join('')).equal('job aaaaaaaaaaa1 (build) ended: exit code 7\n');
  });

  it('should time out with 124 and leave the job alone', async () => {
    const { sut, io, calls } = harness(() => job());
    should(await sut.wait(invocation(['build'], { timeout: '1s' }))).equal(124);
    should(io.errors.join('')).containEql('still running after 1s');
    should(calls.some(call => call.route.endsWith('/stop'))).be.false();
  });

  it('should refuse a timeout it cannot read', async () => {
    const { sut } = harness(() => job());
    should(await sut.wait(invocation(['build'], { timeout: 'soon' }))).equal(2);
  });

  it('should stop a job and report how it ended, naming the signal', async () => {
    const { sut, io } = harness(() => job({ state: 'exited', exitCode: 143, signal: 'TERM' }));
    should(await sut.stopJob(invocation(['build']))).equal(0);
    should(io.printed.join('')).equal('job aaaaaaaaaaa1 (build) ended: exit code 143 (SIGTERM)\n');
  });

  it('should print the whole log without following it', async () => {
    const outputs = [chunk('a\n', 2, { size: 4 }), chunk('b\n', 4, { size: 4 })];
    const { sut, io } = harness(call => (call.route.endsWith('/output') ? outputs.shift() : job()));
    should(await sut.logs(invocation(['build']))).equal(0);
    should(io.printed.join('')).equal('a\nb\n');
  });

  it('should list running jobs and the latest finished with their exit codes and ages', async () => {
    const { sut, io } = harness(() => ({
      sessionId: 's1',
      jobs: [
        job(),
        job({
          id: 'bbbbbbbbbbb2',
          name: 'old',
          state: 'exited',
          exitCode: 1,
          startedAt: '2026-11-14T00:00:00.000Z' as never,
        }),
      ],
      limits: { runningPerFerret: 8, runningGlobal: 48, running: 1, retentionDays: 7, retainedFinishedPerFerret: 50 },
    }));
    should(await sut.ls(invocation([]))).equal(0);
    const lines = io.printed.join('').trimEnd().split('\n');
    should(lines[0]).startWith('ID');
    should(lines[1]).containEql('running');
    should(lines[1]).containEql('10m');
    should(lines[2]).containEql('exit 1');
    should(lines[2]).containEql('2d');
  });
});

describe('fy job: the edges', () => {
  it('should detach, not wait on, a signal that comes while waiting', async () => {
    let asks = 0;
    const again = harness(() => {
      asks += 1;
      if (asks === 2) again.signals.handler?.('SIGHUP');
      return job();
    });
    should(await again.sut.wait(invocation(['build']))).equal(75);
    should(again.io.errors.join('')).containEql('detached from job');
  });

  it('should say a job did not stop in time when it still runs after the stop', async () => {
    const { sut, io } = harness(() => job());
    should(await sut.stopJob(invocation(['build']))).equal(1);
    should(io.errors.join('')).containEql('did not stop in time');
  });

  it('should list as JSON and say when there are no jobs', async () => {
    const view = {
      sessionId: 's1',
      jobs: [job()],
      limits: { runningPerFerret: 8, runningGlobal: 48, running: 1, retentionDays: 7, retainedFinishedPerFerret: 50 },
    };
    const json = harness(() => view);
    should(await json.sut.ls(invocation([], { json: true }))).equal(0);
    should(JSON.parse(json.io.printed.join('')).jobs).have.length(1);
    const none = harness(() => ({ ...view, jobs: [] }));
    should(await none.sut.ls(invocation([]))).equal(0);
    should(none.io.printed.join('')).equal('no jobs\n');
  });

  it('should hide the older finished jobs and say how to see them, and show them with --all', async () => {
    const finished = Array.from({ length: 12 }, (_, index) =>
      job({ id: `${String(index).padStart(12, 'c')}`, name: `done-${index}`, state: 'exited', exitCode: 0 }),
    );
    const view = {
      sessionId: 's1',
      jobs: finished,
      limits: { runningPerFerret: 8, runningGlobal: 48, running: 0, retentionDays: 7, retainedFinishedPerFerret: 50 },
    };
    const some = harness(() => view);
    await some.sut.ls(invocation([]));
    should(some.io.printed.join('')).containEql('(2 older finished jobs hidden: fy job ls --all)');
    const all = harness(() => view);
    await all.sut.ls(invocation([], { all: true }));
    should(all.io.printed.join('')).not.containEql('hidden');
  });

  it('should still stream when the daemon will not take its registration', async () => {
    const { sut, io } = harness(call => {
      if (call.route === 'POST /v1/ferrets/:ferretId/job-attachments') throw new Error('refused');
      if (call.route.endsWith('/output'))
        return chunk('ok\n', 3, { ended: true, job: job({ state: 'exited', exitCode: 0 }) });
      return job();
    });
    should(await sut.attach(invocation(['build']))).equal(0);
    should(io.printed.join('')).equal('ok\n');
  });
});

describe('fy job: the signal deadline', () => {
  const hang = (): Promise<never> => new Promise(() => undefined);
  const answers = (stuck: (call: RecordedCall) => boolean) => (call: RecordedCall) => {
    if (stuck(call)) return hang();
    if (call.route.endsWith('/output')) return chunk('x\n', 2);
    if (call.route.endsWith('/jobs/:jobId')) return job();
    if (call.route.startsWith('POST') && call.route.endsWith('job-attachments')) return register;
    return { ok: true };
  };

  it('should detach and END the process when a signal lands while the daemon is not answering a poll', async () => {
    // Arrange
    const h = harness(answers(call => call.route.endsWith('/output')));
    const running = h.sut.attach(invocation(['build']));
    await Promise.resolve();
    await Promise.resolve();

    // Act
    h.signals.handler?.('SIGTERM');

    // Assert
    should(await running).equal(75);
    should(h.exits).deepEqual([75]);
    should(h.io.errors.join('')).containEql('detached from job aaaaaaaaaaa1');
  });

  it('should carry the abort into every call and give the goodbye a deadline of its own', async () => {
    // Arrange
    const h = harness(answers(() => false));
    const out = h.io.out;
    h.io.out = text => {
      out(text);
      h.signals.handler?.('SIGTERM');
    };

    // Act
    await h.sut.attach(invocation(['build']));

    // Assert
    const unregister = h.calls.find(call => call.route.startsWith('DELETE'));
    should(unregister?.signal).not.be.undefined();
    should(unregister?.signal).not.equal(h.calls.find(call => call.route.endsWith('/output'))?.signal);
    for (const call of h.calls.filter(call => !call.route.startsWith('DELETE'))) should(call.signal).not.be.undefined();
  });

  it('should not wait on an unregister the daemon never answers', async () => {
    // Arrange
    const h = harness(answers(call => call.route.startsWith('DELETE')));
    const out = h.io.out;
    h.io.out = text => {
      out(text);
      h.signals.handler?.('SIGTERM');
    };

    // Act + Assert
    should(await h.sut.attach(invocation(['build']))).equal(75);
    should(h.exits).deepEqual([75]);
  });

  it('should keep hearing signals through the goodbye of a job that ended on its own, and exit 75', async () => {
    // Arrange
    let during: unknown;
    const hold: { signals?: FakeSignals } = {};
    const h = harness(call => {
      if (call.route.endsWith('/output'))
        return chunk('', 0, { ended: true, job: job({ state: 'exited', exitCode: 3 }) });
      if (call.route.endsWith('/jobs/:jobId')) return job();
      if (call.route.startsWith('POST')) return register;
      if (call.route.startsWith('DELETE')) {
        during = hold.signals?.handler;
        hold.signals?.handler?.('SIGTERM');
      }
      return { ok: true };
    });
    hold.signals = h.signals;

    // Act
    await h.sut.attach(invocation(['build']));

    // Assert
    should(during).be.a.Function();
    should(h.exits).deepEqual([75]);
  });

  it('should detach cleanly (75) when the signal lands during the start request of fy job run', async () => {
    // Arrange
    const h = harness(answers(call => call.route === 'POST /v1/ferrets/:ferretId/jobs'));
    const running = h.sut.run(invocation(['sleep 60'], {}));
    await Promise.resolve();

    // Act
    h.signals.handler?.('SIGTERM');

    // Assert
    should(await running).equal(75);
    should(h.exits).deepEqual([75]);
    should(h.io.errors.join('')).containEql('detached before the daemon confirmed');
  });

  it('should detach and end when the signal lands while wait is parked on the daemon', async () => {
    // Arrange
    const h = harness(answers(call => call.route.endsWith('/jobs/:jobId')));
    const waiting = h.sut.wait(invocation(['build']));
    await Promise.resolve();

    // Act
    h.signals.handler?.('SIGTERM');

    // Assert
    should(await waiting).equal(75);
    should(h.exits).deepEqual([75]);
  });

  it('should detach and end when the signal lands while attach is still looking the job up', async () => {
    // Arrange
    const h = harness(answers(call => call.route.endsWith('/jobs/:jobId')));
    const running = h.sut.attach(invocation(['build']));
    await Promise.resolve();

    // Act
    h.signals.handler?.('SIGTERM');

    // Assert
    should(await running).equal(75);
    should(h.exits).deepEqual([75]);
    should(h.io.errors.join('')).containEql('detached from job build (build)');
  });

  it('should report a failed lookup as an error, not a detach, when no signal was heard (attach and wait)', async () => {
    // Arrange
    const h = harness(call => {
      if (call.route.endsWith('/jobs/:jobId')) throw new Error('no such job');
      return {};
    });

    // Act + Assert
    should(await h.sut.attach(invocation(['build']))).equal(1);
    should(await h.sut.wait(invocation(['build']))).equal(1);
    should(h.exits).deepEqual([]);
    should(h.io.errors.join('')).containEql('no such job');
  });

  it('should leave the process to end by itself when no signal was heard', async () => {
    // Arrange
    const h = harness(call => {
      if (call.route.endsWith('/output'))
        return chunk('', 0, { ended: true, job: job({ state: 'exited', exitCode: 0 }) });
      if (call.route.endsWith('/jobs/:jobId')) return job();
      return register;
    });

    // Act + Assert
    should(await h.sut.attach(invocation(['build']))).equal(0);
    should(h.exits).deepEqual([]);
  });
});
