/**
 * THE PROXIES AGAINST THE REAL WORKER ANSWER EXACTLY WHAT THE INLINE READER ANSWERS.
 *
 * `client.test.ts` scripts the thread; this starts the bundled worker (`bin/transcript-parse.worker.ts`)
 * through the default spawn and compares each answer with `NodeTranscriptSource` over the same file: a
 * bounded read with its raw records, and a window stepped to the end of the file — without them, the
 * one difference a window on the worker is meant to have.
 *
 * And the conversation index: the rows the worker's `ConversationIndex` folds are compared, byte for
 * byte of every row's raw-prefix chain, with the rows an inline `ConversationIndex` folds from the same
 * file — first, after a record is appended (the worker extends its fold), and after the file is replaced
 * (it folds again). A row's chain is the evidence a message token and a fork bind to, so "the same
 * code over the same bytes" is checked here rather than assumed.
 */
import { afterAll, describe, it } from 'bun:test';
import { appendFile, copyFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import {
  TranscriptParseWorker,
  WorkerConversationIndex,
  WorkerTranscriptSource,
} from '../../../../src/adapters/transcript/parse-worker/client.ts';
import {
  LOOP_PARSE_PACING,
  NodeTranscriptFileRuntime,
  NodeTranscriptSource,
} from '../../../../src/adapters/transcript/file-source.ts';
import { ConversationIndex } from '../../../../src/lib/session/transcript/conversation-index.ts';
import type { PortableConversationRow } from '../../../../src/lib/session/transcript/digest.ts';
import type { TranscriptRowsIndex } from '../../../../src/lib/session/transcript/reader.ts';
import { ClaudeTranscriptParser } from '../../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../../src/lib/transcript/codex.ts';
import type { TranscriptBatch, TranscriptHarness } from '../../../../src/lib/transcript/types.ts';
import { cleanupTempDirectories, tempDirectory } from '../../support/repository.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures/transcript');
const worker = new TranscriptParseWorker();

afterAll(async () => {
  worker.close();
  await cleanupTempDirectories();
});

/** A batch as plain data: raw record views compared by their bytes, and the wall-clock instants left out. */
const plain = (batch: TranscriptBatch | undefined) =>
  batch === undefined
    ? undefined
    : {
        ...batch,
        observedInputs: batch.observedInputs.map(({ observedAt: _observedAt, ...each }) => each),
        ...(batch.rawRecords === undefined
          ? {}
          : { rawRecords: batch.rawRecords.map(each => ({ byteOffset: each.byteOffset, bytes: [...each.bytes] })) }),
      };

describe('WorkerTranscriptSource with the real worker', () => {
  for (const [fixture, harness] of [
    ['claude.jsonl', 'claude'],
    ['codex.jsonl', 'codex'],
  ] as const) {
    const inline = () =>
      new NodeTranscriptSource(harness === 'claude' ? new ClaudeTranscriptParser() : new CodexTranscriptParser());

    it(`should read ${fixture} on the worker exactly as the inline source reads it`, async () => {
      // Arrange
      const file = join(FIXTURES, fixture);
      const proxy = new WorkerTranscriptSource(harness, worker, inline());

      // Act
      const onWorker = await proxy.read(file, { sessionId: 's1' });

      // Assert
      should(plain(onWorker)).deepEqual(plain(await inline().read(file, { sessionId: 's1' })));
    });

    it(`should step a window over ${fixture} as the inline window steps`, async () => {
      // Arrange
      const file = join(FIXTURES, fixture);
      const proxy = new WorkerTranscriptSource(harness, worker, inline()).window(file, {
        sessionId: 's1',
        start: { at: 'beginning' },
      });
      const here = inline().window(file, { sessionId: 's1', start: { at: 'beginning' } });

      // Act
      const onWorker = await proxy.next();
      const onLoop = await here.next();

      // Assert — the same step, but its raw records stayed in the worker.
      should(onLoop.batch?.rawRecords?.length).be.above(0);
      should(onWorker.batch).not.have.property('rawRecords');
      const { rawRecords: _rawRecords, ...withoutRaw } = plain(onLoop.batch) ?? {};
      should({ more: onWorker.more, batch: plain(onWorker.batch) }).deepEqual({
        more: onLoop.more,
        batch: withoutRaw,
      });
    });
  }
});

const SESSION = '11111111-1111-4111-8111-111111111111';

/** Rows as plain data: each chain value compared by its bytes, whatever array carries them. */
const plainRows = (rows: readonly PortableConversationRow[] | undefined) =>
  rows?.map(row => ({ ...row, rawPrefix: [...row.rawPrefix] }));

/** One more message record of `harness`'s own format. */
const appended = (harness: TranscriptHarness, n: number): string =>
  `${JSON.stringify(
    harness === 'claude'
      ? {
          type: 'user',
          sessionId: SESSION,
          uuid: `appended-${String(n)}`,
          parentUuid: null,
          timestamp: '2026-01-02T03:05:00.000Z',
          message: { role: 'user', content: `Appended message ${String(n)}.` },
        }
      : {
          timestamp: '2026-01-02T03:05:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            id: `appended-${String(n)}`,
            role: 'user',
            content: [{ type: 'input_text', text: `Appended message ${String(n)}.` }],
          },
        },
  )}\n`;

describe('WorkerConversationIndex with the real worker', () => {
  for (const [fixture, harness] of [
    ['claude.jsonl', 'claude'],
    ['codex.jsonl', 'codex'],
  ] as const) {
    it(`should fold ${fixture} on the worker into exactly the rows an inline index folds, appended to and replaced`, async () => {
      // Arrange — the session's file, a worker index and an inline one over the same bytes.
      const directory = await tempDirectory('ferretry-worker-index-');
      const file = join(directory, fixture);
      await copyFile(join(FIXTURES, fixture), file);
      const sources = [
        new NodeTranscriptSource(new ClaudeTranscriptParser()),
        new NodeTranscriptSource(new CodexTranscriptParser()),
      ];
      const inline = (): TranscriptRowsIndex =>
        new ConversationIndex(sources, new NodeTranscriptFileRuntime(), LOOP_PARSE_PACING);
      const onWorker = new WorkerConversationIndex(worker, inline());
      const here = inline();
      const target = { sessionId: SESSION, harness };
      const both = async () => {
        const rows = await onWorker.rows(target, file);
        return { worker: plainRows(rows), inline: plainRows(await here.rows(target, file)), count: rows?.length };
      };

      // Act
      const first = await both();
      await appendFile(file, appended(harness, 1));
      const extended = await both();
      // Replaced, not rewritten: a new file renamed over the old one is a new identity.
      const replacement = join(directory, 'replacement.jsonl');
      await writeFile(replacement, appended(harness, 2) + appended(harness, 3));
      await rename(replacement, file);
      const refolded = await both();

      // Assert
      should(worker.available).be.true();
      should(first.count).be.above(0);
      should(first.worker).deepEqual(first.inline);
      should(extended.count).equal((first.count ?? 0) + 1);
      should(extended.worker).deepEqual(extended.inline);
      should(refolded.count).equal(2);
      should(refolded.worker).deepEqual(refolded.inline);
    });
  }

  it('should fold a conversation of more rows than one page, every page in order', async () => {
    // Arrange — six hundred messages: three pages of rows.
    const directory = await tempDirectory('ferretry-worker-index-pages-');
    const file = join(directory, 'long.jsonl');
    await writeFile(file, Array.from({ length: 600 }, (_, n) => appended('claude', n)).join(''));
    const sources = [new NodeTranscriptSource(new ClaudeTranscriptParser())];
    const here = new ConversationIndex(sources, new NodeTranscriptFileRuntime(), LOOP_PARSE_PACING);
    const onWorker = new WorkerConversationIndex(worker, here);
    const target = { sessionId: SESSION, harness: 'claude' } as const;

    // Act
    const rows = await onWorker.rows(target, file);

    // Assert
    should(rows).have.length(600);
    should(plainRows(rows)).deepEqual(plainRows(await here.rows(target, file)));
  });
});
