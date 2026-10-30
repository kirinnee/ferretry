import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  defaultTranscriptParseReaders,
  MAX_HELD_WINDOWS,
  serveTranscriptParse,
  type TranscriptParseReaders,
  type TranscriptParseScope,
} from '../../../src/adapters/transcript/parse-worker/program.ts';
import {
  joinPages,
  type TranscriptParsePage,
  type TranscriptParseResponse,
  WINDOW_LOST,
} from '../../../src/adapters/transcript/parse-worker/protocol.ts';
import type { ConversationDescriber } from '../../../src/lib/imports/conversation-describer.ts';
import { NO_HANDOFF_SCOPE } from '../../../src/lib/imports/conversation-text.ts';
import type { ForeignTranscriptRead } from '../../../src/lib/imports/foreign-history.ts';
import { ConversationDigestError, type PortableConversationRow } from '../../../src/lib/session/transcript/digest.ts';
import { TranscriptImageError, type TranscriptImageReader } from '../../../src/lib/session/transcript/image-reader.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptRawRecord,
  TranscriptWindowStep,
} from '../../../src/lib/transcript/types.ts';
import { waitFor } from '../support/wait-for.ts';

type Message = Parameters<NonNullable<TranscriptParseScope['onmessage']>>[0]['data'];

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A worker scope that records what it posts, and a way to send it a message as the thread would hear it. */
function fakeScope(options: { readonly failOnAnswerOnce?: boolean } = {}) {
  let failing = options.failOnAnswerOnce === true;
  const posted: { readonly message: TranscriptParseResponse; readonly transfer: ArrayBuffer[] | undefined }[] = [];
  const waiters: (() => void)[] = [];
  const scope: TranscriptParseScope = {
    onmessage: null,
    postMessage(message, transfer) {
      if (failing && 'ok' in message && message.ok) {
        failing = false;
        throw new Error('could not be cloned');
      }
      posted.push({ message, transfer });
      for (const wake of waiters.splice(0)) wake();
    },
  };
  return {
    scope,
    posted,
    /** The `index`th message posted. */
    at: (index: number): TranscriptParseResponse => {
      const entry = posted[index];
      if (entry === undefined) throw new Error(`no message ${String(index)} was posted`);
      return entry.message;
    },
    send: (data: Message) => scope.onmessage?.({ data } as MessageEvent<Message>),
    /** Resolves once `count` messages have been posted. */
    settled: async (count: number): Promise<void> => {
      while (posted.length < count) await new Promise<void>(resolve => waiters.push(resolve));
    },
    answers: () => posted.map(entry => entry.message).filter(message => 'ok' in message),
  };
}

const event = (n: number): TranscriptEvent => ({ n }) as unknown as TranscriptEvent;

function batchOf(events: readonly TranscriptEvent[], rawRecords?: readonly TranscriptRawRecord[]): TranscriptBatch {
  return {
    harness: 'claude',
    file: '/t.jsonl',
    reset: false,
    cursor: { offset: 7 },
    events,
    observedInputs: [],
    issues: [],
    ...(rawRecords === undefined ? {} : { rawRecords }),
  } as unknown as TranscriptBatch;
}

const never = (): never => {
  throw new Error('this reader was not expected to be asked');
};

/** Readers that fail every question unless a case supplies the one it asks. */
function readers(overrides: Partial<TranscriptParseReaders> = {}): TranscriptParseReaders {
  const source = { read: never, window: never };
  return {
    sources: { claude: source, codex: source },
    images: { lookupAt: never },
    foreign: { read: never },
    rows: { rows: never },
    describer: never,
    ...overrides,
  };
}

const opening = { harness: 'claude', file: '/t.jsonl', options: { start: { at: 'beginning' } }, raw: true } as const;

describe('serveTranscriptParse', () => {
  it('should answer the probe', () => {
    // Arrange
    const { scope, send, posted } = fakeScope();
    serveTranscriptParse(scope, readers());

    // Act
    send({ probe: true });

    // Assert
    should(posted.map(entry => entry.message)).deepEqual([{ probe: true }]);
  });

  describe('read', () => {
    it('should post the events in pages, then the batch without them', async () => {
      // Arrange
      const events = Array.from({ length: 300 }, (_, n) => event(n));
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          sources: {
            claude: { read: async () => batchOf(events), window: never },
            codex: { read: never, window: never },
          },
        }),
      );

      // Act
      fake.send({ id: 4, op: 'read', harness: 'claude', file: '/t.jsonl', options: {} });
      await fake.settled(3);

      // Assert
      const pages = fake.posted.slice(0, 2).map(entry => (entry.message as { page: TranscriptParsePage }).page);
      should(joinPages(pages).events).deepEqual(events);
      should(fake.posted.slice(0, 2).map(entry => (entry.message as { id: number }).id)).deepEqual([4, 4]);
      const shell = (fake.at(2) as { value: { batch: Record<string, unknown> } }).value.batch;
      should(shell).deepEqual({
        harness: 'claude',
        file: '/t.jsonl',
        reset: false,
        cursor: { offset: 7 },
        observedInputs: [],
        issues: [],
        raw: false,
      });
      should(fake.posted[2]?.message).have.property('ok', true);
    });

    it('should transfer the raw records, and say the batch had them', async () => {
      // Arrange
      const raw = [{ byteOffset: 5, bytes: new TextEncoder().encode('{"a":1}\n') }];
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          sources: {
            claude: { read: never, window: never },
            codex: { read: async () => batchOf([event(1)], raw), window: never },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'read', harness: 'codex', file: '/t.jsonl', options: {} });
      await fake.settled(2);

      // Assert
      const page = (fake.at(0) as { page: TranscriptParsePage }).page;
      should(fake.posted[0]?.transfer).have.length(1);
      should(fake.posted[0]?.transfer?.[0]).equal(page.raw?.buffer);
      should(joinPages([page]).rawRecords).have.length(1);
      should((fake.at(1) as { value: { batch: { raw: boolean } } }).value.batch.raw).be.true();
    });

    it('should send an empty answer as no page at all', async () => {
      // Arrange
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          sources: {
            claude: { read: async () => batchOf([]), window: never },
            codex: { read: never, window: never },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'read', harness: 'claude', file: '/t.jsonl', options: {} });
      await fake.settled(1);

      // Assert
      should(fake.posted).have.length(1);
      should(fake.posted[0]?.message).have.property('ok', true);
    });

    it('should refuse with the message of whatever was thrown', async () => {
      // Arrange
      const fake = fakeScope();
      let thrown: unknown = new Error('disk gone');
      serveTranscriptParse(
        fake.scope,
        readers({
          sources: {
            claude: {
              read: async () => {
                throw thrown;
              },
              window: never,
            },
            codex: { read: never, window: never },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'read', harness: 'claude', file: '/t.jsonl', options: {} });
      await fake.settled(1);
      thrown = 'plain string';
      fake.send({ id: 2, op: 'read', harness: 'claude', file: '/t.jsonl', options: {} });
      await fake.settled(2);

      // Assert
      should(fake.answers()).deepEqual([
        { id: 1, ok: false, refusal: { message: 'disk gone' } },
        { id: 2, ok: false, refusal: { message: 'plain string' } },
      ]);
    });

    it('should refuse an answer that cannot be posted, rather than leave it unanswered', async () => {
      // Arrange
      const fake = fakeScope({ failOnAnswerOnce: true });
      serveTranscriptParse(
        fake.scope,
        readers({
          sources: {
            claude: { read: async () => batchOf([]), window: never },
            codex: { read: never, window: never },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'read', harness: 'claude', file: '/t.jsonl', options: {} });
      await fake.settled(1);

      // Assert
      should(fake.posted[0]?.message).deepEqual({ id: 1, ok: false, refusal: { message: 'could not be cloned' } });
    });

    it('should answer requests concurrently, not one after another', async () => {
      // Arrange
      const fake = fakeScope();
      const release: (() => void)[] = [];
      serveTranscriptParse(
        fake.scope,
        readers({
          sources: {
            claude: {
              read: async () => {
                await new Promise<void>(resolve => release.push(resolve));
                return batchOf([]);
              },
              window: never,
            },
            codex: { read: never, window: never },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'read', harness: 'claude', file: '/a', options: {} });
      fake.send({ id: 2, op: 'read', harness: 'claude', file: '/b', options: {} });
      should(release).have.length(2);
      release[1]?.();
      await fake.settled(1);
      release[0]?.();
      await fake.settled(2);

      // Assert
      should(fake.answers().map(answer => (answer as { id: number }).id)).deepEqual([2, 1]);
    });
  });

  describe('windows', () => {
    /** A window that answers `steps` in order, counting how many times it was asked. */
    function windowOf(steps: readonly (TranscriptWindowStep | Error)[]) {
      const state = { asked: 0 };
      return {
        state,
        window: {
          file: '/t.jsonl',
          next: async (): Promise<TranscriptWindowStep> => {
            const step = steps[state.asked++] ?? { more: false };
            if (step instanceof Error) throw step;
            return step;
          },
        },
      };
    }

    function withWindows(make: () => ReturnType<typeof windowOf>['window'], opened: unknown[] = []) {
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          sources: {
            claude: {
              read: never,
              window: (file, options) => {
                opened.push({ file, options });
                return make();
              },
            },
            codex: { read: never, window: never },
          },
        }),
      );
      return fake;
    }

    it('should open a window on its first step, hold it, and step the same one afterwards', async () => {
      // Arrange
      const held = windowOf([{ batch: batchOf([event(1), event(2)]), more: true }, { more: false }]);
      const opened: unknown[] = [];
      const fake = withWindows(() => held.window, opened);

      // Act
      fake.send({ id: 1, op: 'window-next', window: 9, open: opening });
      await fake.settled(2);
      fake.send({ id: 2, op: 'window-next', window: 9 });
      await fake.settled(3);

      // Assert
      should(opened).deepEqual([{ file: '/t.jsonl', options: opening.options }]);
      should(joinPages([(fake.at(0) as { page: TranscriptParsePage }).page]).events).deepEqual([event(1), event(2)]);
      const first = (fake.at(1) as { value: { kind: string; more: boolean; batch: { raw: boolean } } }).value;
      should(first).containEql({ kind: 'step', more: true });
      should(first.batch.raw).be.false();
      should(fake.posted[2]?.message).deepEqual({ id: 2, ok: true, value: { kind: 'step', more: false } });
      should(held.state.asked).equal(2);
    });

    it("should keep a window's raw records in the thread when it was opened without them", async () => {
      // Arrange
      const raw = [{ byteOffset: 0, bytes: new TextEncoder().encode('{"a":1}\n') }];
      const held = windowOf([
        { batch: batchOf([event(1)], raw), more: true },
        { batch: batchOf([event(2)]), more: true },
      ]);
      const fake = withWindows(() => held.window);

      // Act
      fake.send({ id: 1, op: 'window-next', window: 4, open: { ...opening, raw: false } });
      await fake.settled(2);
      fake.send({ id: 2, op: 'window-next', window: 4 });
      await fake.settled(4);
      fake.send({ id: 3, op: 'window-next', window: 4 });
      await fake.settled(5);

      // Assert — the first step's records stayed here; a step without records or without a batch is as it was.
      const page = (fake.at(0) as { page: TranscriptParsePage }).page;
      should(page).not.have.property('raw');
      should(fake.posted[0]?.transfer).deepEqual([]);
      should(joinPages([page]).events).deepEqual([event(1)]);
      should((fake.at(1) as { value: { batch: { raw: boolean } } }).value.batch.raw).be.false();
      should((fake.at(3) as { value: { batch: { raw: boolean } } }).value.batch.raw).be.false();
      should(fake.posted[4]?.message).deepEqual({ id: 3, ok: true, value: { kind: 'step', more: false } });
    });

    it('should refuse a step for a window it does not hold, without opening one', async () => {
      // Arrange
      const opened: unknown[] = [];
      const fake = withWindows(() => windowOf([]).window, opened);

      // Act
      fake.send({ id: 1, op: 'window-next', window: 3 });
      await fake.settled(1);

      // Assert
      should(fake.posted[0]?.message).deepEqual({ id: 1, ok: false, refusal: { message: WINDOW_LOST } });
      should(opened).deepEqual([]);
    });

    it('should forget a window whose step failed, and refuse the error', async () => {
      // Arrange
      const fake = withWindows(() => windowOf([new Error('file went away')]).window);

      // Act
      fake.send({ id: 1, op: 'window-next', window: 3, open: opening });
      await fake.settled(1);
      fake.send({ id: 2, op: 'window-next', window: 3 });
      await fake.settled(2);

      // Assert
      should(fake.answers()).deepEqual([
        { id: 1, ok: false, refusal: { message: 'file went away' } },
        { id: 2, ok: false, refusal: { message: WINDOW_LOST } },
      ]);
    });

    it('should forget a window it is told is closed, and answer nothing for the close', async () => {
      // Arrange
      const fake = withWindows(() => windowOf([{ more: false }]).window);
      fake.send({ id: 1, op: 'window-next', window: 3, open: opening });
      await fake.settled(1);

      // Act
      fake.send({ op: 'window-close', window: 3 });
      fake.send({ id: 2, op: 'window-next', window: 3 });
      await fake.settled(2);

      // Assert
      should(fake.posted).have.length(2);
      should(fake.posted[1]?.message).deepEqual({ id: 2, ok: false, refusal: { message: WINDOW_LOST } });
    });

    it('should keep a window closed while a step of it is in flight', async () => {
      // Arrange
      let release: () => void = () => undefined;
      const fake = withWindows(() => ({
        file: '/t.jsonl',
        next: async () => {
          await new Promise<void>(resolve => {
            release = resolve;
          });
          return { more: false };
        },
      }));
      fake.send({ id: 1, op: 'window-next', window: 3, open: opening });
      await Promise.resolve();

      // Act
      fake.send({ op: 'window-close', window: 3 });
      release();
      await fake.settled(1);
      fake.send({ id: 2, op: 'window-next', window: 3 });
      await fake.settled(2);

      // Assert
      should(fake.posted[1]?.message).deepEqual({ id: 2, ok: false, refusal: { message: WINDOW_LOST } });
    });

    it('should never run two steps of one window at once, while other windows run beside it', async () => {
      // Arrange
      const log: string[] = [];
      const gates: (() => void)[] = [];
      let n = 0;
      const fake = withWindows(() => {
        const name = `w${String(++n)}`;
        let step = 0;
        return {
          file: '/t.jsonl',
          next: async () => {
            const mine = `${name}.${String(++step)}`;
            log.push(`start ${mine}`);
            await new Promise<void>(resolve => gates.push(resolve));
            log.push(`end ${mine}`);
            return { more: true };
          },
        };
      });

      // Act
      fake.send({ id: 1, op: 'window-next', window: 1, open: opening });
      fake.send({ id: 2, op: 'window-next', window: 1 });
      fake.send({ id: 3, op: 'window-next', window: 2, open: opening });
      await waitFor(() => log.length === 2, "window 2 to start beside window 1's first step");

      // Assert — window 2 started beside window 1's first step; window 1's second step waits for it.
      should(log).deepEqual(['start w1.1', 'start w2.1']);
      gates[0]?.();
      await fake.settled(1);
      await waitFor(() => log.length === 4, "window 1's second step to start once its first ended");
      should(log).deepEqual(['start w1.1', 'start w2.1', 'end w1.1', 'start w1.2']);
      gates[1]?.();
      gates[2]?.();
      await fake.settled(3);
      should(
        fake
          .answers()
          .map(answer => (answer as { id: number }).id)
          .sort(),
      ).deepEqual([1, 2, 3]);
    });

    it('should forget the window stepped least recently when it holds too many, and touch on each step', async () => {
      // Arrange
      const made: number[] = [];
      const fake = withWindows(() => {
        made.push(made.length);
        return { file: '/t.jsonl', next: async () => ({ more: false }) };
      });
      for (let window = 1; window <= MAX_HELD_WINDOWS; window += 1)
        fake.send({ id: window, op: 'window-next', window, open: opening });
      await fake.settled(MAX_HELD_WINDOWS);

      // Act — window 1 is stepped again, so window 2 is now the least recent; one more opens past the cap.
      fake.send({ id: 1001, op: 'window-next', window: 1 });
      await fake.settled(MAX_HELD_WINDOWS + 1);
      fake.send({ id: 1002, op: 'window-next', window: MAX_HELD_WINDOWS + 1, open: opening });
      await fake.settled(MAX_HELD_WINDOWS + 2);
      fake.send({ id: 1003, op: 'window-next', window: 1 });
      fake.send({ id: 1004, op: 'window-next', window: 2 });
      fake.send({ id: 1005, op: 'window-next', window: 3 });
      await fake.settled(MAX_HELD_WINDOWS + 5);

      // Assert
      const outcome = (id: number): boolean =>
        (fake.answers().find(answer => (answer as { id: number }).id === id) as { ok: boolean }).ok;
      should(outcome(1001)).be.true();
      should(outcome(1003)).be.true();
      should(outcome(1004)).be.false();
      should(outcome(1005)).be.true();
      should(made).have.length(MAX_HELD_WINDOWS + 1);
    });
  });

  describe('image', () => {
    const target = { file: '/t.jsonl', harness: 'claude' } as const;
    const image = { handle: 'h', mediaType: 'image/png', byteLength: 3 } as const;

    it('should describe the image, and read its base64 back only when asked to', async () => {
      // Arrange
      const calls: unknown[][] = [];
      let downloads = 0;
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          images: {
            lookupAt: async (...args) => {
              calls.push(args);
              return {
                etag: '"e"',
                image,
                download: async () => {
                  downloads += 1;
                  return { image, base64: 'QUJD' };
                },
              };
            },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'image', sessionId: 's', handle: 'h', target, download: false });
      await fake.settled(1);
      fake.send({ id: 2, op: 'image', sessionId: 's', handle: 'h', target, download: true });
      await fake.settled(2);

      // Assert
      should(fake.posted.map(entry => entry.message)).deepEqual([
        { id: 1, ok: true, value: { kind: 'image', etag: '"e"', image } },
        { id: 2, ok: true, value: { kind: 'image', etag: '"e"', image, base64: 'QUJD' } },
      ]);
      should(downloads).equal(1);
      should(calls[0]).deepEqual(['s', 'h', target]);
    });

    it('should refuse an image failure with its code, so the loop raises it as one again', async () => {
      // Arrange
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          images: {
            lookupAt: async () => {
              throw new TranscriptImageError('image_not_found', 'the session has no image at that handle');
            },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'image', sessionId: 's', handle: 'h', target, download: false });
      await fake.settled(1);

      // Assert
      should(fake.posted[0]?.message).deepEqual({
        id: 1,
        ok: false,
        refusal: { message: 'the session has no image at that handle', imageFailure: 'image_not_found' },
      });
    });
  });

  describe('foreign', () => {
    const candidate = { harness: 'codex', source: '/rollout.jsonl' } as const;

    it('should page the events of a transcript it read, then answer with the row alone', async () => {
      // Arrange
      const conversation = { id: 'c' } as unknown as Extract<
        ForeignTranscriptRead,
        { conversation: unknown }
      >['conversation'];
      const asked: unknown[][] = [];
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          foreign: {
            read: async (...args) => {
              asked.push(args);
              return { conversation, events: [event(1), event(2)] };
            },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'foreign', candidate, withEvents: true });
      await fake.settled(2);

      // Assert
      should(joinPages([(fake.at(0) as { page: TranscriptParsePage }).page]).events).deepEqual([event(1), event(2)]);
      should(fake.posted[1]?.message).deepEqual({ id: 1, ok: true, value: { kind: 'foreign', conversation } });
      should(asked).deepEqual([[candidate, true]]);
    });

    it('should answer why a transcript was skipped, with no page', async () => {
      // Arrange
      const fake = fakeScope();
      serveTranscriptParse(fake.scope, readers({ foreign: { read: async () => ({ reason: 'too large' }) } }));

      // Act
      fake.send({ id: 1, op: 'foreign', candidate, withEvents: false });
      await fake.settled(1);

      // Assert
      should(fake.posted.map(entry => entry.message)).deepEqual([
        { id: 1, ok: true, value: { kind: 'foreign-skipped', reason: 'too large' } },
      ]);
    });
  });

  describe('rows', () => {
    const target = { sessionId: 's1', harness: 'claude' } as const;
    const row = (n: number): PortableConversationRow =>
      ({ text: `row ${String(n)}`, rawPrefix: Uint8Array.of(n) }) as unknown as PortableConversationRow;

    it('should post the rows the index folded in pages, then the answer', async () => {
      // Arrange
      const rows = Array.from({ length: 300 }, (_, n) => row(n));
      const asked: unknown[] = [];
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          rows: {
            rows: async (...args) => {
              asked.push(args);
              return rows;
            },
          },
        }),
      );

      // Act
      fake.send({ id: 7, op: 'rows', target, file: '/t.jsonl' });
      await fake.settled(3);

      // Assert
      should(asked).deepEqual([[target, '/t.jsonl']]);
      const pages = fake.posted.slice(0, 2).map(entry => (entry.message as { page: TranscriptParsePage }).page);
      should(pages.map(page => page.rows?.length)).deepEqual([256, 44]);
      should(joinPages(pages).rows).deepEqual(rows);
      should(fake.posted[2]?.message).deepEqual({ id: 7, ok: true, value: { kind: 'rows' } });
    });

    it('should say no source speaks the harness when the index answers nothing, and post no page', async () => {
      // Arrange
      const fake = fakeScope();
      serveTranscriptParse(fake.scope, readers({ rows: { rows: async () => undefined } }));

      // Act
      fake.send({ id: 1, op: 'rows', target, file: '/t.jsonl' });
      await fake.settled(1);

      // Assert
      should(fake.posted.map(entry => entry.message)).deepEqual([
        { id: 1, ok: true, value: { kind: 'rows', unspoken: true } },
      ]);
    });

    it('should refuse a fold that could not honestly yield rows with its digest failure', async () => {
      // Arrange
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          rows: {
            rows: async () => {
              throw new ConversationDigestError('incomplete_transcript', 'transcript for s1 is not available');
            },
          },
        }),
      );

      // Act
      fake.send({ id: 1, op: 'rows', target, file: '/t.jsonl' });
      await fake.settled(1);

      // Assert
      should(fake.posted[0]?.message).deepEqual({
        id: 1,
        ok: false,
        refusal: { message: 'transcript for s1 is not available', digestFailure: 'incomplete_transcript' },
      });
    });
  });

  describe('describe and preview', () => {
    const candidate = { harness: 'claude', source: '/home', relativePath: 'a.jsonl' } as never;

    it('should build its describer when first asked, with no hand-off scope until greeted', async () => {
      // Arrange
      const scopes: unknown[] = [];
      const fake = fakeScope();
      const describer: ConversationDescriber = {
        describe: async () => ({ id: 'd' }) as never,
        preview: async () => undefined,
      };
      serveTranscriptParse(
        fake.scope,
        readers({
          describer: handoffScope => {
            scopes.push(handoffScope);
            return describer;
          },
        }),
      );
      should(scopes).deepEqual([]);

      // Act
      fake.send({ id: 1, op: 'describe', candidate });
      await fake.settled(1);
      fake.send({ id: 2, op: 'preview', candidate });
      await fake.settled(2);

      // Assert
      should(scopes).deepEqual([NO_HANDOFF_SCOPE]);
      should(fake.posted.map(entry => entry.message)).deepEqual([
        { id: 1, ok: true, value: { kind: 'described', described: { id: 'd' } } },
        { id: 2, ok: true, value: { kind: 'preview', preview: undefined } },
      ]);
    });

    it('should rebuild its describer over the scope a greeting brings', async () => {
      // Arrange
      const scopes: unknown[] = [];
      const fake = fakeScope();
      serveTranscriptParse(
        fake.scope,
        readers({
          describer: handoffScope => {
            scopes.push(handoffScope);
            return { describe: async () => undefined, preview: async () => undefined };
          },
        }),
      );
      const greeted = { roots: ['/shared'], coordinatorHomes: ['/home/c'] };

      // Act
      fake.send({ id: 1, op: 'describe', candidate });
      await fake.settled(1);
      fake.send({ op: 'configure', handoffScope: greeted });
      fake.send({ id: 2, op: 'describe', candidate });
      await fake.settled(2);

      // Assert
      should(scopes).deepEqual([NO_HANDOFF_SCOPE, greeted]);
    });
  });
});

describe('defaultTranscriptParseReaders', () => {
  it('should hold an image reader that is never asked to find a transcript, only to prove the one it is sent', async () => {
    // Arrange
    const images = defaultTranscriptParseReaders().images as TranscriptImageReader;

    // Act
    const refused = await images.lookup('s', '0.5.0').catch((error: unknown) => error);

    // Assert
    should(refused).have.property('failure', 'no_transcript');
  });

  it('should read, list and refuse over the real files, as the loop would', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'ferretry-parse-program-'));
    directories.push(directory);
    const file = join(directory, 'session.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({
        type: 'user',
        sessionId: '11111111-1111-4111-8111-111111111111',
        uuid: 'u1',
        timestamp: '2026-01-02T03:04:05.000Z',
        message: { role: 'user', content: 'hello there' },
      })}\n`,
    );
    const fake = fakeScope();
    serveTranscriptParse(fake.scope, defaultTranscriptParseReaders());

    // Act
    fake.send({ id: 1, op: 'read', harness: 'claude', file, options: {} });
    await fake.settled(2);
    fake.send({
      id: 2,
      op: 'image',
      sessionId: 's',
      handle: 'not-a-handle',
      target: { file, harness: 'claude' },
      download: false,
    });
    await fake.settled(3);
    fake.send({
      id: 3,
      op: 'describe',
      candidate: { harness: 'claude', source: directory, relativePath: 'missing.jsonl' } as never,
    });
    await fake.settled(4);
    fake.send({
      id: 4,
      op: 'rows',
      target: { sessionId: '11111111-1111-4111-8111-111111111111', harness: 'claude' },
      file,
    });
    await fake.settled(6);

    // Assert
    const page = (fake.at(0) as { page: TranscriptParsePage }).page;
    should(page.events.length).be.above(0);
    should(fake.posted[2]?.message).have.property('refusal');
    should((fake.at(2) as { refusal: { imageFailure: string } }).refusal.imageFailure).equal('invalid_image_handle');
    should(fake.posted[3]?.message).have.property('ok', true);
    should(joinPages([(fake.at(4) as { page: TranscriptParsePage }).page]).rows.map(row => row.text)).deepEqual([
      'hello there',
    ]);
    should(fake.posted[5]?.message).deepEqual({ id: 4, ok: true, value: { kind: 'rows' } });
  });
});
