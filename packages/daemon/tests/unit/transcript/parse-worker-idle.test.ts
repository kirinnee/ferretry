/**
 * THE PARSE THREAD OUTLIVES A QUIET HALF MINUTE, SO THE NEXT READ FINDS ITS CONVERSATION INDEX WARM.
 *
 * The thread holds every session's folded conversation; ending it at 30 s made the first messages read
 * after a pause fold the whole transcript again. These cases drive a stand-in thread on a clock it turns by hand:
 * it is still the same thread 31 s and nine minutes after the last answer, it ends once the idle time is
 * up, and a read after that starts a new one.
 */
import { afterEach, beforeEach, describe, it } from 'bun:test';
import should from 'should';
import {
  PARSE_IDLE_MS,
  type TranscriptParseThread,
  TranscriptParseWorker,
} from '../../../src/adapters/transcript/parse-worker/client.ts';
import type {
  TranscriptParseGreeting,
  TranscriptParseRequest,
  TranscriptParseResponse,
} from '../../../src/adapters/transcript/parse-worker/protocol.ts';

type Sent = TranscriptParseRequest | TranscriptParseGreeting;

class AnsweringThread implements TranscriptParseThread {
  onmessage: ((event: MessageEvent<TranscriptParseResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(message: Sent): void {
    if (!('id' in message)) return;
    this.onmessage?.({
      data: { id: message.id, ok: true, value: { kind: 'rows' } },
    } as MessageEvent<TranscriptParseResponse>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** A clock the test turns by hand: the host's timers are set and cleared on it, never on the real one. */
class ManualTimers {
  #now = 0;
  #next = 1;
  readonly #due = new Map<number, { at: number; run: () => void }>();

  set = (run: () => void, ms = 0): number => {
    const id = this.#next++;
    this.#due.set(id, { at: this.#now + ms, run });
    return id;
  };

  clear = (id: number | undefined): void => {
    if (id !== undefined) this.#due.delete(id);
  };

  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      const next = [...this.#due.entries()].filter(([, each]) => each.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      this.#due.delete(next[0]);
      this.#now = next[1].at;
      next[1].run();
    }
    this.#now = until;
  }
}

describe('TranscriptParseWorker idle', () => {
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  let timers: ManualTimers;
  beforeEach(() => {
    timers = new ManualTimers();
    globalThis.setTimeout = timers.set as unknown as typeof setTimeout;
    globalThis.clearTimeout = timers.clear as unknown as typeof clearTimeout;
  });
  afterEach(() => {
    globalThis.setTimeout = real.set;
    globalThis.clearTimeout = real.clear;
  });

  function subject() {
    const threads: AnsweringThread[] = [];
    const parse = new TranscriptParseWorker({
      spawn: () => {
        const thread = new AnsweringThread();
        threads.push(thread);
        return thread;
      },
    });
    const read = async () =>
      await parse.ask({ op: 'rows', target: { sessionId: 's', harness: 'claude' }, file: '/t.jsonl' }, 'fold /t.jsonl');
    return { parse, threads, read };
  }

  it('should answer the next read from the same thread 31 s after the last one', async () => {
    // Arrange
    const { parse, threads, read } = subject();
    await read();

    // Act
    timers.advance(31_000);
    await read();

    // Assert — a thread started for the second read would have folded the transcript again.
    should(threads).have.length(1);
    should(threads[0]?.terminated).be.false();
    parse.close();
  });

  it('should keep the thread until one idle time after the last answer, then end it', async () => {
    // Arrange
    const { parse, threads, read } = subject();
    await read();

    // Act
    timers.advance(PARSE_IDLE_MS - 1);
    const justBefore = threads[0]?.terminated;
    timers.advance(1);

    // Assert
    should(justBefore).be.false();
    should(threads[0]?.terminated).be.true();
    parse.close();
  });

  it('should start a new thread for a read after the old one ended', async () => {
    // Arrange
    const { parse, threads, read } = subject();
    await read();
    timers.advance(PARSE_IDLE_MS);

    // Act
    await read();

    // Assert
    should(threads).have.length(2);
    should(threads[1]?.terminated).be.false();
    parse.close();
  });

  it('should restart the idle time at each answer', async () => {
    // Arrange
    const { parse, threads, read } = subject();
    await read();
    timers.advance(PARSE_IDLE_MS - 1_000);
    await read();

    // Act
    timers.advance(PARSE_IDLE_MS - 1_000);

    // Assert
    should(threads).have.length(1);
    should(threads[0]?.terminated).be.false();
    parse.close();
  });
});
