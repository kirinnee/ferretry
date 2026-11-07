import type { Cancel, WorkerHandle } from '@ferretry/kernel/contract';

/** A real Bun worker thread behind the kernel's workers port, and a timer behind its clock: the ports a real-engine test needs. */
export const realPorts = {
  workers: {
    start: (url: URL): WorkerHandle => {
      const worker = new Worker(url, { type: 'module' });
      return {
        post: (message, transfer) => worker.postMessage(message, transfer as never),
        onMessage: (listener): Cancel => {
          const handler = (event: MessageEvent<unknown>): void => listener(event.data);
          worker.addEventListener('message', handler);
          return () => worker.removeEventListener('message', handler);
        },
        terminate: async () => {
          worker.terminate();
        },
      };
    },
  },
  clock: {
    after: (delay: number, fn: () => void): Cancel => {
      const timer = setTimeout(fn, delay);
      return () => clearTimeout(timer);
    },
  },
} as never;
