/**
 * THE PARSE THREAD OUTLIVES A QUIET HALF MINUTE, SO THE NEXT READ FINDS ITS CONVERSATION INDEX WARM.
 *
 * The thread holds every session's folded conversation; ending it at 30 s made the first messages read
 * after a pause fold the whole transcript again. These cases drive a stand-in thread under fake timers:
 * it is still the same thread 31 s and nine minutes after the last answer, it ends once the idle time is
 * up, and a read after that starts a new one.
 */
import { afterEach, beforeEach, describe, it, jest } from 'bun:test';
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

describe('TranscriptParseWorker idle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
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
    jest.advanceTimersByTime(31_000);
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
    jest.advanceTimersByTime(PARSE_IDLE_MS - 1);
    const justBefore = threads[0]?.terminated;
    jest.advanceTimersByTime(1);

    // Assert
    should(justBefore).be.false();
    should(threads[0]?.terminated).be.true();
    parse.close();
  });

  it('should start a new thread for a read after the old one ended', async () => {
    // Arrange
    const { parse, threads, read } = subject();
    await read();
    jest.advanceTimersByTime(PARSE_IDLE_MS);

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
    jest.advanceTimersByTime(PARSE_IDLE_MS - 1_000);
    await read();

    // Act
    jest.advanceTimersByTime(PARSE_IDLE_MS - 1_000);

    // Assert
    should(threads).have.length(1);
    should(threads[0]?.terminated).be.false();
    parse.close();
  });
});
