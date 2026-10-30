/**
 * Whether a transcript window whose proxy is collected is released by the REAL `FinalizationRegistry`:
 * prints the `window-close` messages the scripted thread was sent, as JSON
 * (`tests/integration/transcript/parse-worker/client.test.ts`).
 *
 * In a process of its own because it calls `Bun.gc(true)`, which is synchronous on the calling thread:
 * on 2026-10-29 that call, made in the shared `bun test` process just after the files before it had
 * terminated their real workers, wedged the daemon integration group where no per-test timeout can fire
 * (its timer runs on the very thread that is stuck). Out here, a wedge is a child the test kills.
 */
import {
  type TranscriptParseThread,
  TranscriptParseWorker,
  WorkerTranscriptSource,
} from '../../../src/adapters/transcript/parse-worker/client.ts';
import type {
  TranscriptParseGreeting,
  TranscriptParseRequest,
  TranscriptParseResponse,
} from '../../../src/adapters/transcript/parse-worker/protocol.ts';
import type { TranscriptSource } from '../../../src/lib/transcript/types.ts';
import { waitFor } from './wait-for.ts';

type Sent = TranscriptParseRequest | TranscriptParseGreeting;

/** A thread that opens every window it is asked for and answers its one step with no more to come. */
class OneStepThread implements TranscriptParseThread {
  onmessage: ((event: MessageEvent<TranscriptParseResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: Sent[] = [];

  postMessage(message: Sent): void {
    this.sent.push(message);
    if (!('id' in message) || message.op !== 'window-next') return;
    queueMicrotask(() =>
      this.onmessage?.({
        data: { id: message.id, ok: true, value: { kind: 'step', more: false } },
      } as MessageEvent<TranscriptParseResponse>),
    );
  }

  terminate(): void {}
}

const threads: OneStepThread[] = [];
const parse = new TranscriptParseWorker({
  spawn: () => {
    const thread = new OneStepThread();
    threads.push(thread);
    return thread;
  },
});
const inline = { harness: 'claude' } as TranscriptSource;
const source = new WorkerTranscriptSource('claude', parse, inline);
const closes = () => threads[0]?.sent.filter(each => 'op' in each && each.op === 'window-close') ?? [];

// The proxy is reachable only inside this scope, so once it returns nothing holds it.
await (async () => {
  await source.window('/t.jsonl', { start: { at: 'beginning' } }).next();
})();
await waitFor(() => {
  Bun.gc(true);
  return closes().length > 0;
}, 'the finalization registry to release the collected window');
parse.close();
process.stdout.write(JSON.stringify(closes()));
process.exit(0);
