/**
 * A Durian reader for the suites that draw a message in a DOM with no browser: the same reader the page uses
 * (`durian-reader.ts`), over a fake worker that answers in this process, through the worker's own `answer`. The message is
 * read by the real parser and crosses the same wire (`durian-wire.ts`) as a structured clone, so what a suite draws is what the
 * page draws; only the thread is not a thread.
 */
import type { ReactElement, ReactNode } from 'react';
import { answer } from '../../app/hypermedia/durian-answer.ts';
import { createDurianReader, type DurianReader, type WorkerLike } from '../../app/hypermedia/durian-reader.ts';
import { isReadRequest } from '../../app/hypermedia/durian-wire.ts';
import { DurianReaderContext } from '../../app/hypermedia/use-durian-reading.ts';
import type { readMessage } from '../../app/hypermedia/parse-message.ts';

/** A worker that is `ready` as soon as it is listened to, and answers each ask on the next microtask. */
function inProcessWorker(read?: typeof readMessage): WorkerLike & { terminated: boolean } {
  let listener: WorkerLike['onmessage'] = null;
  const deliver = (data: unknown): void => queueMicrotask(() => listener?.(new MessageEvent('message', { data })));
  const worker = {
    terminated: false,
    get onmessage() {
      return listener;
    },
    set onmessage(next: WorkerLike['onmessage']) {
      const first = listener === null && next !== null;
      listener = next;
      if (first) deliver({ kind: 'ready' });
    },
    onerror: null as WorkerLike['onerror'],
    onmessageerror: null as WorkerLike['onmessageerror'],
    postMessage(message: unknown): void {
      // What crosses is a structured clone, as it does to a real worker.
      const request = structuredClone(message);
      if (isReadRequest(request)) deliver(structuredClone(answer(request, read)));
    },
    terminate(): void {
      worker.terminated = true;
    },
  };
  return worker;
}

/** A reader whose every worker is {@link inProcessWorker}. */
export const inProcessReader = (read?: typeof readMessage): DurianReader =>
  createDurianReader({ spawn: () => Promise.resolve(inProcessWorker(read)) });

/** `node` with every message in it read through an in-process reader. */
export const withDurianReader = (node: ReactNode, reader: DurianReader = inProcessReader()): ReactElement => (
  <DurianReaderContext.Provider value={reader}>{node}</DurianReaderContext.Provider>
);
