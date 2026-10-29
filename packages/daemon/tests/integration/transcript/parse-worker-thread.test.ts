import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { bundledWorkerUrl, probeBundledWorker } from '../../../src/adapters/runtime/bundled-worker.ts';
import {
  joinPages,
  type TranscriptParsePage,
  type TranscriptParseRequest,
  type TranscriptParseResponse,
  WINDOW_LOST,
} from '../../../src/adapters/transcript/parse-worker/protocol.ts';

const directories: string[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) worker.terminate();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const record = (text: string, n: number): string =>
  JSON.stringify({
    type: 'user',
    sessionId: '11111111-1111-4111-8111-111111111111',
    uuid: `u${String(n)}`,
    timestamp: `2026-01-02T03:04:0${String(n)}.000Z`,
    message: { role: 'user', content: text },
  });

/** Starts the real worker program on its own thread, and asks it one question at a time. */
function startWorker() {
  const worker = new Worker(bundledWorkerUrl('transcript-parse'), { type: 'module' });
  workers.push(worker);
  const inbox: TranscriptParseResponse[] = [];
  const waiting: (() => void)[] = [];
  worker.onmessage = (event: MessageEvent<TranscriptParseResponse>) => {
    inbox.push(event.data);
    for (const wake of waiting.splice(0)) wake();
  };
  /** Every message up to and including the answer to `id`: its pages, then the answer. */
  const ask = async (request: TranscriptParseRequest & { readonly id: number }) => {
    worker.postMessage(request);
    for (;;) {
      const answered = inbox.findIndex(message => 'ok' in message && message.id === request.id);
      if (answered >= 0) {
        const messages = inbox.splice(0, answered + 1);
        const pages = messages.flatMap(message => ('page' in message ? [message.page as TranscriptParsePage] : []));
        return { pages, answer: messages.at(-1) as Extract<TranscriptParseResponse, { ok: boolean }> };
      }
      await new Promise<void>(resolve => waiting.push(resolve));
    }
  };
  return { worker, ask, inbox, post: (message: unknown) => worker.postMessage(message) };
}

describe('the transcript parse worker thread', () => {
  it('should start from its bundled name and answer the probe', async () => {
    // Act / Assert
    should(await probeBundledWorker('transcript-parse')).deepEqual({ name: 'transcript-parse', ready: true });
  });

  it('should read a transcript, step a window of it without its raw records, fold its rows and refuse a window it does not hold', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'ferretry-parse-thread-'));
    directories.push(directory);
    const file = join(directory, 'session.jsonl');
    await writeFile(file, `${record('first', 1)}\n${record('second', 2)}\n`);
    const { ask, post } = startWorker();
    post({ op: 'configure', handoffScope: { roots: [], coordinatorHomes: [] } });

    // Act
    const read = await ask({ id: 1, op: 'read', harness: 'claude', file, options: {} });
    const opened = await ask({
      id: 2,
      op: 'window-next',
      window: 1,
      open: { harness: 'claude', file, options: { start: { at: 'beginning' } }, raw: false },
    });
    const lost = await ask({ id: 3, op: 'window-next', window: 99 });
    const rows = await ask({
      id: 4,
      op: 'rows',
      target: { sessionId: '11111111-1111-4111-8111-111111111111', harness: 'claude' },
      file,
    });

    // Assert
    const events = joinPages(read.pages).events;
    should(events.map(each => each.kind)).containEql('message');
    should(read.answer).have.property('ok', true);
    const value = (read.answer as { value: { kind: string; batch: { file: string; raw: boolean } } }).value;
    should(value).containEql({ kind: 'batch' });
    should(value.batch).containEql({ file, raw: true });
    should(value.batch).not.have.property('events');
    should(joinPages(read.pages).rawRecords).have.length(2);
    should(joinPages(opened.pages).events).deepEqual(events);
    should(joinPages(opened.pages).rawRecords).deepEqual([]);
    should((opened.answer as { value: { kind: string; batch: { raw: boolean } } }).value).containEql({ kind: 'step' });
    should((opened.answer as { value: { batch: { raw: boolean } } }).value.batch.raw).be.false();
    should(lost.answer).deepEqual({ id: 3, ok: false, refusal: { message: WINDOW_LOST } });
    should(rows.answer).deepEqual({ id: 4, ok: true, value: { kind: 'rows' } });
    const folded = joinPages(rows.pages).rows;
    should(folded.map(row => row.text)).deepEqual(['first', 'second']);
    // A row's chain value crosses as its own 32 bytes, not as a view of a larger buffer.
    should(folded.map(row => [row.rawPrefix.byteLength, row.rawPrefix.buffer.byteLength])).deepEqual([
      [32, 32],
      [32, 32],
    ]);
  });
});
