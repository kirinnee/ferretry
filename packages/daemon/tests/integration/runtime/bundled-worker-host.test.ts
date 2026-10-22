/**
 * ONE WORKER THREAD, ASKED BY REQUEST, THROUGH EVERY FAILURE A THREAD CAN HAVE.
 *
 * A scripted thread stands in for the real one, so each case can make it answer, refuse, stall, crash
 * or talk out of turn on cue: the host must settle each request by its own id, greet every new thread
 * before its first request, pass on what answers nothing, end an idle thread on the idle time it reads
 * at that moment, ignore a thread it has already replaced — and, with a restart policy, back a failing
 * thread off and finally retire it, so a caller can do the work somewhere else.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  BundledWorkerHost,
  type BundledWorkerHostOptions,
  type HostedAnswer,
  type HostedWorker,
} from '../../../src/adapters/runtime/bundled-worker-host.ts';

type Request = { readonly id: number; readonly ask: string } | { readonly hello: true };
type Response =
  | { readonly id: number; readonly value: string }
  | { readonly id: number; readonly error: string }
  | { readonly note: string };

/** A thread a test drives: it records what it was sent and answers however the test says. */
class ScriptedThread implements HostedWorker<Request, Response> {
  onmessage: ((event: MessageEvent<Response>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: Request[] = [];
  terminated = false;
  unrefed = false;

  constructor(private readonly answer: (request: Request, thread: ScriptedThread) => void) {}

  postMessage(request: Request): void {
    this.sent.push(request);
    queueMicrotask(() => this.answer(request, this));
  }

  reply(response: Response): void {
    this.onmessage?.({ data: response } as MessageEvent<Response>);
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }

  unref(): void {
    this.unrefed = true;
  }
}

const answerOf = (response: Response): HostedAnswer<string> | undefined => {
  if (!('id' in response)) return undefined;
  return 'value' in response
    ? { id: response.id, ok: true, value: response.value }
    : { id: response.id, ok: false, error: new Error(response.error) };
};

/** Answers every request with its own question, upper-cased. */
const echo = (request: Request, thread: ScriptedThread): void => {
  if ('id' in request) thread.reply({ id: request.id, value: request.ask.toUpperCase() });
};

function hostOf(
  script: (request: Request, thread: ScriptedThread) => void,
  options: Partial<BundledWorkerHostOptions<Request, Response, string>> = {},
) {
  const threads: ScriptedThread[] = [];
  const host = new BundledWorkerHost<Request, Response, string>({
    label: 'the test worker',
    spawn: () => {
      const thread = new ScriptedThread(script);
      threads.push(thread);
      return thread;
    },
    answer: answerOf,
    timeoutMs: 1_000,
    idleMs: () => 1_000,
    ...options,
  });
  const ask = async (ask: string): Promise<string> => {
    const id = host.nextId();
    return await host.request(id, { id, ask }, `answer ${ask}`);
  };
  return { host, threads, ask };
}

const refusal = async (pending: Promise<unknown>): Promise<string> =>
  await pending.then(
    () => 'answered',
    (error: Error) => error.message,
  );

describe('BundledWorkerHost', () => {
  it('should start one thread on demand, greet it first, and settle each request by its own id', async () => {
    // Arrange
    const { host, threads, ask } = hostOf(echo, { greeting: () => ({ hello: true }) });

    // Act
    const before = threads.length;
    const answers = await Promise.all([ask('one'), ask('two')]);
    host.close();

    // Assert
    should(before).equal(0);
    should(answers).deepEqual(['ONE', 'TWO']);
    should(threads).have.length(1);
    should(threads[0]?.sent[0]).deepEqual({ hello: true });
    should(threads[0]?.unrefed).be.true();
  });

  it('should refuse a request the thread refused, and keep the thread', async () => {
    // Arrange
    const { host, threads, ask } = hostOf((request, thread) => {
      if ('id' in request) thread.reply({ id: request.id, error: 'could not' });
    });

    // Act
    const refused = await refusal(ask('x'));
    await refusal(ask('y'));
    host.close();

    // Assert
    should(refused).equal('could not');
    should(threads).have.length(1);
  });

  it('should hand on what answers no request, and drop an answer to a request nobody made', async () => {
    // Arrange
    const others: Response[] = [];
    const { host, ask } = hostOf(
      (request, thread) => {
        if (!('id' in request)) return;
        thread.reply({ note: 'metrics' });
        thread.reply({ id: request.id + 100, value: 'stray' });
        thread.reply({ id: request.id, value: 'mine' });
      },
      { other: message => others.push(message) },
    );

    // Act
    const answer = await ask('x');
    host.close();

    // Assert
    should(answer).equal('mine');
    should(others).deepEqual([{ note: 'metrics' }]);
  });

  it('should count what the thread holds, and end an idle thread on the idle time read when it went idle', async () => {
    // Arrange
    let idleMs = 5;
    const { host, threads, ask } = hostOf(echo, { idleMs: () => idleMs });

    // Act
    const held = (() => {
      const pending = ask('x');
      return { pending, inFlight: host.inFlight };
    })();
    await held.pending;
    const settled = host.inFlight;
    await Bun.sleep(30);
    const endedWhenIdle = threads[0]?.terminated;
    idleMs = 10_000;
    await ask('y');
    await Bun.sleep(30);
    const keptWhenIdle = threads[1]?.terminated;
    host.close();

    // Assert
    should([held.inFlight, settled]).deepEqual([1, 0]);
    should(endedWhenIdle).be.true();
    should(keptWhenIdle).be.false();
    should(threads).have.length(2);
  });

  it('should quote the runtime when a thread fails, unless told how to say it', async () => {
    // Arrange
    const crashing = (request: Request, thread: ScriptedThread) => {
      if ('id' in request) thread.crash('the secret word');
    };
    const quoting = hostOf(crashing);
    const fixed = hostOf(crashing, { failure: () => 'the test worker stopped' });

    // Act
    const quoted = await refusal(quoting.ask('x'));
    const said = await refusal(fixed.ask('x'));

    // Assert
    should(quoted).equal('the test worker failed: the secret word');
    should(said).equal('the test worker stopped');
    should(quoting.threads[0]?.terminated).be.true();
  });

  it('should give up on a thread that does not answer in time, and ignore anything it says after', async () => {
    // Arrange
    const others: Response[] = [];
    const { host, threads, ask } = hostOf(() => undefined, { timeoutMs: 5, other: message => others.push(message) });

    // Act
    const stalled = await refusal(ask('x'));
    threads[0]?.reply({ note: 'late' });
    threads[0]?.crash('late crash');
    host.close();

    // Assert
    should(stalled).equal('the test worker did not answer x within 5 ms');
    should(threads[0]?.terminated).be.true();
    should(others).deepEqual([]);
  });

  it('should refuse everything waiting on a closed thread', async () => {
    // Arrange
    const { host, ask } = hostOf(() => undefined);

    // Act
    const waiting = refusal(ask('x'));
    await Bun.sleep(1);
    host.close();

    // Assert
    should(await waiting).equal('the test worker was closed');
  });

  it('should back a failing thread off, doubling to the cap, then retire it after too many failures', async () => {
    // Arrange
    let now = 0;
    const retired: number[] = [];
    const { host, ask } = hostOf(
      (request, thread) => {
        if ('id' in request) thread.crash('down');
      },
      {
        now: () => now,
        restart: { backoffMs: 100, maxBackoffMs: 250, maxFailures: 4, windowMs: 10_000 },
        retired: () => retired.push(now),
      },
    );
    const availability: boolean[] = [];

    // Act — each failure backs off; asking while backed off is refused without a thread.
    await refusal(ask('1'));
    availability.push(host.available);
    const whileBackedOff = await refusal(ask('during'));
    now = 100;
    availability.push(host.available);
    await refusal(ask('2'));
    now = 299;
    availability.push(host.available);
    now = 300;
    await refusal(ask('3'));
    now = 549;
    availability.push(host.available);
    now = 550;
    await refusal(ask('4'));
    now = 100_000;

    // Assert
    should(availability).deepEqual([false, true, false, false]);
    should(whileBackedOff).equal('the test worker is not available');
    should(host.retired).be.true();
    should(host.available).be.false();
    should(retired).deepEqual([550]);
  });

  it('should forget failures older than the window, so an occasional crash never retires the thread', async () => {
    // Arrange
    let now = 0;
    let crash = true;
    const { host, ask } = hostOf(
      (request, thread) => {
        if (!('id' in request)) return;
        if (crash) thread.crash('down');
        else thread.reply({ id: request.id, value: 'up' });
      },
      { now: () => now, restart: { backoffMs: 1, maxBackoffMs: 1, maxFailures: 2, windowMs: 1_000 } },
    );

    // Act
    await refusal(ask('1'));
    now = 5_000;
    await refusal(ask('2'));
    now = 5_002;
    crash = false;
    const recovered = await ask('3');
    host.close();

    // Assert
    should(host.retired).be.false();
    should(recovered).equal('up');
  });
});
