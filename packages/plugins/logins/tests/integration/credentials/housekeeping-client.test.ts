/**
 * The daemon's end of the housekeeping worker: one thread started on first use with exactly the two grants, a job
 * answered by its id, and every way a job can fail coming back as ONE fixed sentence. A scripted worker stands in for the
 * thread here; the last test starts the REAL worker program on a real thread with no grant at all.
 */
import { describe, expect, test } from 'bun:test';
import type { Cancel, WorkerHandle, WorkerStartOptions } from '@ferretry/kernel/contract';
import { bunWorkers } from '@ferretry/kernel/host';
import type { ActiveUsageRead } from '../../../daemon/lib/credentials/credential-status.ts';
import {
  HOUSEKEEPING_FAILED,
  HOUSEKEEPING_HOSTS,
  HOUSEKEEPING_WORKER_URL,
  housekeepingClient,
} from '../../../daemon/adapters/credentials/housekeeping-client.ts';

const NOW = 1_800_000_000_000;
const TOKEN = 'oauth-access-TESTONLY-client';
const READ = {
  result: { usageBased: true, ok: true },
  local: { shape: { kind: 'decided' } },
} as unknown as ActiveUsageRead;

class ScriptedWorker implements WorkerHandle {
  readonly posted: unknown[] = [];
  terminated = 0;
  readonly #messages = new Set<(message: unknown) => void>();
  readonly #exits = new Set<(exit: { code: number }) => void>();
  post(message: unknown): void {
    this.posted.push(message);
  }
  onMessage(listener: (message: unknown) => void): Cancel {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }
  onExit(listener: (exit: { code: number }) => void): Cancel {
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }
  async terminate(): Promise<void> {
    this.terminated += 1;
  }
  say(message: unknown): void {
    for (const listener of this.#messages) listener(message);
  }
  die(): void {
    for (const listener of this.#exits) listener({ code: 1 });
  }
  idOf(index: number): number {
    return (this.posted[index] as { id: number }).id;
  }
}

const workerAt = (started: readonly { readonly worker: ScriptedWorker }[], index: number): ScriptedWorker => {
  const entry = started[index];
  if (entry === undefined) throw new Error('no worker was started');
  return entry.worker;
};

function fixture(options: { readonly terminate?: () => Promise<void> } = {}) {
  const started: { url: URL; options: WorkerStartOptions | undefined; worker: ScriptedWorker }[] = [];
  const timers: { delay: number; fn: () => void; cancelled: boolean }[] = [];
  const client = housekeepingClient({
    workers: {
      start: (url, given) => {
        const worker = new ScriptedWorker();
        if (options.terminate !== undefined) worker.terminate = options.terminate;
        started.push({ url, options: given, worker });
        return worker;
      },
    },
    clock: {
      nowMs: () => NOW,
      after: (delay, fn) => {
        const timer = { delay: Number(delay), fn, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  });
  return { client, started, timers };
}
const rejection = async (promise: Promise<unknown>): Promise<string> =>
  await promise.then(
    () => 'resolved',
    (error: Error) => error.message,
  );

describe('the housekeeping client', () => {
  test('starts the thread once, on first use, with the credentials root (read) and the two provider hosts only', async () => {
    const f = fixture();
    expect(f.started).toEqual([]);

    const first = f.client.activeUsage('claude', 'claude/.credentials.json');
    const second = f.client.activeUsage('codex', 'codex/auth.json');
    const worker = workerAt(f.started, 0);
    worker.say({ type: 'result', id: worker.idOf(0), ok: true, value: READ });
    worker.say({ type: 'result', id: worker.idOf(1), ok: true, value: READ });

    expect(await Promise.all([first, second])).toEqual([READ, READ]);
    expect(f.started).toHaveLength(1);
    expect(f.started[0]?.url).toBe(HOUSEKEEPING_WORKER_URL);
    expect(f.started[0]?.options).toEqual({
      name: 'housekeeping',
      roots: ['credentials'],
      network: HOUSEKEEPING_HOSTS,
    });
    expect(HOUSEKEEPING_HOSTS).toEqual(['api.anthropic.com', 'chatgpt.com']);
    expect(worker.posted).toEqual([
      {
        type: 'job',
        id: worker.idOf(0),
        job: { kind: 'credential.active', harness: 'claude', file: 'claude/.credentials.json', nowMs: NOW },
      },
      {
        type: 'job',
        id: worker.idOf(1),
        job: { kind: 'credential.active', harness: 'codex', file: 'codex/auth.json', nowMs: NOW },
      },
    ]);
    expect(f.timers.every(timer => timer.cancelled && timer.delay === 30_000)).toBe(true);
  });

  test('answers a job with a failure by the fixed sentence, and a malformed answer is as good as none', async () => {
    const f = fixture();
    const failed = f.client.activeUsage('claude', 'a');
    const worker = workerAt(f.started, 0);
    worker.say({ type: 'result', id: worker.idOf(0), ok: false, failure: 'internal' });
    expect(await rejection(failed)).toBe(HOUSEKEEPING_FAILED);

    const hollow = f.client.activeUsage('claude', 'b');
    worker.say({ type: 'result', id: worker.idOf(1), ok: true, value: { result: {} } });
    expect(await rejection(hollow)).toBe(HOUSEKEEPING_FAILED);

    const pending = f.client.activeUsage('claude', 'c');
    for (const noise of [
      null,
      'text',
      { type: 'metrics' },
      { type: 'result', id: 'x' },
      { type: 'result', id: 999, ok: true, value: READ },
    ])
      worker.say(noise);
    worker.say({ type: 'result', id: worker.idOf(2), ok: true, value: READ });
    expect(await pending).toEqual(READ);
  });

  test('never says what the worker said: an error that quotes a token comes back as the fixed sentence', async () => {
    const f = fixture();
    const read = f.client.activeUsage('claude', 'a');
    const worker = workerAt(f.started, 0);
    worker.say({ type: 'result', id: worker.idOf(0), ok: false, failure: `Bearer ${TOKEN}` });
    const message = await rejection(read);
    expect(message).toBe(HOUSEKEEPING_FAILED);
    expect(message.includes(TOKEN)).toBe(false);
  });

  test('a thread that ends fails every job waiting on it, and the next job starts a new thread', async () => {
    const f = fixture();
    const one = f.client.activeUsage('claude', 'a');
    const two = f.client.activeUsage('claude', 'b');
    workerAt(f.started, 0).die();
    expect([await rejection(one), await rejection(two)]).toEqual([HOUSEKEEPING_FAILED, HOUSEKEEPING_FAILED]);

    const again = f.client.activeUsage('claude', 'c');
    expect(f.started).toHaveLength(2);
    const fresh = workerAt(f.started, 1);
    fresh.say({ type: 'result', id: fresh.idOf(0), ok: true, value: READ });
    expect(await again).toEqual(READ);
    // An old thread's late exit does not end the new one.
    workerAt(f.started, 0).die();
    expect(f.started).toHaveLength(2);
  });

  test('a job that overruns its deadline is failed and its thread ended, so the next job gets a clean one', async () => {
    const f = fixture();
    const stuck = f.client.activeUsage('claude', 'a');
    const worker = workerAt(f.started, 0);
    f.timers[0]?.fn();
    expect(await rejection(stuck)).toBe(HOUSEKEEPING_FAILED);
    expect(worker.terminated).toBe(1);

    // A late answer for the job that was given up on is ignored.
    worker.say({ type: 'result', id: worker.idOf(0), ok: true, value: READ });
    const next = f.client.activeUsage('claude', 'b');
    expect(f.started).toHaveLength(2);
    const fresh = workerAt(f.started, 1);
    fresh.say({ type: 'result', id: fresh.idOf(0), ok: true, value: READ });
    expect(await next).toEqual(READ);
  });

  test('a thread that cannot start, or refuses the post, fails the job by the fixed sentence and leaves nothing waiting', async () => {
    const timers: { cancelled: boolean }[] = [];
    const clock = {
      nowMs: () => NOW,
      after: (_delay: unknown, _fn: () => void) => {
        const timer = { cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    };
    const refused = housekeepingClient({
      workers: {
        start: () => {
          throw new Error(`refused ${TOKEN}`);
        },
      },
      clock,
    });
    const startFailure = await rejection(refused.activeUsage('claude', 'a'));
    expect(startFailure).toBe(HOUSEKEEPING_FAILED);
    expect(startFailure.includes(TOKEN)).toBe(false);
    expect(timers).toEqual([]);

    const worker = new ScriptedWorker();
    worker.post = () => {
      throw new Error('channel closed');
    };
    const posting = housekeepingClient({ workers: { start: () => worker }, clock });
    expect(await rejection(posting.activeUsage('claude', 'b'))).toBe(HOUSEKEEPING_FAILED);
    // The timer was cleared, and a late answer for the dropped job finds nothing waiting.
    expect(timers.map(timer => timer.cancelled)).toEqual([true]);
    worker.say({ type: 'result', id: 0, ok: true, value: READ });
    await posting.stop();
  });

  test('stop ends the thread and fails what waits; a stopped client starts nothing; stopping twice is harmless', async () => {
    const f = fixture({ terminate: async () => Promise.reject(new Error('already gone')) });
    const waiting = f.client.activeUsage('claude', 'a');
    await f.client.stop();
    expect(await rejection(waiting)).toBe(HOUSEKEEPING_FAILED);
    expect(await rejection(f.client.activeUsage('claude', 'b'))).toBe(HOUSEKEEPING_FAILED);
    await f.client.stop();
    expect(f.started).toHaveLength(1);

    const idle = fixture();
    await idle.client.stop();
    expect(idle.started).toEqual([]);
  });
});

describe('the real worker program, on a real thread with no grant', () => {
  const ask = (message: unknown): Promise<unknown> => {
    const worker = bunWorkers().start(HOUSEKEEPING_WORKER_URL, { name: 'housekeeping-probe', env: {} });
    return new Promise<unknown>(resolve => {
      worker.onMessage(answer => {
        void worker.terminate();
        resolve(answer);
      });
      worker.post(message);
    });
  };

  test('answers the probe, and a job it has no grant for with a fixed word and nothing else', async () => {
    expect(await ask({ probe: true })).toEqual({ probe: true });
    expect(
      await ask({
        type: 'job',
        id: 4,
        job: { kind: 'credential.active', harness: 'claude', file: 'claude/.credentials.json', nowMs: NOW },
      }),
    ).toEqual({ type: 'result', id: 4, ok: false, failure: 'internal' });
  });
});
