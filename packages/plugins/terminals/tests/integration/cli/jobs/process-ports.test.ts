import { describe, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import should from 'should';
import { RealJobProcess, RealJobSignals, RealJobTimers } from '../../../../cli/adapters/jobs/process-ports.ts';

describe('the real process ports of the job verbs', () => {
  it('should read this process, and learn its stdout file only when it is a file', () => {
    const real = new RealJobProcess();
    should(real.pid).equal(process.pid);
    should(real.cwd()).equal(process.cwd());
    should(['string', 'undefined']).containEql(typeof real.stdoutFile());
    should(new RealJobProcess(() => '/tmp/claude-1/p/s/tasks/abc.output').stdoutFile()).equal(
      '/tmp/claude-1/p/s/tasks/abc.output',
    );
    should(new RealJobProcess(() => 'pipe:[123]').stdoutFile()).be.undefined();
    should(
      new RealJobProcess(() => {
        throw new Error('no /proc here');
      }).stdoutFile(),
    ).be.undefined();
  });

  it('should hear the three signals while listening, and none once it stopped', () => {
    const heard: string[] = [];
    // Its own emitter: raising SIGTERM on the shared test process would reach every other test's handler (some end the process).
    const source = new EventEmitter();
    const stop = new RealJobSignals(source as never).listen(name => heard.push(name));
    for (const name of ['SIGTERM', 'SIGHUP', 'SIGINT']) source.emit(name);
    stop();
    source.emit('SIGTERM');
    should(heard).deepEqual(['SIGTERM', 'SIGHUP', 'SIGINT']);
    should(source.listenerCount('SIGHUP')).equal(0);
    // The default source is the real process: listening adds a handler for each signal and stopping takes it away again.
    const before = process.listenerCount('SIGTERM');
    const real = new RealJobSignals().listen(() => undefined);
    should(process.listenerCount('SIGTERM')).equal(before + 1);
    real();
    should(process.listenerCount('SIGTERM')).equal(before);
  });

  it('should keep the clock and sleep, and wake early when told to', async () => {
    const timers = new RealJobTimers();
    should(Math.abs(timers.nowMs() - Date.now())).be.below(1000);
    await timers.sleep(5);
    const abort = new AbortController();
    const waiting = timers.sleep(60_000, abort.signal);
    abort.abort();
    await waiting;
    await timers.sleep(60_000, AbortSignal.abort());
  });
});
