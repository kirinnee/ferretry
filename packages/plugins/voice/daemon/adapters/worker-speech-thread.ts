import type { WorkersPort } from '@ferretry/kernel/contract';
import type { SpeechReply, SpeechRequest } from '../lib/engine/protocol.ts';
import type { SpeechThread } from '../lib/engine/ports.ts';

/** The speech worker's program: a module of this package, embedded by name in a compiled `fyd` (manifest `workers`). */
export const SPEECH_WORKER_URL = new URL('../worker/speech.worker.ts', import.meta.url);

const isReply = (value: unknown): value is SpeechReply =>
  typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number';

/** One worker thread behind `call`: replies are matched to requests by id, and a thread that ends fails what waits. */
export function startSpeechThread(workers: Pick<WorkersPort, 'start'>): SpeechThread {
  const handle = workers.start(SPEECH_WORKER_URL, { name: 'speech', env: {} });
  const waiting = new Map<
    number,
    { resolve: (reply: SpeechReply & { ok: true }) => void; reject: (error: Error) => void }
  >();
  const ended: (() => void)[] = [];
  let next = 1;
  let over = false;
  const finish = (reason: string): void => {
    over = true;
    for (const [, pending] of waiting) pending.reject(new Error(reason));
    waiting.clear();
    for (const listener of ended) listener();
  };
  handle.onMessage(message => {
    if (!isReply(message)) return;
    const pending = waiting.get(message.id);
    if (pending === undefined) return;
    waiting.delete(message.id);
    if (message.ok) pending.resolve(message);
    else pending.reject(new Error(message.sentence));
  });
  handle.onExit(() => finish('The speech worker stopped.'));
  return {
    call: (request, transfer = []) =>
      new Promise((resolve, reject) => {
        if (over) {
          reject(new Error('The speech worker stopped.'));
          return;
        }
        const id = next++;
        waiting.set(id, { resolve, reject });
        handle.post({ ...request, id } as SpeechRequest, transfer);
      }),
    terminate: async () => {
      await handle.terminate();
      if (!over) finish('The speech worker was stopped.');
    },
    onEnd: listener => void ended.push(listener),
  };
}
