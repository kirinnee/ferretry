import type { WorkerHandle } from '@ferretry/kernel/contract';

/**
 * Worker threads as `kernel.workers.start` makes them (the host's `bunWorkers`), for the scripted fake worker, with
 * what a test needs to watch them: how many started, which were terminated, and a way to make one die mid-request
 * the way a crashed worker would (it says `exit` and is gone).
 */
export interface ThreadWorkers {
  readonly start: () => WorkerHandle;
  started(): number;
  terminated(index: number): boolean;
  crash(index: number, code?: number): void;
}

export function threadWorkers(moduleUrl: URL): ThreadWorkers {
  const threads: { worker: Worker; terminated: boolean; listeners: Set<(message: unknown) => void> }[] = [];
  return {
    start: () => {
      const worker = new Worker(moduleUrl);
      const thread = { worker, terminated: false, listeners: new Set<(message: unknown) => void>() };
      threads.push(thread);
      return {
        post: (message, transfer) => worker.postMessage(message, [...(transfer ?? [])]),
        onMessage: listener => {
          const handler = (event: MessageEvent): void => listener(event.data);
          worker.addEventListener('message', handler);
          thread.listeners.add(listener);
          return () => {
            worker.removeEventListener('message', handler);
            thread.listeners.delete(listener);
          };
        },
        terminate: async () => {
          thread.terminated = true;
          worker.terminate();
        },
      };
    },
    started: () => threads.length,
    terminated: index => threads[index]?.terminated === true,
    crash: (index, code = 137) => {
      const thread = threads[index];
      if (thread === undefined) throw new Error(`no worker ${String(index)} was started`);
      thread.worker.terminate();
      for (const listener of thread.listeners) listener({ type: 'exit', code });
    },
  };
}
