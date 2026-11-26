import { describe, expect, test } from 'bun:test';
import type { WorkerHandle, WorkersPort } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { startReplyThread, startSpeechThread } from '../../../daemon/adapters/worker-speech-thread.ts';

/**
 * A WORKER THREAD THAT NEVER ANSWERS (E-434). The native host has had a deadline on every call since it was a child
 * process; the WebAssembly engines' worker threads are held to the same ones: a call that has not answered by its deadline
 * fails with a sentence, the worker is ended, and a worker that answers in time is left alone.
 */
class FakeWorker implements WorkerHandle {
  readonly posted: { id: number; kind: string }[] = [];
  terminated = 0;
  private readonly messages: ((message: unknown) => void)[] = [];
  private readonly exits: ((exit: never) => void)[] = [];
  post(message: unknown): void {
    this.posted.push(message as { id: number; kind: string });
  }
  onMessage(listener: (message: unknown) => void) {
    this.messages.push(listener);
    return () => undefined;
  }
  onExit(listener: (exit: never) => void) {
    this.exits.push(listener);
    return () => undefined;
  }
  async terminate(): Promise<void> {
    this.terminated += 1;
  }
  answer(id: number, fields: object): void {
    for (const listener of this.messages) listener({ id, ok: true, ...fields });
  }
}

const hold = (): { workers: Pick<WorkersPort, 'start'>; worker: FakeWorker } => {
  const worker = new FakeWorker();
  return { worker, workers: { start: () => worker } };
};
const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error as Error,
  );

describe('worker-thread call deadlines', () => {
  test('a speech worker that never answers a transcribe fails the call at its deadline and is ended', async () => {
    const clock = fixedClock();
    const { workers, worker } = hold();
    const thread = startSpeechThread(workers, clock);
    const stops: number[] = [];
    thread.onEnd(() => void stops.push(1));
    const waiting = settle(thread.call({ kind: 'transcribe', samples: new Float32Array(8) }));
    await clock.advance(119_000);
    expect(worker.terminated).toBe(0);
    await clock.advance(2_000);
    const failure = await waiting;
    expect(failure?.message).toBe('The speech worker did not answer in 120 seconds, so it was stopped.');
    expect(worker.terminated).toBe(1);
    expect(stops).toEqual([1]);
    await expect(thread.call({ kind: 'transcribe', samples: new Float32Array(8) })).rejects.toThrow(/stopped/u);
  });

  test('a reply worker that never answers a speak is stopped at 60 seconds', async () => {
    const clock = fixedClock();
    const { workers, worker } = hold();
    const thread = startReplyThread(workers, clock);
    const waiting = settle(thread.call({ kind: 'speak', text: 'hi', speaker: 0 } as never));
    await clock.advance(60_001);
    expect((await waiting)?.message).toBe('The reply voice worker did not answer in 60 seconds, so it was stopped.');
    expect(worker.terminated).toBe(1);
  });

  test('an answer in time cancels the deadline: the worker lives on', async () => {
    const clock = fixedClock();
    const { workers, worker } = hold();
    const thread = startSpeechThread(workers, clock);
    const call = thread.call({ kind: 'probe', addon: '/x' } as never);
    worker.answer(worker.posted[0]?.id ?? 0, { kind: 'probe', version: '1' });
    await call;
    await clock.advance(10 * 60_000);
    expect(worker.terminated).toBe(0);
    const second = thread.call({ kind: 'probe', addon: '/x' } as never);
    worker.answer(worker.posted[1]?.id ?? 0, { kind: 'probe', version: '1' });
    await second;
  });
});
